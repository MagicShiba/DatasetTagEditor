// llm.js - LLM API 调用（兼容 OpenAI API 格式，流式）
// 支持多配置（API URL / Key / 模型 / 自定义参数）、自定义 LLM 功能、图片压缩

import { getSetting } from "./config.js";
import { readBinaryFile } from "./api.js";
import { getExtension } from "./utils.js";

// 获取当前激活的 LLM 配置
export function getActiveLlmConfig() {
    const configs = getSetting("llm_configs") || [];
    const active = getSetting("llm_active_config");
    return configs.find(c => c.name === active) || configs[0] || null;
}

// 获取指定名称的 LLM 配置
export function getLlmConfigByName(name) {
    const configs = getSetting("llm_configs") || [];
    return configs.find(c => c.name === name) || null;
}

// 解析使用的配置：指定名称时优先使用该配置，找不到或为空时回退到激活配置
export function resolveLlmConfig(name) {
    if (name) {
        const found = getLlmConfigByName(name);
        if (found) return found;
    }
    return getActiveLlmConfig();
}

// 规范化 API 地址为 base url：去掉末尾斜杠，并移除可能已填写的 /chat/completions
function normalizeBaseUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

// 将用户填写的 API 地址规范为 chat/completions 端点：
// 支持直接填写 base url（如 http://127.0.0.1:1234/v1），自动补全 /chat/completions；
// 若已包含 /chat/completions 则不会重复补充。
export function toChatCompletionsUrl(url) {
    const base = normalizeBaseUrl(url);
    return base ? `${base}/chat/completions` : "";
}

// 由 API 地址推导模型列表端点（GET {base}/models）
export function toModelsUrl(url) {
    const base = normalizeBaseUrl(url);
    return base ? `${base}/models` : "";
}

// 查询服务端可用模型列表，返回模型 ID 数组
export async function fetchModelIds(config) {
    if (!config || !config.api_url) throw new Error("API URL 未配置");
    const headers = {};
    if (config.api_key) headers["Authorization"] = `Bearer ${config.api_key}`;
    const response = await fetch(toModelsUrl(config.api_url), { method: "GET", headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // 兼容 OpenAI（data 数组）、部分服务直接返回数组或 models 字段的格式
    const list = Array.isArray(data) ? data
        : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models : [];
    const ids = list
        .map(item => typeof item === "string" ? item : (item?.id || item?.name || item?.model || ""))
        .filter(Boolean);
    return [...new Set(ids)];
}

// 流式请求 OpenAI 兼容 API，chunk 回调返回累积文本
// config: { api_url, api_key, model, temperature, max_tokens }
// onReasoning(text) 返回累积的思考过程；onStats({ usage, durationMs }) 在结束后回调
async function streamChat(config, payload, onChunk, onReasoning, onStats) {
    const headers = { "Content-Type": "application/json" };
    if (config.api_key) {
        headers["Authorization"] = `Bearer ${config.api_key}`;
    }
    const startTime = performance.now();
    const response = await fetch(toChatCompletionsUrl(config.api_url), {
        method: "POST",
        headers,
        // 请求流式响应时携带用量统计（不支持的服务器会忽略该字段）
        body: JSON.stringify({
            ...payload,
            stream: true,
            stream_options: { include_usage: true, ...(payload.stream_options || {}) },
        }),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remain = "";
    let result = "";
    let reasoning = "";
    let usage = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        remain += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = remain.indexOf("\n")) !== -1) {
            const line = remain.slice(0, idx);
            remain = remain.slice(idx + 1);
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]" || !payload) continue;
            try {
                const data = JSON.parse(payload);
                const delta = data.choices?.[0]?.delta;
                // 不同服务商的思考过程字段名不同，按常见字段依次兼容
                const reasoningDelta = delta?.reasoning_content || delta?.reasoning || delta?.thinking;
                if (reasoningDelta) {
                    reasoning += reasoningDelta;
                    onReasoning?.(reasoning);
                }
                if (delta?.content) {
                    result += delta.content;
                    onChunk?.(result);
                }
                if (data.usage) usage = data.usage;
            } catch (e) { /* 忽略解析失败的数据行 */ }
        }
    }
    onStats?.({ usage, durationMs: performance.now() - startTime });
    return result;
}

// 执行自定义 LLM 功能
// fn: { name, system_prompt, user_prompt, send_image, send_caption }
// input: { imageDataUrl?, captionText? }
// onChunk: (accumulatedText) => void
// onReasoning: (accumulatedReasoning) => void
// onStats: ({ usage, durationMs }) => void
export async function runLlmFunction(fn, input, onChunk, onReasoning, onStats) {
    const config = resolveLlmConfig(fn.config);
    if (!config) throw new Error("未配置 LLM，请先在设置中配置模型");
    if (!config.api_url) throw new Error("LLM API URL 未配置");

    // 组装 user 消息内容（按需包含用户提示、编辑框文本与图片）
    const content = [];
    if (input.imageDataUrl) {
        content.push({ type: "image_url", image_url: { url: input.imageDataUrl } });
    }
    const texts = [];
    if (fn.user_prompt) texts.push(fn.user_prompt);
    if (input.captionText) texts.push(input.captionText);
    if (texts.length > 0) {
        content.push({ type: "text", text: texts.join("\n") });
    }
    if (content.length === 0) {
        content.push({ type: "text", text: fn.user_prompt || "" });
    }

    const payload = {
        model: config.model,
        messages: [
            { role: "system", content: fn.system_prompt || "" },
            { role: "user", content },
        ],
        ...parseExtraParams(config.extra_params),
    };
    return await streamChat(config, payload, onChunk, onReasoning, onStats);
}

// 反推标注：将图片发送给 LLM，返回逗号分隔的标签文本
// 使用设置中独立的反推提示词（llm_reverse_prompt），与「LLM 功能」区分开
// 加载数据集时对不存在文本文件的图像自动调用
export async function reverseCaption(imagePath) {
    const config = resolveLlmConfig(getSetting("llm_reverse_config"));
    if (!config) throw new Error("未配置 LLM，请先在设置中配置模型");
    if (!config.api_url) throw new Error("LLM API URL 未配置");

    const maxRes = config.max_image_resolution || 0;
    const imageDataUrl = await prepareImage(imagePath, maxRes);
    if (!imageDataUrl) throw new Error("图片加载失败");

    const prompt = getSetting("llm_reverse_prompt") || "";
    const payload = {
        model: config.model,
        messages: [
            { role: "system", content: prompt },
            { role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl } }] },
        ],
        ...parseExtraParams(config.extra_params),
    };
    return await streamChat(config, payload);
}

// 翻译文本：将选中文本发送给 LLM，返回译文（流式）
// 使用设置中独立的翻译提示词（llm_translate_prompt），与「LLM 功能」区分开
export async function translateText(text, onChunk) {
    const config = resolveLlmConfig(getSetting("llm_translate_config"));
    if (!config) throw new Error("未配置 LLM，请先在设置中配置模型");
    if (!config.api_url) throw new Error("LLM API URL 未配置");

    const prompt = getSetting("llm_translate_prompt") || "";
    const payload = {
        model: config.model,
        messages: [
            { role: "system", content: prompt },
            { role: "user", content: text },
        ],
        ...parseExtraParams(config.extra_params),
    };
    return await streamChat(config, payload, onChunk);
}

// 解析自定义请求参数字符串（每行一个 "key: value"），也支持 JSON
export function parseExtraParams(str) {
    const result = {};
    if (!str) return result;
    const s = String(str).trim();
    if (!s) return result;
    // 尝试 JSON 格式
    try {
        return JSON.parse(s);
    } catch (e) { /* 忽略，走 key: value 解析 */ }
    // 每行一个 key: value；按行拆分而非逗号，避免值中的英文逗号被误当分隔符截断
    // （如 reasoning-budget-message: "Okay, time to answer." 中的逗号）
    const lines = s.split(/\r?\n/);
    for (const line of lines) {
        const m = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const key = m[1].trim();
        if (!key) continue;
        let val = m[2].trim();
        // 去掉成对包裹值的外层引号（如 "Okay, time to answer." -> Okay, time to answer.）
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (/^-?\d+(\.\d+)?$/.test(val)) val = parseFloat(val);
        else if (val === "true") val = true;
        else if (val === "false") val = false;
        result[key] = val;
    }
    return result;
}

// 读取图片并压缩到配置的最大分辨率（保持宽高比），返回 data URL
// imagePath: 图片绝对路径；maxResolution: 长边上限，0 表示不压缩
export async function prepareImage(imagePath, maxResolution = 0) {
    const buffer = await readBinaryFile(imagePath);
    if (!buffer) return null;

    const ext = getExtension(imagePath).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif" }[ext] || "image/png";
    const dataUrl = `data:${mime};base64,${bufferToBase64(buffer)}`;

    // 无需压缩或未启用压缩时直接返回
    if (!maxResolution || maxResolution <= 0) return dataUrl;

    const img = await loadImage(dataUrl);
    let { width, height } = img;
    const longSide = Math.max(width, height);
    if (longSide <= maxResolution) return dataUrl;

    // 保持宽高比等比缩放
    const scale = maxResolution / longSide;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    // 统一输出为 JPEG 以减小体积
    return canvas.toDataURL("image/jpeg", 0.9);
}

// 加载图片（返回 Image 对象）
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("图片加载失败"));
        img.src = src;
    });
}

function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

// 测试 LLM 连接是否可用
export async function testLLM(config) {
    const cfg = config || getActiveLlmConfig();
    if (!cfg || !cfg.api_url) return false;
    try {
        const headers = { "Content-Type": "application/json" };
        if (cfg.api_key) headers["Authorization"] = `Bearer ${cfg.api_key}`;
        const response = await fetch(toChatCompletionsUrl(cfg.api_url), {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: cfg.model,
                messages: [{ role: "user", content: "ping" }],
                max_tokens: 1,
            }),
        });
        return response.ok;
    } catch (e) {
        return false;
    }
}

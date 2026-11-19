// llmHistory.js - LLM 调用历史的记录与持久化
// 历史保存到应用目录下的 cache/llm_history.json（新的记录在前），属于临时数据。
// 注意：图片只记录传递的图像地址字符串，不保存 base64 或图像文件。

import * as api from "./api.js";
import { normalizePath } from "./utils.js";

// 历史文件路径（cache 目录，与应用缓存一起管理）
const HISTORY_DIR = normalizePath(`${NL_PATH}/cache`);
const HISTORY_PATH = normalizePath(`${HISTORY_DIR}/llm_history.json`);
// 最多保留的记录条数，超出时丢弃最旧的记录
const MAX_ENTRIES = 300;

// 内存中的历史记录（新的在前）
let entries = [];
// 加载中的 Promise，避免并发重复读取
let loading = null;
// 保存防抖定时器
let saveTimer = null;

// 从文件加载历史（首次加载时读取，之后直接返回内存数据）
export function loadHistory() {
    if (!loading) {
        loading = (async () => {
            entries = [];
            const text = await api.readTextFile(HISTORY_PATH);
            try {
                const json = text ? JSON.parse(text) : null;
                if (Array.isArray(json)) {
                    entries = json.filter(e => e && typeof e === "object");
                }
            } catch (e) {
                console.warn("读取 LLM 历史失败", e);
            }
            return entries;
        })();
    }
    return loading;
}

// 新增一条调用记录并加入保存队列
// entry: { type, name, config, model, messages, reasoning, answer, usage, durationMs, error }
export async function addHistoryEntry(entry) {
    await loadHistory();
    entries.unshift({
        time: new Date().toISOString(),
        type: "function",
        name: "",
        config: "",
        model: "",
        messages: [],
        reasoning: "",
        answer: "",
        usage: null,
        durationMs: 0,
        error: "",
        ...entry,
    });
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    scheduleSave();
}

// 保存到文件（防抖，避免流式调用结束后频繁写盘）
function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        await api.createDirectory(HISTORY_DIR);
        await api.writeTextFile(HISTORY_PATH, JSON.stringify(entries, null, 2));
    }, 300);
}

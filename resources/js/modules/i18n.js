// i18n.js - 中英文翻译（语言包从 {NL_PATH}/resources/locales/ 目录下的标准 TOML 文件动态加载）
// 说明：语言包文件放在应用目录的 resources/locales 子文件夹内（zh.toml / en.toml），便于用户直接编辑。
//       语言包使用标准 TOML 格式（[分区] + 键值对），解析后展开为 "分区.键" 的扁平键；
//       若某个键在语言包中缺失，则回退为键本身。

import { parse } from "../vendor/smol-toml.mjs";
import { normalizePath } from "./utils.js";

let _lang = "zh";

// 语言包缓存 { lang: { key: value } }
const packs = {};

// 语言包目录（应用目录下的 resources/locales 子文件夹，与构建时 copyItems 输出路径一致）
function localesDir() {
    return normalizePath(`${NL_PATH}/resources/locales`);
}

// 将 TOML 解析出的嵌套对象展开为 "分区.键" 的扁平对象
function flatten(obj, prefix = "") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) {
            Object.assign(out, flatten(v, key));
        } else {
            out[key] = v;
        }
    }
    return out;
}

// 读取并解析指定语言包
export async function loadLangPack(lang) {
    if (packs[lang]) return packs[lang];
    const file = normalizePath(`${localesDir()}/${lang}.toml`);
    try {
        const text = await Neutralino.filesystem.readFile(file);
        packs[lang] = flatten(parse(text));
        return packs[lang];
    } catch (e) {
        console.warn(`Failed to load language pack: ${lang}.toml`, e);
        packs[lang] = {};
        return packs[lang];
    }
}

// 解析语言设置：auto 时根据系统语言决定（中文系统→zh，其它语言→en），非法值一律回落英文
export function resolveLang(lang) {
    if (lang === "auto") {
        const sys = (navigator.language || navigator.userLanguage || "").toLowerCase();
        return sys.startsWith("zh") ? "zh" : "en";
    }
    return lang === "zh" ? "zh" : "en";
}

// 翻译函数
export function t(key) {
    const pack = packs[_lang];
    if (pack && pack[key] !== undefined) {
        return pack[key];
    }
    return key;
}

// 设置语言：auto 会被解析为实际语言
export function setLang(lang) {
    _lang = resolveLang(lang);
}

export function getLang() {
    return _lang;
}

export async function applyI18n() {
    // 确保语言包已加载
    await loadLangPack(_lang);
    // 更新所有 data-i18n 元素的文本
    document.querySelectorAll("[data-i18n]").forEach(el => {
        el.innerHTML = t(el.getAttribute("data-i18n"));
    });
    // 更新 placeholder
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
        el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    // 更新 title
    document.querySelectorAll("[data-i18n-title]").forEach(el => {
        el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
}
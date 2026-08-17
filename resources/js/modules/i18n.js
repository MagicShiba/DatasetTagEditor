// i18n.js - 中英文翻译（语言包从 {NL_PATH}/resources/locales/ 目录下的标准 TOML 文件动态加载）
// 说明：语言包文件放在应用目录的 resources/locales 子文件夹内（zh.toml / en.toml），便于用户直接编辑。
//       语言包使用标准 TOML 格式（[分区] + 键值对），解析后展开为 "分区.键" 的扁平键；
//       若某个键在语言包中缺失，则回退为键本身。
// 多语言支持：不限于 zh/en。将任意语言标签规范化为基础语言代码（如 zh-TW -> zh、ja-JP -> ja），
//       语言包缺失时按回退链 目标语言 -> en -> zh 依次降级；settings 界面的语言下拉框会自动列出
//       locales 目录下已存在的语言包文件，无需改代码即可添加新语言。

import { parse } from "../vendor/smol-toml.mjs";
import { normalizePath } from "./utils.js";

let _lang = "zh";

// 语言包缓存 { lang: { key: value } }
const packs = {};

// 已发现的语言包列表 [{ code, name }]（供设置界面的语言下拉框使用）
let availableLangs = [];

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

// 将语言标签规范化为基础语言代码（去掉地区/脚本后缀，如 zh-TW -> zh、ja-JP -> ja、en-US -> en）
function normalizeLang(lang) {
    const s = String(lang || "").toLowerCase().trim();
    if (!s) return "";
    return s.split(/[-_]/)[0];
}

// 解析语言设置：auto 时根据系统语言决定（任意语言代码均支持，不限于 zh/en）
export function resolveLang(lang) {
    let target;
    if (lang === "auto" || !lang) {
        target = normalizeLang(navigator.language || navigator.userLanguage || "");
        if (!target) target = "en";
    } else {
        target = normalizeLang(lang);
    }
    return target || "en";
}

// 读取并解析单个语言包文件，失败或为空时返回 null
async function loadPackFile(code) {
    try {
        const file = normalizePath(`${localesDir()}/${code}.toml`);
        const text = await Neutralino.filesystem.readFile(file);
        const flat = flatten(parse(text));
        return Object.keys(flat).length > 0 ? flat : null;
    } catch (e) {
        return null;
    }
}

// 读取并缓存指定语言包；目标语言缺失时按回退链 en -> zh 降级
export async function loadLangPack(lang) {
    const code = normalizeLang(lang) || "en";
    if (packs[code]) return packs[code];
    // 依次尝试：目标语言 -> en -> zh（已加载或可加载者优先）
    const chain = [...new Set([code, "en", "zh"])];
    let pack = null;
    for (const c of chain) {
        if (packs[c]) { pack = packs[c]; break; }
        pack = await loadPackFile(c);
        if (pack) { packs[c] = pack; break; }
    }
    packs[code] = pack || {};
    return packs[code];
}

// 翻译函数：当前语言包优先，缺键时回退英文包，再回退为键本身
export function t(key) {
    const pack = packs[_lang];
    if (pack && pack[key] !== undefined) return pack[key];
    const en = packs["en"];
    if (en && en[key] !== undefined) return en[key];
    return key;
}

// 设置语言：auto 会被解析为实际语言
export function setLang(lang) {
    _lang = resolveLang(lang);
}

export function getLang() {
    return _lang;
}

// 发现 locales 目录下可用的语言包（按 .toml 文件，按基础语言代码去重），
// 语言显示名优先取语言包内 [meta] name，否则回退为代码本身
export async function discoverLanguages() {
    const fallback = [
        { code: "zh", name: "中文" },
        { code: "en", name: "English" },
    ];
    try {
        const dir = normalizePath(localesDir());
        const entries = await Neutralino.filesystem.readDirectory(dir);
        const seen = new Set();
        const langs = [];
        for (const e of entries) {
            if (e.type !== "FILE") continue;
            const m = /^([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?)\.toml$/.exec(e.entry);
            if (!m) continue;
            const code = normalizeLang(m[1]);
            if (!code || seen.has(code)) continue;
            seen.add(code);
            let name = code;
            try {
                const text = await Neutralino.filesystem.readFile(normalizePath(`${dir}/${e.entry}`));
                const meta = parse(text).meta;
                if (meta && meta.name) name = String(meta.name);
            } catch (e2) { /* 使用代码作为显示名 */ }
            langs.push({ code, name });
        }
        // 保证 zh / en 作为回退语言始终可用
        for (const c of ["zh", "en"]) {
            if (!langs.some(l => l.code === c)) langs.unshift({ code: c, name: c === "zh" ? "中文" : "English" });
        }
        langs.sort((a, b) => {
            const rank = c => c === "zh" ? 0 : c === "en" ? 1 : 2;
            return rank(a.code) - rank(b.code) || a.code.localeCompare(b.code);
        });
        availableLangs = langs.length > 0 ? langs : fallback;
    } catch (e) {
        availableLangs = fallback;
    }
    return availableLangs;
}

// 获取已发现的语言包列表（供设置界面的语言下拉框使用）
export function getAvailableLanguages() {
    return availableLangs;
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
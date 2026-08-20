// utils.js - 通用工具函数

// 将 Windows 路径转换为 URL 友好路径（统一为正斜杠）
export function normalizePath(p) {
    return String(p).replace(/\\/g, "/");
}

// 将路径分割为数组
export function splitPath(p) {
    return normalizePath(p).split("/").filter(s => s.length > 0);
}

// 获取文件名的 stem（不带扩展名）
export function getStem(p) {
    const parts = splitPath(p);
    const name = parts[parts.length - 1] || "";
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : name;
}

// 获取扩展名（含点），无则返回空
export function getExtension(p) {
    const parts = splitPath(p);
    const name = parts[parts.length - 1] || "";
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx) : "";
}

// 替换扩展名
export function withSuffix(p, suffix) {
    const parts = splitPath(p);
    const name = parts[parts.length - 1] || "";
    const idx = name.lastIndexOf(".");
    const newName = idx >= 0 ? name.slice(0, idx) + suffix : name + suffix;
    const dir = parts.slice(0, -1);
    return [...dir, newName].join("/");
}

// 替换文件名（不含扩展名）
export function withStem(p, newStem) {
    const parts = splitPath(p);
    const name = parts[parts.length - 1] || "";
    const idx = name.lastIndexOf(".");
    const ext = idx >= 0 ? name.slice(idx) : "";
    const dir = parts.slice(0, -1);
    return [...dir, newStem + ext].join("/");
}

// 获取父目录
export function getDirname(p) {
    const parts = splitPath(p);
    parts.pop();
    return parts.join("/");
}

// 获取纯文件名
export function getBasename(p) {
    const parts = splitPath(p);
    return parts[parts.length - 1] || "";
}

// URL 编码路径段（保留 / 和 \）
export function encodePathUrl(p) {
    const n = normalizePath(p);
    return n.split("/").map(seg => encodeURIComponent(seg)).join("/");
}

// 简单的字符串 MD5 实现（纯 JS，用于生成缩略图缓存 key）
// 基于 public domain 的 js-md5 算法移植
export function md5(inputString) {
    function safeAdd(x, y) {
        const lsw = (x & 0xffff) + (y & 0xffff);
        const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
        return (msw << 16) | (lsw & 0xffff);
    }

    function bitRotateLeft(num, cnt) {
        return (num << cnt) | (num >>> (32 - cnt));
    }

    function md5cmn(q, a, b, x, s, t) {
        return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
    }
    function md5ff(a, b, c, d, x, s, t) {
        return md5cmn((b & c) | (~b & d), a, b, x, s, t);
    }
    function md5gg(a, b, c, d, x, s, t) {
        return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
    }
    function md5hh(a, b, c, d, x, s, t) {
        return md5cmn(b ^ c ^ d, a, b, x, s, t);
    }
    function md5ii(a, b, c, d, x, s, t) {
        return md5cmn(c ^ (b | ~d), a, b, x, s, t);
    }

    function binl2hex(binarray) {
        let hexTab = "0123456789abcdef";
        let str = "";
        for (let i = 0; i < binarray.length * 4; i++) {
            str += hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8 + 4)) & 0xf) +
                hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8)) & 0xf);
        }
        return str;
    }

    function binlMD5(x, len) {
        x[len >> 5] |= 0x80 << (len % 32);
        x[(((len + 64) >>> 9) << 4) + 14] = len;

        let a = 1732584193;
        let b = -271733879;
        let c = -1732584194;
        let d = 271733878;

        for (let i = 0; i < x.length; i += 16) {
            const olda = a;
            const oldb = b;
            const oldc = c;
            const oldd = d;

            a = md5ff(a, b, c, d, x[i], 7, -680876936);
            d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
            c = md5ff(c, d, a, b, x[i + 2], 17, 606105819);
            b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
            a = md5ff(a, b, c, d, x[i + 4], 7, -176418897);
            d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
            c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
            b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
            a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416);
            d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
            c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
            b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
            a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682);
            d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
            c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
            b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);

            a = md5gg(a, b, c, d, x[i + 1], 5, -165796510);
            d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
            c = md5gg(c, d, a, b, x[i + 11], 14, 643717713);
            b = md5gg(b, c, d, a, x[i], 20, -373897302);
            a = md5gg(a, b, c, d, x[i + 5], 5, -701558691);
            d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
            c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
            b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
            a = md5gg(a, b, c, d, x[i + 9], 5, 568446438);
            d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
            c = md5gg(c, d, a, b, x[i + 3], 14, -187363961);
            b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
            a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467);
            d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
            c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473);
            b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);

            a = md5hh(a, b, c, d, x[i + 5], 4, -378558);
            d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
            c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562);
            b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
            a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060);
            d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
            c = md5hh(c, d, a, b, x[i + 7], 16, -155497632);
            b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
            a = md5hh(a, b, c, d, x[i + 13], 4, 681279174);
            d = md5hh(d, a, b, c, x[i], 11, -358537222);
            c = md5hh(c, d, a, b, x[i + 3], 16, -722521979);
            b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
            a = md5hh(a, b, c, d, x[i + 9], 4, -640364487);
            d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
            c = md5hh(c, d, a, b, x[i + 15], 16, 530742520);
            b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);

            a = md5ii(a, b, c, d, x[i], 6, -198630844);
            d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
            c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
            b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
            a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571);
            d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
            c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
            b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
            a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359);
            d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
            c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380);
            b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
            a = md5ii(a, b, c, d, x[i + 4], 6, -145523070);
            d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
            c = md5ii(c, d, a, b, x[i + 2], 15, 718787259);
            b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);

            a = safeAdd(a, olda);
            b = safeAdd(b, oldb);
            c = safeAdd(c, oldc);
            d = safeAdd(d, oldd);
        }
        return [a, b, c, d];
    }

    function string2binl(str) {
        const bin = [];
        const mask = (1 << 8) - 1;
        for (let i = 0; i < str.length * 8; i += 8) {
            bin[i >> 5] |= (str.charCodeAt(i / 8) & mask) << (i % 32);
        }
        return bin;
    }

    function str2rstrUTF8(str) {
        return unescape(encodeURIComponent(str));
    }

    const utf8Str = str2rstrUTF8(inputString);
    const bin = string2binl(utf8Str);
    return binl2hex(binlMD5(bin, utf8Str.length * 8));
}

// 深拷贝简单对象/数组
export function clone(v) {
    return JSON.parse(JSON.stringify(v));
}

// sleep 辅助
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 常见宽高比列表（标签 + 宽/高数值 + 基准分母），覆盖横竖两种方向
const ASPECT_RATIOS = [
    ["1:1", 1, 1],
    ["5:4", 1.25, 4], ["4:5", 0.8, 5],
    ["4:3", 4 / 3, 3], ["3:4", 3 / 4, 4],
    ["3:2", 1.5, 2], ["2:3", 2 / 3, 3],
    ["16:9", 16 / 9, 9], ["9:16", 9 / 16, 16],
    ["21:9", 21 / 9, 9], ["9:21", 9 / 21, 21],
];

// 按最接近的常用比例换算宽高比显示：
// 保留常用比例的基准分母，将实际比值换算为该基准下的值并保留两位小数，
// 小数为 0 时省略小数位（如 1024×768 -> "4:3"，比 4:3 略宽 -> "4.15:3"）
export function formatAspectRatio(w, h) {
    if (!w || !h) return "";
    const r = w / h;
    let best = ASPECT_RATIOS[0];
    let bestDiff = Infinity;
    for (const item of ASPECT_RATIOS) {
        const diff = Math.abs(r - item[1]);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = item;
        }
    }
    const base = best[2];
    const numStr = (r * base).toFixed(2).replace(/\.00$/, "");
    return `${numStr}:${base}`;
}

// 将数值向下取整到 n 的倍数（如 513 向下取整到 512）
export function floorToMultiple(v, n = 64) {
    return Math.floor(v / n) * n;
}

// ================================================================
// 标签分隔
// ================================================================

// 标签分隔符（每个字符都是一个分隔符），默认英文逗号
let tagSeparators = ",";

// 设置标签分隔符（由设置项 tag_separators 驱动，应用启动与保存设置时调用）
export function setTagSeparators(sep) {
    tagSeparators = (sep && typeof sep === "string" && sep.length > 0) ? sep : ",";
}

// 获取当前标签分隔符字符串（每个字符都是一个分隔符）
export function getTagSeparators() {
    return tagSeparators;
}

// 判断文本是否为单个 JSON 块（整段就是一个合法的 JSON 对象）
export function isJsonBlock(text) {
    const s = String(text || "").trim();
    if (!s.startsWith("{") || !s.endsWith("}")) return false;
    try {
        JSON.parse(s);
        return true;
    } catch (e) {
        return false;
    }
}

// 从 start（指向 '{'）扫描到配对的 '}'，返回结束下标；非 JSON 对象（{ 后非字符串 key）返回 -1
function findJsonBlockEnd(s, start) {
    if (s[start] !== "{") return -1;
    // 预检：跳过空白后应为 '"'（JSON 对象以字符串 key 开头）
    let k = start + 1;
    while (k < s.length && /\s/.test(s[k])) k++;
    if (s[k] !== '"') return -1;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// ---- JSON 块格式化（展开 / 压缩标注文本中的 JSON 块） ----

// 数组（及其嵌套）内联为一行，如坐标 [ 0.12, 0.4, 0.25, 0.67 ]
function inlineJsonArray(arr) {
    return "[ " + arr.map(v => Array.isArray(v) ? inlineJsonArray(v) : JSON.stringify(v)).join(", ") + " ]";
}

// 判断值能否整体内联为一行：不含对象（数组元素也递归判断）时返回 true
function canInlineJson(value) {
    if (Array.isArray(value)) return value.every(canInlineJson);
    return value === null || typeof value !== "object";
}

// 递归格式化 JSON 值：对象多行缩进，纯数值/数组键值对保持在一行便于编辑
function formatJsonValue(value, indent) {
    const pad = " ".repeat(indent * 2);
    if (Array.isArray(value)) {
        if (canInlineJson(value)) return inlineJsonArray(value);
        // 含对象的数组：元素对象多行展开
        const items = value.map(v => formatJsonValue(v, indent + 1));
        return "[\n" + items.map(it => " ".repeat((indent + 1) * 2) + it).join(",\n") + "\n" + pad + "]";
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 0) return "{}";
        const innerPad = " ".repeat((indent + 1) * 2);
        const lines = entries.map(([k, v]) => innerPad + JSON.stringify(k) + ": " + formatJsonValue(v, indent + 1));
        return "{\n" + lines.join(",\n") + "\n" + pad + "}";
    }
    return JSON.stringify(value);
}

// 将单个 JSON 字符串格式化为多行（便于查看/编辑）；非 JSON 返回原文本
export function formatJsonPretty(text) {
    try { return formatJsonValue(JSON.parse(text), 0); } catch (e) { return text; }
}

// 扫描文本中的 JSON 对象块，逐块调用 fn 替换；其余内容原样保留
function replaceJsonBlocks(text, fn) {
    const s = String(text || "");
    let out = "";
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === "{") {
            const end = findJsonBlockEnd(s, i);
            if (end > i) {
                try {
                    out += fn(s.slice(i, end + 1));
                    i = end + 1;
                    continue;
                } catch (e) { /* 非法 JSON，该字符原样保留 */ }
            }
        }
        out += ch;
        i++;
    }
    return out;
}

// 将文本中所有 JSON 对象块展开（格式化）为多行，便于查看编辑；其余内容原样保留
export function expandJsonInText(text) {
    return replaceJsonBlocks(text, (block) => formatJsonPretty(block));
}

// 将文本中所有 JSON 对象块压缩为单行；其余内容原样保留
export function compressJsonInText(text) {
    return replaceJsonBlocks(text, (block) => JSON.stringify(JSON.parse(block)));
}

// 将标注文本规范化：连续分隔符合并为一个（取首个分隔符字符），分隔符之后恰好保留一个空格。
// 末尾文本沿用 splitCaptionWithSepts 的清理规则（多余逗号清除、句号保留）。
export function normalizeSepSpaces(text) {
    if (!text) return "";
    const { tags, septs } = splitCaptionWithSepts(text);
    if (tags.length === 0) return text;
    const seps = new Set(tagSeparators.split(""));
    const parts = [];
    for (let i = 0; i < tags.length; i++) {
        parts.push(tags[i]);
        if (i < tags.length - 1) {
            // 连续分隔符合并为一个（取首个分隔符字符），其后保留一个空格
            let sepChar = "";
            for (const c of septs[i] || "") {
                if (seps.has(c)) { sepChar = c; break; }
            }
            parts.push(sepChar + " ");
        } else {
            parts.push(septs[i] || "");
        }
    }
    return parts.join("");
}

// 移除标注中的所有换行：
// 若原文有多行，除最后一行外，行末没有分隔符时补上第一个分隔符（取 tag_separators 首字符）；
// 行末若已是分隔符或中/英文句号（天然分句符）则不再追加分隔符。
// 行与行之间以单个空格拼接（行末已有分隔符时自然形成"分隔符+空格"）。
export function removeNewlines(text) {
    if (!text) return "";
    if (!/[\r\n]/.test(text)) return text;
    const seps = new Set(tagSeparators.split(""));
    const firstSep = tagSeparators[0] || ",";
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return lines[0] || "";
    const parts = lines.map((line, i) => {
        const last = line[line.length - 1];
        if (i < lines.length - 1 && !seps.has(last) && last !== "." && last !== "\u3002") {
            return line + firstSep;
        }
        return line;
    });
    return parts.join(" ");
}

// 将标注文本按配置的分隔符拆分为标签列表（自动 trim 并过滤空项）。
// 特殊处理：
//   - 缩写内部的英文句点不拆（如 "D.O.G.E." 保持为一个标签）
//   - 数字之间的英文句点不拆（小数 / 版本号，如 "42.5"）
//   - 被引号包裹的内容整体作为一个标签，内部不分隔（支持 "…" '…' “…” ‘…’）
export function splitCaption(text) {
    return splitCaptionWithSepts(text).tags;
}

// 同 splitCaption，但额外返回每个标签后的原始间隔文本 septs：
//   septs[i] 为 tags[i] 之后的原文（i 为末位时表示末尾文本）。
// 末尾处理策略：
//   - 末尾只含逗号/空白时清除（清理多余的逗号）；
//   - 末尾含句号（. 或 。）时原样保留（正常句子的合理句号）。
export function splitCaptionWithSepts(text) {
    if (!text) return { tags: [], septs: [] };
    const seps = new Set(tagSeparators.split(""));
    const isWord = (c) => c !== undefined && /[A-Za-z0-9]/.test(c);
    const isDigit = (c) => c !== undefined && /[0-9]/.test(c);
    // 引号配对：开引号字符 -> 对应闭引号字符
    const CLOSE_OF = { '"': '"', "'": "'", "\u201C": "\u201D", "\u2018": "\u2019" };
    const parts = [];
    const septs = [];
    let buf = "";      // 当前标签内容
    let sepBuf = "";   // 当前分隔符段（分隔符 + 空白）
    let inSep = false; // 是否处于分隔符段
    let quote = null;  // 当前开引号字符，null 表示不在引号内

    // 提交当前标签及它后面的间隔文本（trailing 可选覆盖，用于结尾清理）
    const commit = (trailing) => {
        const tag = buf.trim();
        const gap = trailing !== undefined ? trailing : sepBuf;
        buf = "";
        sepBuf = "";
        inSep = false;
        if (tag) {
            parts.push(tag);
            septs.push(gap);
        }
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        // 引号内：所有字符原样保留（含分隔符），直到遇到闭引号
        if (quote) {
            if (inSep) commit();
            buf += ch;
            if (ch === quote) quote = null;
            continue;
        }

        // 开引号：英文/中文双引号与中文单引号
        if (ch === '"' || ch === "\u201C" || ch === "\u2018") {
            if (inSep) commit();
            quote = CLOSE_OF[ch];
            buf += ch;
            continue;
        }
        // 英文单引号：仅在它位于单词开头（非撇号/所有格，如 don't、cats'）时才作为开引号
        if (ch === "'" && !isWord(text[i - 1]) && isWord(text[i + 1])) {
            if (inSep) commit();
            quote = "'";
            buf += ch;
            continue;
        }

        // JSON 块：整个作为标签的一部分，不被内部的分隔符/引号拆散
        if (ch === "{") {
            const end = findJsonBlockEnd(text, i);
            if (end > i) {
                try {
                    const json = text.slice(i, end + 1);
                    JSON.parse(json);
                    // 前面是分隔符段：先提交前一标签，JSON 独立成一个标签；
                    // 否则 JSON 与前面的普通文本合并为一个标签（无分隔符时保持原样，不丢空格）
                    if (inSep) commit();
                    buf += json;
                    i = end;
                    continue;
                } catch (e) { /* 非合法 JSON，按普通字符处理 */ }
            }
        }

        let isSep = seps.has(ch);
        // 英文句点：小数（两侧均为数字）或缩写（两侧均为单个字符）内部的句点不作为分隔符
        if (isSep && ch === ".") {
            if (isDigit(text[i - 1]) && isDigit(text[i + 1])) {
                isSep = false; // 小数 / 版本号，如 42.5、1.1
            } else if (isWord(text[i - 1]) && !isWord(text[i - 2])
                && isWord(text[i + 1]) && !isWord(text[i + 2])) {
                isSep = false; // 缩写，如 D.O.G.E.
            }
        }

        if (isSep) {
            if (!inSep) { inSep = true; sepBuf = ""; }
            sepBuf += ch;
        } else {
            if (inSep) {
                // 分隔符段内：空白并入间隔文本（保留分隔符后的空格），其余字符开始新标签
                if (/\s/.test(ch)) {
                    sepBuf += ch;
                    continue;
                }
                commit();
            }
            buf += ch;
        }
    }

    if (inSep) {
        // 末尾：只含逗号/空白的分隔符清除，含句号的原样保留
        commit(cleanupTrailingSep(sepBuf));
    } else {
        commit("");
    }
    return { tags: parts, septs };
}

// 清理末尾分隔符：含句号（正常句子结尾）原样保留，否则（多余的逗号/空白）清除
export function cleanupTrailingSep(sep) {
    if (!sep) return "";
    if (sep.includes(".") || sep.includes("\u3002")) return sep;
    return "";
}

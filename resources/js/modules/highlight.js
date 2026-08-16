// highlight.js - 高亮规则解析与文本高亮渲染（与 Python 版 90_ui.js 行为一致）

// HTML 转义
export function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 构建标签匹配正则
function buildRegexForTag(tag, style) {
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flag = style.cs ? "g" : "gi";
    if (style.partial) {
        return new RegExp(escaped, flag);
    }
    return new RegExp("(?<=^|[,\\s])" + escaped + "(?=$|[,\\s])", flag);
}

// 生成行内样式
function makeStyles(style) {
    const arr = [];
    if (style.bg) arr.push("background-color:" + style.bg);
    if (style.fg) arr.push("color:" + style.fg);
    if (style.b === "1") arr.push("font-weight:bold");
    return arr.length ? arr.join("; ") : null;
}

// 解析规则文本（每行一条规则，逗号分隔）
export function parseRules(rulesText) {
    const rules = [];
    if (!rulesText) return rules;
    const lines = String(rulesText).split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(",");
        const ruleTags = [];
        const ruleStyle = {};
        for (let j = 0; j < parts.length; j++) {
            const part = parts[j].trim();
            if (part.startsWith("bg:")) {
                ruleStyle.bg = part.substring(3);
            } else if (part.startsWith("fg:")) {
                ruleStyle.fg = part.substring(3);
            } else if (part.startsWith("b:")) {
                ruleStyle.b = part.substring(2);
            } else if (part === "partial:1") {
                ruleStyle.partial = true;
            } else if (part === "cs:1") {
                ruleStyle.cs = true;
            } else if (part.length > 0) {
                ruleTags.push(part);
            }
        }
        rules.push({ tags: ruleTags, style: ruleStyle });
    }
    return rules;
}

// 应用高亮，返回 HTML 字符串
export function applyHighlight(text, rules) {
    if (!text) return "";
    const pairs = [];
    for (let r = 0; r < rules.length; r++) {
        if (rules[r].tags.length === 0) {
            const ss = makeStyles(rules[r].style);
            if (ss) pairs.push({ re: /(?=[\s\S])(?![\s\S])/g, style: rules[r].style });
            continue;
        }
        for (let t = 0; t < rules[r].tags.length; t++) {
            const re = buildRegexForTag(rules[r].tags[t], rules[r].style);
            pairs.push({ re, style: rules[r].style });
        }
    }

    const matches = [];
    for (let p = 0; p < pairs.length; p++) {
        const re = new RegExp(pairs[p].re.source, pairs[p].re.flags);
        let m;
        while ((m = re.exec(text)) !== null) {
            matches.push({ index: m.index, end: m.index + m[0].length, style: pairs[p].style, ruleOrder: p });
            if (m.index === re.lastIndex) re.lastIndex++;
        }
    }

    matches.sort((a, b) => a.index - b.index || a.ruleOrder - b.ruleOrder);
    const filtered = [];
    for (let i = 0; i < matches.length; i++) {
        if (filtered.length === 0 || matches[i].index >= filtered[filtered.length - 1].end) {
            filtered.push(matches[i]);
        }
    }

    let result = "";
    let pos = 0;
    for (let i = 0; i < filtered.length; i++) {
        const m = filtered[i];
        if (m.index > pos) {
            result += escapeHtml(text.substring(pos, m.index));
        }
        const ss = makeStyles(m.style);
        if (ss) {
            result += `<span style="${ss}">${escapeHtml(text.substring(m.index, m.end))}</span>`;
        } else {
            result += escapeHtml(text.substring(m.index, m.end));
        }
        pos = m.end;
    }
    if (pos < text.length) {
        result += escapeHtml(text.substring(pos));
    }
    return result;
}
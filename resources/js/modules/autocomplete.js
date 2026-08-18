// autocomplete.js - 标注输入自动补全（基于 autocomplete.txt 数据）

import { normalizePath } from "./utils.js";

const AC_CONFIG = { maxSuggestions: 20, minQueryLength: 1 };
let acItems = [];
let acSuggestions = [];
let acIndex = -1;
let acQuery = "";
let acTextarea = null;
let acBox = null;

// 加载 autocomplete.txt 数据
// 格式: tag,中文,次数 或 tag,次数
// 优先从应用目录外部文件读取（便于用户编辑），读取失败时回退到 bundle 内的 /data/autocomplete.txt
export async function loadAutocompleteData(url) {
    let text = null;
    try {
        // 尝试读取应用目录 resources/data 子文件夹下的外部文件（autocomplete.txt 不打包进 resources.neu）
        text = await Neutralino.filesystem.readFile(normalizePath(`${NL_PATH}/resources/data/autocomplete.txt`));
    } catch (e) {
        // 外部文件不存在时回退到 bundle 内路径
        try {
            const resp = await fetch(url);
            text = await resp.text();
        } catch (e2) {
            console.error("autocomplete data load fail", e2);
            return 0;
        }
    }
    acItems = text.split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => {
            const p = line.split(",").map(v => (v || "").trim());
            if (p.length === 2) {
                return { eng: p[0] || "", chi: "", num: parseInt(p[1], 10) || 0 };
            }
            return { eng: p[0] || "", chi: p[1] || "", num: parseInt(p[2], 10) || 0 };
        })
        .sort((a, b) => b.num - a.num);
    return acItems.length;
}

function acEscapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function acHighlight(t, q) {
    return q ? String(t).replace(new RegExp(`(${acEscapeRegExp(q)})`, "ig"), '<span class="ac-hl">$1</span>') : t;
}

function acFilter(q) {
    const s = [];
    const c = [];
    const lq = q.toLowerCase();
    const hasZh = /[\u4e00-\u9fff]/.test(q);
    acItems.forEach(it => {
        const txt = hasZh ? (it.chi || it.eng) : it.eng;
        const lt = hasZh ? txt : txt.toLowerCase();
        if (lt.startsWith(lq)) s.push(it);
        else if (lt.includes(lq)) c.push(it);
    });
    return [...s, ...c].slice(0, AC_CONFIG.maxSuggestions);
}

function acRender(list) {
    if (!acBox) return;
    acBox.innerHTML = "";
    if (!list || !list.length) {
        acBox.style.display = "none";
        return;
    }
    list.forEach((it, i) => {
        const d = document.createElement("div");
        d.className = "ac-row" + (i === acIndex ? " ac-act" : "");
        d.innerHTML = `<span class="ac-eng">${acHighlight(it.eng, acQuery)}</span><span class="ac-chi">${acHighlight(it.chi || "", acQuery)}</span><span class="ac-num">${it.num || ""}</span>`;
        d.addEventListener("pointerdown", e => { e.preventDefault(); acPick(i); });
        acBox.appendChild(d);
    });
    acBox.style.display = "block";
}

function acHide() {
    if (!acBox) return;
    acBox.style.display = "none";
    acIndex = -1;
    acSuggestions = [];
    acQuery = "";
}

function acPick(idx) {
    if (idx < 0 || idx >= acSuggestions.length) return;
    const chosen = acSuggestions[idx];
    const ta = acTextarea;
    if (!ta) return;
    const start = ta.selectionStart;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(start);
    const qs = start - acQuery.length;
    // 逗号分隔的标签输入（编辑框/批量/查找替换）追加 ", "；
    // 单值输入（标签筛选词、重命名文件名等）直接替换当前词
    const tail = ta.__acAppendComma === false ? "" : ", ";
    ta.value = before.slice(0, qs) + chosen.eng.replaceAll("_", " ") + tail + after;
    const pos = qs + chosen.eng.length + tail.length;
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    acHide();
}

// 计算 caret 坐标
// 零宽标记法：把"光标前文本"与"光标后文本"分开，中间插入零宽空格 span 精确定位。
// 不能沿用"span 装全部剩余文本"的写法——多行时 getBoundingClientRect() 返回的是所有行片段的并集边界，
// left 会吸附到最靠左的片段（行首）、剩余文本以 \n 开头时 top 还会被下推，导致补全框错位/遮挡。
// 单行 <input> 与多行 <textarea> 分开处理：input 文本垂直居中，top 用内容区垂直中线近似。
function acGetCaret(ta) {
    const s = getComputedStyle(ta);
    const isInput = ta.tagName === "INPUT";
    const d = document.createElement("div");
    const marker = document.createElement("span");
    const props = ['boxSizing', 'width', 'height', 'overflowX', 'overflowY',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
        'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
        'textDecoration', 'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace',
        // 换行/字形排版相关属性，保证与 textarea 断行位置完全一致
        'wordBreak', 'overflowWrap', 'direction', 'fontKerning', 'fontOpticalSizing',
        'fontVariationSettings', 'fontFeatureSettings', 'fontVariantLigatures', 'textRendering'];
    d.style.cssText = "position:absolute;visibility:hidden;left:-9999px;" +
        (isInput ? "white-space:pre;" : "white-space:pre-wrap;word-wrap:break-word;");
    props.forEach(p => { try { d.style[p] = s[p]; } catch (e) { } });
    const bf = ta.value.substring(0, ta.selectionStart);
    d.textContent = bf;
    marker.textContent = "\u200b"; // 零宽空格：不占宽度，且不参与分词
    d.appendChild(marker);
    const rest = ta.value.substring(ta.selectionStart);
    if (rest) d.appendChild(document.createTextNode(rest));
    document.body.appendChild(d);
    const mr = marker.getBoundingClientRect();
    const dr = d.getBoundingClientRect();
    document.body.removeChild(d);
    const tr = ta.getBoundingClientRect();
    const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) || 16;
    const left = tr.left + mr.left - dr.left - ta.scrollLeft + window.scrollX;
    let top;
    if (isInput) {
        // 单行输入框：文本垂直居中，用输入框垂直中线近似光标所在行
        top = tr.top + (tr.height - lh) / 2 + window.scrollY;
    } else {
        top = tr.top + mr.top - dr.top - ta.scrollTop + window.scrollY;
    }
    return { left, top, lh };
}

function acPosition() {
    if (!acBox || acBox.style.display === "none") return;
    if (!acTextarea) return;
    const p = acGetCaret(acTextarea);
    let l = Math.max(6, p.left);
    const boxW = acBox.offsetWidth || 250;
    const maxL = window.scrollX + window.innerWidth - boxW - 6;
    if (l > maxL) l = Math.max(6, maxL);

    // 先移除高度限制，测量完整显示高度
    acBox.style.maxHeight = "";
    const fullH = acBox.offsetHeight || 200;

    const below = p.top + p.lh + 6;
    const viewBottom = window.scrollY + window.innerHeight - 6;
    const above = p.top - 6;

    let t;
    let maxH = "";
    if (below + fullH <= viewBottom) {
        // 下方空间足够：完整显示在光标下方
        t = below;
    } else if (fullH <= above) {
        // 下方不足但上方足够：完整显示在光标上方
        t = Math.max(6, above - fullH);
    } else {
        // 底部空间不足：限制高度并启用滚动条
        maxH = Math.max(60, viewBottom - below);
        t = below;
    }

    acBox.style.left = l + "px";
    acBox.style.top = t + "px";
    acBox.style.maxHeight = maxH ? (maxH + "px") : "";
}

function acBind(ta, opts = {}) {
    if (!ta || ta.dataset.acb) return;
    ta.dataset.acb = "1";
    // 选中补全后是否追加 ", "（默认是；标签筛选词/文件名等单值输入关闭）
    ta.__acAppendComma = opts.appendComma !== false;
    ta.addEventListener("focus", () => { acTextarea = ta; });
    ta.addEventListener("keydown", e => {
        if (!acBox || acBox.style.display === "none") return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            acIndex = Math.min(acIndex + 1, acSuggestions.length - 1);
            acRender(acSuggestions);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            acIndex = Math.max(acIndex - 1, 0);
            acRender(acSuggestions);
        } else if (e.key === "Enter" || e.key === "Tab") {
            if (acIndex >= 0) {
                e.preventDefault();
                acPick(acIndex);
            }
        } else if (e.key === "Escape") {
            acHide();
        }
    });
    ta.addEventListener("input", () => {
        acTextarea = ta;
        const parts = ta.value.slice(0, ta.selectionStart).split(/[，,\.\s]+/);
        acQuery = parts[parts.length - 1] || "";
        if (acQuery.length < AC_CONFIG.minQueryLength) {
            acHide();
            return;
        }
        acSuggestions = acFilter(acQuery);
        acIndex = acSuggestions.length ? 0 : -1;
        acRender(acSuggestions);
        acPosition();
    });
    ta.addEventListener("scroll", acPosition);
    ta.addEventListener("click", acPosition);
}

// 确保补全框样式与容器已创建（幂等）
function ensureAcSetup() {
    if (!document.getElementById("ac-style")) {
        const st = document.createElement("style");
        st.id = "ac-style";
        st.textContent = '.ac-autocomplete-box{position:fixed;z-index:3000000;border-radius:6px;background:#212121ee;color:#eee;font-family:inherit;font-size:14px;display:none;box-shadow:0 0 1px 1px #00bbcc77;max-width:450px;min-width:250px;overflow-y:auto}.ac-row{display:grid;grid-template-columns:6fr 4fr 1fr;gap:8px;padding:2px 6px;cursor:pointer;align-items:center;white-space:nowrap;overflow:hidden;border-bottom:2px solid #666}.ac-eng{overflow:hidden;text-overflow:ellipsis;border-right:2px solid #666}.ac-chi{overflow:hidden;text-overflow:ellipsis;color:#cfcfcf}.ac-num{text-align:right;color:#bdbdbd;font-size:12px;min-width:36px}.ac-row:hover,.ac-row.ac-act{background:#444}.ac-hl{color:#ffdb4d;font-weight:bold}';
        document.head.appendChild(st);
    }
    if (!acBox) {
        acBox = document.createElement("div");
        acBox.className = "ac-autocomplete-box";
        document.body.appendChild(acBox);
        document.addEventListener("pointerdown", e => {
            if (acBox && !acBox.contains(e.target)) acHide();
        }, true);
    }
}

// 初始化自动补全框（可选绑定主编辑框）
export function initAutocomplete(textarea) {
    ensureAcSetup();
    if (textarea) {
        acBind(textarea);
    }
}

// 绑定自动补全到任意标签输入元素（input / textarea）
// opts.appendComma: 选中补全后是否追加 ", "；默认追加，单值输入（筛选词/文件名）传 false
export function bindAutocomplete(el, opts = {}) {
    if (!el) return;
    ensureAcSetup();
    acBind(el, opts);
}
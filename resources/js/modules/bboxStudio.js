// bboxStudio.js - 独立的边界框画板（应用级窗口）
// 左侧画布复用 bbox.js 的交互逻辑，右侧为比例/背景/文本控制
// 文本编辑复用 dte_edit_caption 的规则：高亮 + 自动补全 + JSON 展开/压缩

import { config } from "./config.js";
import { joinTagsWithSepts } from "./dataset.js";
import { bindAutocomplete, wasAcHiddenByEscape } from "./autocomplete.js";
import { parseRules, applyHighlight } from "./highlight.js";
import * as api from "./api.js";
import {
    clamp01,
    mapBboxBlocks,
    coordsToXY,
    extractBboxBlock,
    serializeBboxes,
    MIN_SIZE,
    MIN_LABEL_W,
    MIN_EDIT_W,
    CLICK_TOL,
    hitTestAllBoxes,
    hitTestForBox,
    cursorForHit,
    pickTarget,
} from "./bbox.js";

let els = {};
let ctx = null;

let boxes = [];
let selected = -1;
let dragging = null;
let lastClickPos = null;
let lastMousePos = null;
let clipboardBox = null;
let labelInput = null;
let rightCreate = null;

const COLOR_PALETTE = ["#00e5ff", "#ffd54f", "#7ef29a", "#ff8a80", "#ce93d8", "#ffab91"];

function nextDefaultLabel() {
    const set = new Set(boxes.map(b => b.label));
    let n = 1;
    while (set.has(`物体${n}`)) n++;
    return `物体${n}`;
}

function writeBackText(text) {
    const block = extractBboxBlock(text);
    if (!block) {
        if (boxes.length === 0) return text;
        const serialized = serializeBboxes(boxes, "objects", true);
        const trimmed = String(text || "").trim();
        if (!trimmed) return serialized;
        const sep = trimmed.endsWith(",") || trimmed.endsWith("，") ? " " : ", ";
        return trimmed + sep + serialized;
    }
    if (boxes.length === 0) return text.slice(0, block.start) + text.slice(block.end + 1);
    return text.slice(0, block.start) + serializeBboxes(boxes, block.key, block.isMap) + text.slice(block.end + 1);
}

// 左右翻转：所有边界框水平镜像（x' = 1 - x），左边物体到右边、右边到左边，y 不变
function flipBoxesHorizontally() {
    if (boxes.length === 0) return;
    for (const b of boxes) {
        const nx1 = 1 - b.x1, nx2 = 1 - b.x2;
        b.x1 = Math.min(nx1, nx2);
        b.x2 = Math.max(nx1, nx2);
    }
    draw();
    writeBack();
}

// 坐标转换：把文本中的边界框 JSON 块在 0~1 与 0~1000 两种格式间切换。
// 自动识别当前格式（存在大于 1 的坐标即为 0~1000），换算为另一种格式后写回文本。
// 直接读取原始数值（不经 parseCoords 的设置换算与 clamp），保证双向转换无损。
function convertCoordinateRange() {
    const ta = els.textarea;
    if (!ta) return;
    const s = String(ta.value || "");
    let done = false;
    const out = mapBboxBlocks(s, ({ key, json }) => {
        if (done) return null;
        const raw = json[key];
        const items = [];
        let isMap = false;
        const collect = (label, coords) => {
            if (!Array.isArray(coords) || coords.length !== 4) return;
            const nums = coords.map(Number);
            if (!nums.every(n => Number.isFinite(n))) return;
            // 按坐标类型设置把原始数值还原为内部 x/y，避免转换时打乱顺序
            items.push({ label: String(label), ...coordsToXY(nums) });
        };
        if (Array.isArray(raw)) {
            for (const item of raw) {
                if (!item || typeof item !== "object" || Object.entries(item).length !== 1) continue;
                const [label, coords] = Object.entries(item)[0];
                collect(label, coords);
            }
        } else if (raw && typeof raw === "object") {
            isMap = true;
            for (const [label, coords] of Object.entries(raw)) collect(label, coords);
        }
        if (items.length === 0) return null;
        // 识别当前格式并翻转到另一种
        const maxV = Math.max(...items.flatMap(b => [Math.abs(b.x1), Math.abs(b.y1), Math.abs(b.x2), Math.abs(b.y2)]));
        const target = maxV > 1 ? "0~1" : "0~1000";
        const k = maxV > 1 ? 1000 : 1;
        const internal = items.map(b => ({ label: b.label, x1: b.x1 / k, y1: b.y1 / k, x2: b.x2 / k, y2: b.y2 / k }));
        done = true;
        // 显式传 target，避免受坐标范围设置影响
        return serializeBboxes(internal, key, isMap, target);
    });
    if (!done) return;
    ta.value = out;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// 高亮同步（复用主编辑框的高亮规则）
function syncOverlayLayout() {
    const ta = els.textarea, inner = els.overlayInner;
    if (!ta || !inner) return;
    inner.style.width = ta.clientWidth + "px";
    inner.style.transform = "translateY(" + (-ta.scrollTop) + "px)";
}

function updateHighlightOverlay() {
    const ta = els.textarea, inner = els.overlayInner;
    if (!ta || !inner) return;
    // 画板没有高亮规则设置界面：优先复用主窗口隐藏的规则文本，否则读配置
    const ruleEl = document.getElementById("tb_highlight_rules");
    const rules = parseRules(ruleEl?.value ?? config.read("edit_selected")?.highlight_rules ?? "");
    inner.innerHTML = applyHighlight(ta.value, rules) + (ta.value.endsWith("\n") ? "<br>" : "");
    syncOverlayLayout();
}

// 文本 -> 画布
export function updateBboxesFromText() {
    const ta = els.textarea;
    if (!ta || !els.preview || !els.canvas) return;
    cancelLabelEdit();
    const block = extractBboxBlock(ta.value);
    boxes = block ? block.items : [];
    if (selected >= boxes.length) selected = -1;
    draw();
}

function clearCanvas() {
    if (!els.canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    els.canvas.style.display = "none";
}

function draw() {
    if (!els.preview || !els.canvas || !ctx) return;
    const m = getMetrics();
    if (m.pw <= 0 || m.ph <= 0 || m.w <= 0 || m.h <= 0) { clearCanvas(); return; }
    const dpr = window.devicePixelRatio || 1;
    els.canvas.style.display = "block";
    els.canvas.style.left = "0px";
    els.canvas.style.top = "0px";
    els.canvas.style.width = m.pw + "px";
    els.canvas.style.height = m.ph + "px";
    const bw = Math.max(1, Math.round(m.pw * dpr));
    const bh = Math.max(1, Math.round(m.ph * dpr));
    if (els.canvas.width !== bw) els.canvas.width = bw;
    if (els.canvas.height !== bh) els.canvas.height = bh;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    // 平移坐标系使「图像局部坐标」落到图像在预览区中的实际位置
    ctx.setTransform(dpr, 0, 0, dpr, m.offsetLeft * dpr, m.offsetTop * dpr);
    for (let i = 0; i < boxes.length; i++) if (i !== selected) drawBox(i, m.w, m.h);
    if (selected >= 0) drawBox(selected, m.w, m.h);
}

// 将标签文本按最大宽度换行（逐字符累加测量，兼容中英文），返回行数组。
// 超过 maxLines 行时截断，最后一行以省略号结尾。
function wrapLabelLines(label, maxW, maxLines = 5) {
    const text = String(label);
    const lines = [];
    let cur = "";
    for (const ch of text) {
        if (cur && ctx.measureText(cur + ch).width > maxW) {
            lines.push(cur);
            cur = ch;
        } else {
            cur += ch;
        }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
        lines.length = maxLines;
        let last = lines[maxLines - 1];
        while (last && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
        lines[maxLines - 1] = last + "…";
    }
    return lines;
}

// 绘制单个边界框（支持自由拖动，使用归一化显示）；标签支持多行显示
function drawBox(i, w, h) {
    const b = boxes[i];
    const L = Math.min(b.x1, b.x2) * w, R = Math.max(b.x1, b.x2) * w, T = Math.min(b.y1, b.y2) * h, B = Math.max(b.y1, b.y2) * h;
    const color = COLOR_PALETTE[i % COLOR_PALETTE.length];
    const isSel = i === selected;
    ctx.strokeStyle = color;
    ctx.lineWidth = isSel ? 4 : 2;
    const lw = ctx.lineWidth;
    ctx.strokeRect(L + lw / 2, T + lw / 2, Math.max(0, R - L - lw), Math.max(0, B - T - lw));
    const label = b.label || "";
    ctx.font = "13px sans-serif";
    // 标签换行：最大宽度取框宽（过窄时用 120px 下限），上限 240px，最多 5 行
    const maxLabelW = Math.min(Math.max(R - L, 120), 240);
    const lines = wrapLabelLines(label, maxLabelW);
    const lineH = 15;
    const tw = Math.max(...lines.map(ln => ctx.measureText(ln).width));
    const bw2 = Math.max(MIN_LABEL_W, tw + 6);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(L, T, bw2, lines.length * lineH);
    ctx.fillStyle = color;
    lines.forEach((ln, idx) => ctx.fillText(ln, L + 3, T + 11 + idx * lineH));
    if (isSel) {
        const hs = 6;
        const pts = [
            {x:L, y:T, c:"tl"}, {x:R, y:T, c:"tr"}, {x:L, y:B, c:"bl"}, {x:R, y:B, c:"br"},
            {x:(L+R)/2, y:T}, {x:(L+R)/2, y:B}, {x:L, y:(T+B)/2}, {x:R, y:(T+B)/2}
        ];
        for (const p of pts) {
            ctx.fillStyle = p.c === "br" ? "#ffe082" : "#ffffff";
            ctx.fillRect(p.x - hs/2, p.y - hs/2, hs, hs);
            ctx.strokeStyle = "rgba(0,0,0,0.6)";
            ctx.lineWidth = 1;
            ctx.strokeRect(p.x - hs/2, p.y - hs/2, hs, hs);
        }
    }
}

// 画布坐标系：图像显示尺寸、相对预览区内容盒的偏移，以及内容盒尺寸
// 无图像时退化为整个内容盒（画布仍铺满预览区）
function getMetrics() {
    const rect = els.preview.getBoundingClientRect();
    const cs = getComputedStyle(els.preview);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const pw = Math.max(0, rect.width - borderLeft - (parseFloat(cs.borderRightWidth) || 0) - padLeft - (parseFloat(cs.paddingRight) || 0));
    const ph = Math.max(0, rect.height - borderTop - (parseFloat(cs.borderBottomWidth) || 0) - padTop - (parseFloat(cs.paddingBottom) || 0));
    const img = els.img;
    if (img && img.src && img.naturalWidth) {
        const r = img.getBoundingClientRect();
        return {
            w: r.width,
            h: r.height,
            offsetLeft: r.left - rect.left - borderLeft - padLeft,
            offsetTop: r.top - rect.top - borderTop - padTop,
            pw,
            ph,
        };
    }
    return { w: pw, h: ph, offsetLeft: 0, offsetTop: 0, pw, ph };
}

// 命中检测：把预览区坐标换算到图像局部坐标后复用 bbox.js 的纯函数
function hitTestAll(px, py) {
    const m = getMetrics();
    return hitTestAllBoxes(boxes, px - m.offsetLeft, py - m.offsetTop, m.w, m.h);
}

function hitTestFor(i, px, py) {
    const m = getMetrics();
    return hitTestForBox(boxes[i], px - m.offsetLeft, py - m.offsetTop, m.w, m.h);
}

// 选区切换规则与主预览一致（缩放优先 / 重叠循环 / 拖动优先）
function pickAt(all, px, py, isSamePoint) {
    const m = getMetrics();
    return pickTarget(boxes, all, selected, isSamePoint, px - m.offsetLeft, py - m.offsetTop, m.w, m.h);
}

function localPos(e){
    const r = els.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// 右键拖拽新建：首次出现有效尺寸时插入文本框，之后只更新该框
function updateRightCreate(x, y) {
    const rc = rightCreate;
    if (Math.hypot(x - rc.startX, y - rc.startY) > 3) rc.moved = true;
    if (!rc.moved) return;
    const m = getMetrics();
    const x1 = clamp01((Math.min(rc.startX, x) - m.offsetLeft) / m.w);
    const x2 = clamp01((Math.max(rc.startX, x) - m.offsetLeft) / m.w);
    const y1 = clamp01((Math.min(rc.startY, y) - m.offsetTop) / m.h);
    const y2 = clamp01((Math.max(rc.startY, y) - m.offsetTop) / m.h);
    if (rc.idx >= 0) {
        Object.assign(boxes[rc.idx], { x1, y1, x2, y2 });
    } else {
        if (x2 - x1 < 0.005 || y2 - y1 < 0.005) return;
        boxes.push({ label: nextDefaultLabel(), x1, y1, x2, y2 });
        rc.idx = boxes.length - 1;
        selected = rc.idx;
    }
    draw();
}

// 执行移动/缩放（允许自由拖动，手柄可越过对侧）
function applyDrag(curX, curY, w, h){
    const d=dragging, b=boxes[d.i];
    const dx=(curX-d.startX)/w, dy=(curY-d.startY)/h;
    if(d.type==="move"){
        const width=Math.abs(d.orig.x2-d.orig.x1), height=Math.abs(d.orig.y2-d.orig.y1);
        let nx1=clamp01(Math.min(d.orig.x1,d.orig.x2)+dx);
        let ny1=clamp01(Math.min(d.orig.y1,d.orig.y2)+dy);
        nx1=Math.min(nx1,1-width);
        ny1=Math.min(ny1,1-height);
        b.x1=nx1; b.y1=ny1; b.x2=nx1+width; b.y2=ny1+height;
    }else{
        const o=d.orig; let x1=o.x1,y1=o.y1,x2=o.x2,y2=o.y2; const c=d.corner;
        if(c.includes("l")) x1=clamp01(o.x1+dx);
        if(c.includes("r")) x2=clamp01(o.x2+dx);
        if(c.includes("t")) y1=clamp01(o.y1+dy);
        if(c.includes("b")) y2=clamp01(o.y2+dy);
        b.x1=x1; b.y1=y1; b.x2=x2; b.y2=y2;
    }
}

function writeBack(){
    const ta=els.textarea;
    if(!ta) return;
    for(const b of boxes){
        if(b.x1 > b.x2) [b.x1, b.x2] = [b.x2, b.x1];
        if(b.y1 > b.y2) [b.y1, b.y2] = [b.y2, b.y1];
    }
    const newText=writeBackText(ta.value);
    if(newText!==ta.value){
        ta.value=newText;
        updateHighlightOverlay();
        ta.dispatchEvent(new Event("input",{bubbles:true}));
    }
}

// 删除当前选中的边界框
function deleteSelectedBox(){
    if(selected<0||selected>=boxes.length) return;
    cancelLabelEdit();
    boxes.splice(selected,1);
    selected=-1; draw(); writeBack();
}

// 判断点是否命中选中框左上角的标签文本区域（画布坐标）
function hitLabel(px, py) {
    if (selected < 0 || selected >= boxes.length) return false;
    const m = getMetrics();
    const b = boxes[selected];
    const L = m.offsetLeft + Math.min(b.x1, b.x2) * m.w;
    const T = m.offsetTop + Math.min(b.y1, b.y2) * m.h;
    ctx.font = "13px sans-serif";
    const bw = Math.max(MIN_LABEL_W, ctx.measureText(b.label || "").width + 6);
    return px >= L && px <= L + bw && py >= T && py <= T + 15;
}

// 标签编辑框（textarea）按内容自适应高度（长文本自动换行）
function autoSizeLabelInput() {
    if (!labelInput || labelInput.style.display === "none") return;
    labelInput.style.height = "auto";
    labelInput.style.height = labelInput.scrollHeight + "px";
}

// 打开选中框标签编辑（归一化左上角）
function openLabelEdit(){
    if(!labelInput||selected<0||selected>=boxes.length) return;
    const b=boxes[selected];
    const m = getMetrics();
    const L=m.offsetLeft + Math.min(b.x1,b.x2)*m.w, T=m.offsetTop + Math.min(b.y1,b.y2)*m.h;
    labelInput.value=b.label||"";
    labelInput.style.left=L+"px";
    labelInput.style.top=T+"px";
    ctx.font="13px sans-serif";
    const tw=ctx.measureText(labelInput.value||"").width;
    // 宽度钳制在 [MIN_EDIT_W, 240]，超长文本由 textarea 自动换行显示
    labelInput.style.width=(Math.max(MIN_EDIT_W, Math.min(tw, 240))+24)+"px";
    labelInput.style.display="block";
    autoSizeLabelInput();
    labelInput.focus(); labelInput.select();
}

function commitLabelEdit(){
    if(!labelInput||labelInput.style.display==="none") return;
    // 清理粘贴带入的换行符（标签为单值，换行显示由 textarea 自动折行承担）
    const val=labelInput.value.replace(/[\r\n]+/g," ").trim();
    labelInput.style.display="none";
    if(selected>=0&&selected<boxes.length&&val){
        boxes[selected].label=val; draw(); writeBack();
    }
}

function cancelLabelEdit(){ if(labelInput) labelInput.style.display="none"; }

// 复制当前选中的边界框（归一化宽度）
function copySelectedBox(){
    if(selected<0||selected>=boxes.length) return;
    const b=boxes[selected]; clipboardBox={label:b.label||"", w:Math.abs(b.x2-b.x1), h:Math.abs(b.y2-b.y1)};
}

// 生成不与现有标签重复的标签
function uniqueLabel(base){
    const names=new Set(boxes.map(b=>b.label));
    if(!names.has(base)) return base;
    const m=String(base).match(/_(\d+)$/);
    const prefix=m?base.replace(/_(\d+)$/,""):base;
    let n=m?parseInt(m[1],10)+1:2;
    let candidate=prefix+"_"+n;
    while(names.has(candidate)){ n++; candidate=prefix+"_"+n; }
    return candidate;
}

// 以鼠标位置为中心粘贴复制框（画布坐标 -> 图像局部坐标）
function pasteClipboardBox(){
    if(!clipboardBox) return;
    const m = getMetrics();
    if (m.w <= 0 || m.h <= 0) return;
    const cx = lastMousePos ? lastMousePos.x - m.offsetLeft : m.w / 2;
    const cy = lastMousePos ? lastMousePos.y - m.offsetTop : m.h / 2;
    const bw = Math.min(clipboardBox.w, 1), bh = Math.min(clipboardBox.h, 1);
    const nx = cx / m.w, ny = cy / m.h;
    const box = { label: uniqueLabel(clipboardBox.label), x1: clamp01(nx - bw / 2), y1: clamp01(ny - bh / 2), x2: clamp01(nx + bw / 2), y2: clamp01(ny + bh / 2) };
    boxes.push(box); selected = boxes.length - 1; draw(); writeBack();
}

// 背景与比例
let bgObjectUrl = "";

function setPreviewBgColor(color){
    if(els.preview) els.preview.style.background = color || "#000";
}

function setPreviewImage(src, dim = false){
    if(!els.img || !els.preview) return;
    if(dim) els.preview.classList.add("has-import-dim");
    else els.preview.classList.remove("has-import-dim");
    if(src){
        els.img.src = src;
        els.img.style.display = "block";
    }else{
        els.img.removeAttribute("src");
        els.img.style.display = "none";
        els.preview.classList.remove("has-import-dim");
    }
    els.img.onload = () => {
        // 比例为自由时，自动使用图像比例；其它比例时拉伸图像
        if(els.ratioPreset && els.ratioPreset.value === "free" && els.img.naturalWidth && els.img.naturalHeight){
            els.ratioW.value = els.img.naturalWidth;
            els.ratioH.value = els.img.naturalHeight;
            els.preview.classList.remove("stretch");
            applyRatio();
        } else {
            if(els.ratioPreset && els.ratioPreset.value !== "free"){
                els.preview.classList.add("stretch");
            }
            draw();
        }
    };
    els.img.onerror = () => { draw(); };
}
async function pickBackgroundImage(){
    try{
        let picked = await Neutralino.os.showOpenDialog("选择背景图像",{ filters: [{ name:"Images", extensions:["png","jpg","jpeg","webp","bmp","gif"] }]});
        if(!picked) return;
        let path = picked;
        if(Array.isArray(picked)) path = picked[0];
        if(!path) return;
        const buf = await api.readBinaryFile(path);
        if(!buf){ setPreviewImage(""); return; }
        if(bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
        const blob = new Blob([buf]);
        bgObjectUrl = URL.createObjectURL(blob);
        setPreviewImage(bgObjectUrl);
        if(els.bgPathLabel) els.bgPathLabel.textContent = path;
    }catch(e){ console.warn("pick bg failed",e); }
}

function clearBackgroundImage(){
    if(bgObjectUrl){ URL.revokeObjectURL(bgObjectUrl); bgObjectUrl=""; }
    setPreviewImage("", false);
    if(els.bgPathLabel) els.bgPathLabel.textContent = "";
    // 清除后若为自由比例，清空比例输入
    if(els.ratioPreset && els.ratioPreset.value === "free"){
        if(els.ratioW) els.ratioW.value = "";
        if(els.ratioH) els.ratioH.value = "";
        applyRatio();
    }
    els.preview.classList.remove("stretch");
}

// 通过文件路径加载背景图像（供初始化和导入使用）
export async function loadImageByPath(imgPath){
    if(!imgPath) return;
    try {
        const buf = await api.readBinaryFile(imgPath);
        if (buf && buf.byteLength) {
            if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
            bgObjectUrl = URL.createObjectURL(new Blob([buf]));
            setPreviewImage(bgObjectUrl, true);
        } else {
            // 读不到文件（如浏览器模式下的 http/blob 地址）时直接交给 img 加载
            setPreviewImage(imgPath, true);
        }
    } catch (err) {
        setPreviewImage(imgPath, true);
    }
    if (els.bgPathLabel) els.bgPathLabel.textContent = imgPath + " (导入)";
}

// 比例控制：画布始终保持比例、完整显示且宽高之一填满可用空间
// 按左侧可用空间等比摆放预览区（contain），比例取自宽高输入框
function layoutRatio(){
    const left = els.preview.closest(".bbox-studio-left");
    const rw = parseInt(els.ratioW.value, 10), rh = parseInt(els.ratioH.value, 10);
    if (!left || !rw || !rh) return;
    const ratio = rw / rh;
    const csLeft = getComputedStyle(left);
    const padW = (parseFloat(csLeft.paddingLeft) || 0) + (parseFloat(csLeft.paddingRight) || 0);
    const padH = (parseFloat(csLeft.paddingTop) || 0) + (parseFloat(csLeft.paddingBottom) || 0);
    const toolbar = left.querySelector(".bbox-studio-toolbar");
    const availW = Math.max(100, left.clientWidth - padW);
    const availH = Math.max(100, left.clientHeight - padH - (toolbar ? toolbar.offsetHeight : 0) - 6);
    let pw = availW, ph = pw / ratio;
    if (availW / availH > ratio) { ph = availH; pw = ph * ratio; }
    const csPre = getComputedStyle(els.preview);
    pw = Math.max(80, pw - (parseFloat(csPre.borderLeftWidth) || 0) - (parseFloat(csPre.borderRightWidth) || 0));
    ph = Math.max(80, ph - (parseFloat(csPre.borderTopWidth) || 0) - (parseFloat(csPre.borderBottomWidth) || 0));
    els.preview.style.width = Math.round(pw) + "px";
    els.preview.style.height = Math.round(ph) + "px";
    els.preview.style.flex = "none";
    els.preview.style.margin = "auto";
    els.preview.style.maxWidth = "none";
    els.preview.style.maxHeight = "none";
    draw();
}

function applyRatio(){
    const wInput = els.ratioW, hInput = els.ratioH, preset = els.ratioPreset;
    let w = parseInt(wInput.value, 10), h = parseInt(hInput.value, 10);
    if (preset && preset.value !== "free" && preset.value !== "custom") {
        const [pw, ph] = preset.value.split(":").map(Number);
        if (pw && ph) { w = pw; h = ph; wInput.value = pw; hInput.value = ph; }
    }
    const left = els.preview.closest(".bbox-studio-left");
    if (!w || !h) {
        els.preview.classList.remove("has-ratio");
        left.classList.remove("has-ratio");
        els.preview.style.removeProperty("--preview-ratio");
        els.preview.style.aspectRatio = "";
        els.preview.style.width = "";
        els.preview.style.height = "";
        els.preview.style.flex = "";
        els.preview.style.margin = "";
        els.preview.style.maxWidth = "";
        els.preview.style.maxHeight = "";
        draw();
        return;
    }
    els.preview.classList.add("has-ratio");
    left.classList.add("has-ratio");
    els.preview.style.setProperty("--preview-ratio", `${w} / ${h}`);
    els.preview.style.aspectRatio = `${w} / ${h}`;
    // 首次布局时左栏可能还没尺寸（窗口刚创建），下一帧再算
    if (left.clientWidth > 0) layoutRatio();
    else requestAnimationFrame(layoutRatio);
    if (els._ratioObserver) return;
    const onResize = () => { if (els.preview.classList.contains("has-ratio")) layoutRatio(); };
    if (window.ResizeObserver) {
        els._ratioObserver = new ResizeObserver(onResize);
        els._ratioObserver.observe(left);
    } else {
        window.addEventListener("resize", onResize);
        els._ratioObserver = { disconnect() {} };
    }
    els._onRatioResize = onResize;
}

let _inited = false;

export function initStudio(){
    if(_inited) return;
    _inited = true;
    els = {
        preview: document.getElementById("bbox_studio_preview"),
        img: document.getElementById("bbox_studio_img"),
        canvas: document.getElementById("bbox_studio_canvas"),
        textarea: document.getElementById("bbox_studio_text"),
        overlay: document.getElementById("bbox_studio_overlay"),
        overlayInner: document.getElementById("bbox_studio_overlay_inner"),
        ratioPreset: document.getElementById("bbox_studio_ratio_preset"),
        ratioW: document.getElementById("bbox_studio_w"),
        ratioH: document.getElementById("bbox_studio_h"),
        bgPick: document.getElementById("bbox_studio_pick_bg"),
        bgClear: document.getElementById("bbox_studio_clear_bg"),
        bgColor: document.getElementById("bbox_studio_bg_color"),
        bgPathLabel: document.getElementById("bbox_studio_bg_path"),
        closeBtn: document.getElementById("bbox_studio_close"),
        importBtn: document.getElementById("bbox_studio_import"),
        copyBtn: document.getElementById("bbox_studio_copy"),
        clearBtn: document.getElementById("bbox_studio_clear_boxes"),
        clearTextBtn: document.getElementById("bbox_studio_clear_text"),
        flipBtn: document.getElementById("bbox_studio_flip_h"),
        convertBtn: document.getElementById("bbox_studio_convert_range"),
    };
    if(!els.canvas || !els.preview) return;
    ctx = els.canvas.getContext("2d");
    labelInput = document.getElementById("bbox_studio_label_input");

    if(els.textarea){
        bindAutocomplete(els.textarea);
        els.textarea.addEventListener("input", ()=>{ updateHighlightOverlay(); updateBboxesFromText(); });
        els.textarea.addEventListener("scroll", syncOverlayLayout);
        if(window.ResizeObserver) new ResizeObserver(()=>syncOverlayLayout()).observe(els.textarea);
        updateHighlightOverlay();
    }
    if(labelInput){
        bindAutocomplete(labelInput,{appendComma:false});
        labelInput.addEventListener("mousedown", e=>e.stopPropagation());
        labelInput.addEventListener("dblclick", e=>e.stopPropagation());
        // 输入时高度自适应（长文本自动换行）
        labelInput.addEventListener("input", autoSizeLabelInput);
        labelInput.addEventListener("keydown", e=>{
            if(e.key==="Enter"){ e.preventDefault(); commitLabelEdit(); }
            else if(e.key==="Escape"){
                e.preventDefault();
                // 第一次 Escape 只关闭补全框，第二次才退出编辑
                if(!wasAcHiddenByEscape()){ cancelLabelEdit(); }
            }
        });
        labelInput.addEventListener("blur", ()=>{ if(labelInput.isConnected) commitLabelEdit(); });
    }

    if(els.ratioPreset) els.ratioPreset.addEventListener("change", ()=>{
        const v = els.ratioPreset.value;
        if(v==="free"){
            // 自由时若已有图像，自动使用图像比例，否则清空
            if(els.img && els.img.src && els.img.naturalWidth && els.img.naturalHeight){
                els.ratioW.value = els.img.naturalWidth;
                els.ratioH.value = els.img.naturalHeight;
            } else {
                els.ratioW.value=""; els.ratioH.value="";
            }
            els.preview.classList.remove("stretch");
        }
        else if(v !== "custom"){
            // 固定比例：写入宽高，排版由输入框驱动
            const [a,b]=v.split(":"); els.ratioW.value=a; els.ratioH.value=b;
            if(els.img && els.img.src) els.preview.classList.add("stretch");
        }
        applyRatio();
    });
    const autoRatio = () => { applyRatio(); };
    if(els.ratioW) els.ratioW.addEventListener("input", autoRatio);
    if(els.ratioH) els.ratioH.addEventListener("input", autoRatio);

    if(els.bgPick) els.bgPick.addEventListener("click", pickBackgroundImage);
    if(els.bgClear) els.bgClear.addEventListener("click", clearBackgroundImage);
    if(els.bgColor) els.bgColor.addEventListener("input", e=> setPreviewBgColor(e.target.value));
    if(els.bgColor) setPreviewBgColor(els.bgColor.value);

    if(els.copyBtn) els.copyBtn.addEventListener("click", async ()=>{
        try{ await navigator.clipboard.writeText(els.textarea.value); }catch(e){ await Neutralino.clipboard.writeText(els.textarea.value).catch(()=>{}); }
    });
    if(els.importBtn) els.importBtn.addEventListener("click", async ()=>{
        // 1. 导入文本（应导入当前图像的标注并覆盖已有文本）
        let importedText = null;
        let importedImgPath = null;
        // 优先尝试编辑框（包含未保存的编辑）
        const src = document.getElementById("dte_edit_caption");
        if(src && src.value !== undefined) importedText = src.value;
        if(importedText === null && window.opener && window.opener.document){
            try { const op = window.opener.document.getElementById("dte_edit_caption"); if(op) importedText = op.value; } catch(e){}
        }
        // 其次从主窗口数据集获取（保证选中图像准确，原分隔符）
        if(importedText === null || !importedImgPath){
            try {
                const mainApp = window.__app || (window.opener && window.opener.__app);
                if(mainApp && mainApp.gallerySelectedPath){
                    if(!importedImgPath) importedImgPath = mainApp.gallerySelectedPath;
                    if(importedText === null){
                        const d = mainApp.dte?.dataset?.getData(mainApp.gallerySelectedPath);
                        if(d) importedText = joinTagsWithSepts(d.tags, d.septs);
                    }
                }
            } catch(e){}
        }
        // 最后从 storage 读取（打开画板时写入的快照）
        if(importedText === null || !importedImgPath){
            try {
                const rawData = await Neutralino.storage.getData("bbox_studio_init_data");
                if(rawData){
                    let t = "", img = "";
                    try { const p = JSON.parse(rawData); t = p.text || ""; img = p.image || ""; } catch(e){ t = rawData; }
                    if(!importedText && t) importedText = t;
                    if(!importedImgPath && img) importedImgPath = img;
                }
            } catch(e){}
        }
        if(importedText !== null){
            els.textarea.value = importedText;
            els.textarea.dispatchEvent(new Event("input",{bubbles:true}));
        }
        // 2. 导入图像显示（压暗），自由比例时自动使用图像比例由 setPreviewImage.onload 处理
        try {
            if(importedImgPath) await loadImageByPath(importedImgPath);
        } catch(e){ console.warn("import image failed", e); }
    });
    if(els.clearBtn) els.clearBtn.addEventListener("click", ()=>{
        boxes=[]; selected=-1; draw(); writeBack();
    });
    if(els.clearTextBtn) els.clearTextBtn.addEventListener("click", ()=>{
        if(els.textarea){ els.textarea.value=""; els.textarea.dispatchEvent(new Event("input",{bubbles:true})); }
    });
    // 左右翻转：所有边界框水平镜像（x' = 1 - x），与原图像左右对称
    if(els.flipBtn) els.flipBtn.addEventListener("click", flipBoxesHorizontally);
    // 坐标转换：文本中的 JSON 块在 0~1 与 0~1000 两种格式间切换（自动识别当前格式后翻转）
    if(els.convertBtn) els.convertBtn.addEventListener("click", convertCoordinateRange);

    // 分割线拖动：调整左右比例，缩放时优先保证右侧可见
    const splitter = document.getElementById("bbox_studio_splitter");
    if (splitter) {
        let sX = 0, sW = 0;
        const RIGHT_MIN = 240, LEFT_MIN = 160, SPLITTER_W = 3;
        const clampOnResize = () => {
            const leftEl = document.querySelector(".bbox-studio-left");
            const rightEl = document.querySelector(".bbox-studio-right");
            if (!leftEl || !rightEl) return;
            // 仅当左侧已被拖动固定时才需钳制（flex 以 0 开头表示已固定）
            if (!leftEl.style.flex || !leftEl.style.flex.startsWith("0")) return;
            const maxLeft = window.innerWidth - RIGHT_MIN - SPLITTER_W - 8;
            const curW = leftEl.offsetWidth;
            if (curW > maxLeft) {
                const newW = Math.max(LEFT_MIN, maxLeft);
                leftEl.style.flex = "0 1 " + newW + "px";
                leftEl.style.width = newW + "px";
                if (els.preview && els.preview.classList.contains("has-ratio") && els._onRatioResize) els._onRatioResize();
                else draw();
            }
        };
        window.addEventListener("resize", clampOnResize);
        const onMove = (e) => {
            const dx = e.clientX - sX;
            const leftEl = document.querySelector(".bbox-studio-left");
            const rightEl = document.querySelector(".bbox-studio-right");
            if (!leftEl) return;
            const maxW = window.innerWidth - RIGHT_MIN - SPLITTER_W - 8;
            const newW = Math.max(LEFT_MIN, Math.min(maxW, sW + dx));
            // 左侧可收缩(优先保证右侧)，右侧可扩展占满剩余
            leftEl.style.flex = "0 1 " + newW + "px";
            leftEl.style.width = newW + "px";
            if (rightEl) {
                rightEl.style.flex = "1 0 320px";
                rightEl.style.width = "auto";
                rightEl.style.minWidth = RIGHT_MIN + "px";
            }
            if (els.preview && els.preview.classList.contains("has-ratio") && els._onRatioResize) els._onRatioResize();
            else draw();
        };
        const onUp = () => {
            splitter.classList.remove("dragging");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        splitter.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const leftEl = document.querySelector(".bbox-studio-left");
            if (!leftEl) return;
            sX = e.clientX;
            sW = leftEl.offsetWidth;
            splitter.classList.add("dragging");
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    }

    if(els.closeBtn) els.closeBtn.addEventListener("click", closeStudio);

    els.canvas.tabIndex = 0;
    els.canvas.addEventListener("keydown", e=>{
        if((e.key==="Delete"||e.key==="Backspace")&&selected>=0){ e.preventDefault(); deleteSelectedBox(); return; }
        if((e.ctrlKey||e.metaKey)&&e.key==="c"&&selected>=0){ e.preventDefault(); copySelectedBox(); return; }
        if((e.ctrlKey||e.metaKey)&&e.key==="v"&&clipboardBox){ e.preventDefault(); pasteClipboardBox(); }
    });

    if(window.ResizeObserver) new ResizeObserver(()=>{ if(boxes.length) draw(); }).observe(els.preview);
    els.preview.addEventListener("wheel", e=>{
        e.preventDefault();
    }, {passive:false});

    // 点击 preview 空白区域取消选中
    els.preview.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target === els.canvas || e.target === labelInput) return;
        if (selected < 0) return;
        const { x, y } = localPos(e);
        const all = hitTestAll(x, y);
        if (all.length === 0) { selected = -1; dragging = null; draw(); }
    });

    els.canvas.addEventListener("mousedown", e=>{
        if (e.button === 2) {
            e.preventDefault(); e.stopPropagation();
            const { x, y } = localPos(e);
            const m = getMetrics();
            if (m.w <= 0 || m.h <= 0) return;
            rightCreate = { startX: x, startY: y, w: m.w, h: m.h, idx: -1, moved: false };
            document.body.style.userSelect = "none";
            return;
        }
        e.preventDefault(); els.canvas.focus();
        if(e.button!==0) return;
        if(boxes.length===0){
            const ta = els.textarea;
            if(ta && ta.value.trim()) updateBboxesFromText();
        }
        const {x,y}=localPos(e);
        const m = getMetrics();
        if (m.w <= 0 || m.h <= 0) return;
        const all = hitTestAll(x, y);
        const isSamePoint= !!(lastClickPos && Math.hypot(x-lastClickPos.x, y-lastClickPos.y) < CLICK_TOL);
        lastClickPos={x,y};
        if(all.length===0){
            selected=-1; dragging=null; draw();
            const nx=(x - m.offsetLeft)/m.w, ny=(y - m.offsetTop)/m.h, half=0.05;
            const box={label: nextDefaultLabel(), x1:clamp01(nx-half), y1:clamp01(ny-half), x2:clamp01(nx+half), y2:clamp01(ny+half)};
            boxes.push(box); selected=boxes.length-1; draw(); writeBack();
            return;
        }
        const { target, pending } = pickAt(all, x, y, isSamePoint);
        if (pending === null) selected = target;
        e.stopPropagation();
        const hit=hitTestFor(target,x,y);
        if(!hit){ draw(); return; }
        const b=boxes[target];
        dragging={i:target,type:hit.type,corner:hit.corner,startX:x,startY:y,moved:false,pending,orig:{x1:b.x1,y1:b.y1,x2:b.x2,y2:b.y2}};
        document.body.style.userSelect="none";
        draw();
    });
    els.canvas.addEventListener("mousemove", e=>{
        const {x,y}=localPos(e); lastMousePos={x,y};
        if(dragging){
            if(Math.hypot(x-dragging.startX,y-dragging.startY)>3) dragging.moved=true;
            if(dragging.moved){
                const m = getMetrics();
                applyDrag(x, y, m.w, m.h);
                draw();
            }
            return;
        }
        if (rightCreate) {
            updateRightCreate(x, y);
            return;
        }
        if(boxes.length===0) return;
        const all = hitTestAll(x, y);
        if(all.length===0){ els.canvas.style.cursor="default"; return; }
        const hitOnSelected = all.includes(selected) ? hitTestFor(selected, x, y) : null;
        const target = hitOnSelected ? selected : pickAt(all, x, y, false).target;
        els.canvas.style.cursor=cursorForHit(hitTestFor(target, x, y));
    });
    els.canvas.addEventListener("contextmenu", e=>{
        e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
        if (!rightCreate) return;
        const { x, y } = localPos(e);
        updateRightCreate(x, y);
    });
    window.addEventListener("mouseup", e=>{
        if (rightCreate) {
            const rc = rightCreate; rightCreate = null; document.body.style.userSelect = "";
            if (e.button === 2 || rc.moved) {
                if (!rc.moved) {
                    const m = getMetrics();
                    const nx = (rc.startX - m.offsetLeft) / m.w, ny = (rc.startY - m.offsetTop) / m.h, half = 0.05;
                    const box = { label: nextDefaultLabel(), x1: clamp01(nx - half), y1: clamp01(ny - half), x2: clamp01(nx + half), y2: clamp01(ny + half) };
                    boxes.push(box); selected = boxes.length - 1; draw(); writeBack();
                } else if (rc.idx >= 0) {
                    const b = boxes[rc.idx];
                    if ((b.x2 - b.x1) < MIN_SIZE || (b.y2 - b.y1) < MIN_SIZE) { boxes.splice(rc.idx, 1); selected = -1; }
                    else selected = rc.idx;
                    draw(); writeBack();
                }
                return;
            }
        }
        if (!dragging) return;
        const d = dragging; dragging = null; document.body.style.userSelect = ""; els.canvas.style.cursor = "default";
        if (d.moved) { writeBack(); return; }
        // 纯点击：pending 存在时切到最小框；点击落在标签区域则进入标签编辑
        const switched = d.pending !== null && d.pending !== selected;
        if (switched) selected = d.pending;
        if ((switched || d.i === selected) && hitLabel(d.startX, d.startY)) {
            openLabelEdit();
            return;
        }
        draw();
    });
    applyRatio();
}

export function closeStudio(){
    try { Neutralino.app.exit(); } catch (e) { window.close(); }
}

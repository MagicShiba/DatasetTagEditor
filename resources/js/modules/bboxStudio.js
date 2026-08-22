// bboxStudio.js - 独立的边界框画板（应用级窗口）
// 左侧画布复用 bbox.js 的交互逻辑，右侧为比例/背景/文本控制
// 文本编辑复用 dte_edit_caption 的规则：高亮 + 自动补全 + JSON 展开/压缩

import { getSetting, config } from "./config.js";
import { joinTagsWithSepts } from "./dataset.js";
import { formatJsonPretty } from "./utils.js";
import { bindAutocomplete } from "./autocomplete.js";
import { parseRules, applyHighlight } from "./highlight.js";
import * as api from "./api.js";
import {
    clamp01,
    findBalancedObject,
    parseCoords,
    extractBboxBlock as extractBboxBlockCore,
    serializeBboxes as serializeBboxesCore,
    boxArea,
    HANDLE,
    MIN_SIZE,
    MIN_LABEL_W,
    MIN_EDIT_W,
    CLICK_TOL,
    hitTestAllBoxes,
    hitTestForBox,
    sortedByNearestBoxes,
    cursorForHit,
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

export function extractBboxBlock(text) {
    return extractBboxBlockCore(text);
}

function getBboxPrecision() {
    const v = Number(getSetting("bbox_json_decimal_places"));
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 3;
}

function serializeBboxes(list, key = "object", isMap = false) {
    return serializeBboxesCore(list, key, isMap);
}

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
    // 保留高亮但无 UI：优先读隐藏的 tb_highlight_rules（若存在），否则读 config
    let rulesText = "";
    try {
        const taRule = document.getElementById("tb_highlight_rules");
        if (taRule && taRule.value !== undefined) rulesText = taRule.value;
        else rulesText = config.read("edit_selected")?.highlight_rules || "";
    } catch(e){
        try { rulesText = config.read("edit_selected")?.highlight_rules || ""; } catch(e2){}
    }
    const rules = parseRules(rulesText);
    inner.innerHTML = applyHighlight(ta.value, rules) + (ta.value.endsWith("\n") ? "<br>" : "");
    syncOverlayLayout();
}

// 文本 -> 画布
export function updateBboxesFromText() {
    const ta = els.textarea;
    if (!ta || !els.preview || !els.canvas) return;
    cancelLabelEdit();
    const block = extractBboxBlock(ta.value);
    if (block) {
        boxes = block.items;
        if (selected >= boxes.length) selected = -1;
        els.preview.classList.add("has-bbox");
        draw();
    } else {
        boxes = [];
        selected = -1;
        els.preview.classList.add("has-bbox");
        clearCanvas();
        draw();
    }
}

function clearCanvas() {
    if (!els.canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    els.canvas.style.display = "none";
}

function draw() {
    const img = els.img, preview = els.preview, canvas = els.canvas;
    if (!preview || !canvas || !ctx) return;
    const rect = preview.getBoundingClientRect();
    const cs = getComputedStyle(preview);
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;

    let w, h, offsetLeft, offsetTop;
    const pw = rect.width - borderLeft - parseFloat(cs.borderRightWidth || 0) - padLeft - parseFloat(cs.paddingRight || 0);
    const ph = rect.height - borderTop - parseFloat(cs.borderBottomWidth || 0) - padTop - parseFloat(cs.paddingBottom || 0);
    if (pw <= 0 || ph <= 0) { clearCanvas(); return; }
    if (els.preview.clientWidth === 0) return;
    if (img && img.src && img.naturalWidth) {
        const imgRect = img.getBoundingClientRect();
        const prevRect = preview.getBoundingClientRect();
        if (imgRect.width <= 0 || imgRect.height <= 0) { clearCanvas(); return; }
        w = imgRect.width; h = imgRect.height;
        offsetLeft = imgRect.left - prevRect.left - borderLeft - padLeft;
        offsetTop = imgRect.top - prevRect.top - borderTop - padTop;
    } else {
        w = pw; h = ph;
        offsetLeft = 0; offsetTop = 0;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.style.display = "block";
    canvas.style.left = "0px";
    canvas.style.top = "0px";
    canvas.style.width = pw + "px";
    canvas.style.height = ph + "px";
    const bw = Math.max(1, Math.round(pw * dpr));
    const bh = Math.max(1, Math.round(ph * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, offsetLeft * dpr, offsetTop * dpr);
    for (let i = 0; i < boxes.length; i++) if (i !== selected) drawBox(i, w, h);
    if (selected >= 0) drawBox(selected, w, h);
}

// 绘制单个边界框（支持自由拖动，使用归一化显示）
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
    const tw = ctx.measureText(label).width;
    const bw2 = Math.max(MIN_LABEL_W, tw + 6);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(L, T, bw2, 15);
    ctx.fillStyle = color;
    ctx.fillText(label, L + 3, T + 11);
    if (isSel) {
        const hs = 6;
        const pts = [
            {x:L, y:T, c:"tl"}, {x:R, y:T, c:"tr"}, {x:L, y:B, c:"bl"}, {x:R, y:B, c:"br"},
            {x:(L+R)/2, y:T}, {x:(L+R)/2, y:B}, {x:L, y:(T+B)/2}, {x:R, y:(T+B)/2}
        ];
        for (const p of pts) {
            if(p.c === "tl") ctx.fillStyle = "#ffffff";
            else if(p.c === "br") ctx.fillStyle = "#ffe082";
            else ctx.fillStyle = "#ffffff";
            ctx.fillRect(p.x - hs/2, p.y - hs/2, hs, hs);
            ctx.strokeStyle = "rgba(0,0,0,0.6)";
            ctx.lineWidth = 1;
            ctx.strokeRect(p.x - hs/2, p.y - hs/2, hs, hs);
        }
    }
}

function getMetrics() {
    const rect = els.preview.getBoundingClientRect();
    const cs = getComputedStyle(els.preview);
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    let w, h, offsetLeft = 0, offsetTop = 0;
    if (els.img && els.img.src && els.img.naturalWidth) {
        const imgRect = els.img.getBoundingClientRect();
        const prevRect = els.preview.getBoundingClientRect();
        w = imgRect.width; h = imgRect.height;
        offsetLeft = imgRect.left - prevRect.left - borderLeft - padLeft;
        offsetTop = imgRect.top - prevRect.top - borderTop - padTop;
    } else {
        const pw = rect.width - borderLeft - parseFloat(cs.borderRightWidth || 0) - padLeft - parseFloat(cs.paddingRight || 0);
        const ph = rect.height - borderTop - parseFloat(cs.borderBottomWidth || 0) - padTop - parseFloat(cs.paddingBottom || 0);
        w = pw; h = ph;
    }
    return { w, h, offsetLeft, offsetTop };
}

// 命中检测：返回该点可交互的所有框索引（归一化显示，需加上偏移）
function hitTestAll(px, py, w, h) {
    const m = getMetrics();
    const offL = m.offsetLeft, offT = m.offsetTop;
    // 使用画板 core 的命中逻辑，但需偏移
    const list = [];
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const L = offL + Math.min(b.x1, b.x2) * m.w;
        const R = offL + Math.max(b.x1, b.x2) * m.w;
        const T = offT + Math.min(b.y1, b.y2) * m.h;
        const B = offT + Math.max(b.y1, b.y2) * m.h;
        const nearCorner =
            (Math.abs(px - L) <= HANDLE && Math.abs(py - T) <= HANDLE) ||
            (Math.abs(px - R) <= HANDLE && Math.abs(py - T) <= HANDLE) ||
            (Math.abs(px - L) <= HANDLE && Math.abs(py - B) <= HANDLE) ||
            (Math.abs(px - R) <= HANDLE && Math.abs(py - B) <= HANDLE);
        const nearEdge =
            (px >= L - HANDLE && px <= L + HANDLE && py >= T && py <= B) ||
            (px >= R - HANDLE && px <= R + HANDLE && py >= T && py <= B) ||
            (py >= T - HANDLE && py <= T + HANDLE && px >= L && px <= R) ||
            (py >= B - HANDLE && py <= B + HANDLE && px >= L && px <= R);
        const inside = px >= L && px <= R && py >= T && py <= B;
        if (inside || nearEdge || nearCorner) list.push(i);
    }
    return list;
}

// 对指定框判断具体交互（归一化显示）
function hitTestFor(i, px, py, w, h) {
    const m = getMetrics();
    const b = boxes[i];
    const L = m.offsetLeft + Math.min(b.x1, b.x2) * m.w;
    const R = m.offsetLeft + Math.max(b.x1, b.x2) * m.w;
    const T = m.offsetTop + Math.min(b.y1, b.y2) * m.h;
    const B = m.offsetTop + Math.max(b.y1, b.y2) * m.h;
    if (Math.abs(px - L) <= HANDLE && Math.abs(py - T) <= HANDLE) return { type: "resize", corner: "tl" };
    if (Math.abs(px - R) <= HANDLE && Math.abs(py - T) <= HANDLE) return { type: "resize", corner: "tr" };
    if (Math.abs(px - R) <= HANDLE && Math.abs(py - B) <= HANDLE) return { type: "resize", corner: "br" };
    if (Math.abs(px - L) <= HANDLE && Math.abs(py - B) <= HANDLE) return { type: "resize", corner: "bl" };
    if (px >= L - HANDLE && px <= L + HANDLE && py >= T && py <= B) return { type: "resize", corner: "l" };
    if (px >= R - HANDLE && px <= R + HANDLE && py >= T && py <= B) return { type: "resize", corner: "r" };
    if (py >= T - HANDLE && py <= T + HANDLE && px >= L && px <= R) return { type: "resize", corner: "t" };
    if (py >= B - HANDLE && py <= B + HANDLE && px >= L && px <= R) return { type: "resize", corner: "b" };
    if (px >= L && px <= R && py >= T && py <= B) return { type: "move" };
    return null;
}

function cursorFor(hit) {
    return cursorForHit(hit);
}

function sortedByNearest(all, px, py, w, h) {
    const m = getMetrics();
    // 按面积 + 距离排序，距离需加上偏移
    return all.slice().sort((a, b) => {
        const ba = boxes[a], bb = boxes[b];
        const areaA = boxArea(ba), areaB = boxArea(bb);
        if (Math.abs(areaA - areaB) > 1e-6) return areaA - areaB;
        const da = Math.hypot((ba.x1 + ba.x2) / 2 * m.w + m.offsetLeft - px, (ba.y1 + ba.y2) / 2 * m.h + m.offsetTop - py);
        const db = Math.hypot((bb.x1 + bb.x2) / 2 * m.w + m.offsetLeft - px, (bb.y1 + bb.y2) / 2 * m.h + m.offsetTop - py);
        return da - db;
    });
}

function localPos(e){
    const r = els.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
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

// 判断点是否命中选中框左上角的标签文本区域（归一化）
function hitLabel(px, py, w, h){
    if(selected<0||selected>=boxes.length) return false;
    const m = getMetrics();
    const b=boxes[selected]; const L=m.offsetLeft + Math.min(b.x1,b.x2)*m.w, T=m.offsetTop + Math.min(b.y1,b.y2)*m.h;
    ctx.font="13px sans-serif";
    const tw=ctx.measureText(b.label||"").width;
    const bw2=Math.max(MIN_LABEL_W, tw+6);
    return px>=L&&px<=L+bw2&&py>=T&&py<=T+15;
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
    labelInput.style.width=(Math.max(MIN_EDIT_W, tw)+24)+"px";
    labelInput.style.display="block";
    labelInput.focus(); labelInput.select();
}

function commitLabelEdit(){
    if(!labelInput||labelInput.style.display==="none") return;
    const val=labelInput.value.trim();
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

// 以鼠标位置为中心粘贴复制框
function pasteClipboardBox(){
    if(!clipboardBox) return;
    let w,h;
    if(els.img && els.img.src && els.img.naturalWidth){
        const r=els.img.getBoundingClientRect(); w=r.width; h=r.height;
    } else {
        const r=els.preview.getBoundingClientRect(); const cs=getComputedStyle(els.preview);
        w = r.width - (parseFloat(cs.borderLeftWidth)||0) - (parseFloat(cs.borderRightWidth)||0) - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0);
        h = r.height - (parseFloat(cs.borderTopWidth)||0) - (parseFloat(cs.borderBottomWidth)||0) - (parseFloat(cs.paddingTop)||0) - (parseFloat(cs.paddingBottom)||0);
    }
    if(w<=0||h<=0) return;
    const cx=lastMousePos?lastMousePos.x:w/2, cy=lastMousePos?lastMousePos.y:h/2;
    const bw2=Math.min(clipboardBox.w,1), bh2=Math.min(clipboardBox.h,1);
    const nx=cx/w, ny=cy/h;
    const box={label:uniqueLabel(clipboardBox.label), x1:clamp01(nx-bw2/2), y1:clamp01(ny-bh2/2), x2:clamp01(nx+bw2/2), y2:clamp01(ny+bh2/2)};
    boxes.push(box); selected=boxes.length-1; draw(); writeBack();
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
        // 比例为自由时，自动使用图像比例
        if(els.ratioPreset && els.ratioPreset.value === "free" && els.img.naturalWidth && els.img.naturalHeight){
            els.ratioW.value = els.img.naturalWidth;
            els.ratioH.value = els.img.naturalHeight;
            applyRatio();
        } else {
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
}

// 比例控制：画布始终保持比例、完整显示且宽高之一填满可用空间
function applyRatio(){
    const wInput = els.ratioW, hInput = els.ratioH, preset = els.ratioPreset;
    let w = parseInt(wInput.value,10), h = parseInt(hInput.value,10);
    if(preset && preset.value !== "free" && preset.value !== "custom"){
        const [pw,ph] = preset.value.split(":").map(Number);
        if(pw && ph){ w = pw; h = ph; wInput.value = pw; hInput.value = ph; }
    }
    const left = els.preview ? els.preview.closest(".bbox-studio-left") : null;
    if(!w || !h){
        els.preview.classList.remove("has-ratio");
        if (left) left.classList.remove("has-ratio");
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
    if (left) left.classList.add("has-ratio");
    const ratio = w / h;
    els.preview.style.setProperty("--preview-ratio", `${w} / ${h}`);
    els.preview.style.aspectRatio = `${w} / ${h}`;
    // 计算可用空间，让画布以 contain 方式填满
    const doLayout = () => {
        if (!els.preview || !left) return;
        const csLeft = getComputedStyle(left);
        const padW = (parseFloat(csLeft.paddingLeft)||0) + (parseFloat(csLeft.paddingRight)||0);
        const padH = (parseFloat(csLeft.paddingTop)||0) + (parseFloat(csLeft.paddingBottom)||0);
        const toolbar = left.querySelector(".bbox-studio-toolbar");
        const tbH = toolbar ? toolbar.offsetHeight : 0;
        const gap = 6;
        const availW = Math.max(100, left.clientWidth - padW);
        const availH = Math.max(100, left.clientHeight - padH - tbH - gap);
        let pw, ph;
        if (availW / availH > ratio) {
            ph = availH;
            pw = ph * ratio;
        } else {
            pw = availW;
            ph = pw / ratio;
        }
        const csPre = getComputedStyle(els.preview);
        const bw = (parseFloat(csPre.borderLeftWidth)||0) + (parseFloat(csPre.borderRightWidth)||0);
        const bh = (parseFloat(csPre.borderTopWidth)||0) + (parseFloat(csPre.borderBottomWidth)||0);
        pw = Math.max(80, pw - bw);
        ph = Math.max(80, ph - bh);
        els.preview.style.width = Math.round(pw) + "px";
        els.preview.style.height = Math.round(ph) + "px";
        els.preview.style.flex = "none";
        els.preview.style.margin = "auto";
        els.preview.style.maxWidth = "none";
        els.preview.style.maxHeight = "none";
        draw();
    };
    if (left && left.clientWidth > 0) doLayout();
    else requestAnimationFrame(doLayout);
    if (!els._ratioObserver) {
        const onResize = () => {
            if (!els.preview || !els.preview.classList.contains("has-ratio")) return;
            const rw = parseInt(els.ratioW.value,10), rh = parseInt(els.ratioH.value,10);
            if (!rw || !rh) return;
            const r = rw / rh;
            const csL = getComputedStyle(left);
            const padW2 = (parseFloat(csL.paddingLeft)||0) + (parseFloat(csL.paddingRight)||0);
            const padH2 = (parseFloat(csL.paddingTop)||0) + (parseFloat(csL.paddingBottom)||0);
            const tb2 = left.querySelector(".bbox-studio-toolbar");
            const tbH2 = tb2 ? tb2.offsetHeight : 0;
            const aW = Math.max(100, left.clientWidth - padW2);
            const aH = Math.max(100, left.clientHeight - padH2 - tbH2 - 6);
            let pW, pH;
            if (aW / aH > r) { pH = aH; pW = pH * r; } else { pW = aW; pH = pW / r; }
            const csP = getComputedStyle(els.preview);
            const bW = (parseFloat(csP.borderLeftWidth)||0) + (parseFloat(csP.borderRightWidth)||0);
            const bH = (parseFloat(csP.borderTopWidth)||0) + (parseFloat(csP.borderBottomWidth)||0);
            pW = Math.max(80, pW - bW); pH = Math.max(80, pH - bH);
            els.preview.style.width = Math.round(pW) + "px";
            els.preview.style.height = Math.round(pH) + "px";
            draw();
        };
        if (window.ResizeObserver) {
            els._ratioObserver = new ResizeObserver(onResize);
            els._ratioObserver.observe(left);
        } else {
            window.addEventListener("resize", onResize);
            els._ratioObserver = { disconnect(){} };
        }
        els._onRatioResize = onResize;
    }
}

let _inited = false;
export function initStudio(){
    if(_inited) return;
    _inited = true;
    const isStandalone = document.body.classList.contains("bbox-studio-standalone");
    els = {
        panel: document.getElementById("bbox_studio_panel"),
        windowEl: document.getElementById("bbox_studio_window"),
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
        textareaWrap: document.getElementById("bbox_studio_textarea_wrap"),
        importBtn: document.getElementById("bbox_studio_import"),
        copyBtn: document.getElementById("bbox_studio_copy"),
        clearBtn: document.getElementById("bbox_studio_clear_boxes"),
        clearTextBtn: document.getElementById("bbox_studio_clear_text"),
        splitter: document.getElementById("bbox_studio_splitter"),
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
        labelInput.addEventListener("keydown", e=>{
            if(e.key==="Enter"){ e.preventDefault(); commitLabelEdit(); }
            else if(e.key==="Escape"){ e.preventDefault(); cancelLabelEdit(); }
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
        }
        else if(v==="custom"){ }
        else { const [a,b]=v.split(":"); els.ratioW.value=a; els.ratioH.value=b; }
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
        // 优先尝试编辑框（包含未保存的编辑）
        const src = document.getElementById("dte_edit_caption");
        if(src && src.value !== undefined) importedText = src.value;
        if(importedText === null && window.opener && window.opener.document){
            try { const op = window.opener.document.getElementById("dte_edit_caption"); if(op) importedText = op.value; } catch(e){}
        }
        // 其次从主窗口数据集获取（保证选中图像准确，原分隔符）
        if(importedText === null){
            try {
                const mainApp = window.__app || (window.opener && window.opener.__app);
                if(mainApp && mainApp.gallerySelectedPath){
                    const d = mainApp.dte?.dataset?.getData(mainApp.gallerySelectedPath);
                    if(d) importedText = joinTagsWithSepts(d.tags, d.septs);
                }
            } catch(e){}
        }
        if(importedText !== null){
            els.textarea.value = importedText;
            els.textarea.dispatchEvent(new Event("input",{bubbles:true}));
        } else {
            let got = false;
            try {
                const t = await Neutralino.storage.getData("bbox_studio_init_text");
                if(t !== null && t !== undefined && els.textarea){ els.textarea.value = t; els.textarea.dispatchEvent(new Event("input",{bubbles:true})); got = true; }
            } catch(e){}
            try {
                const lt = localStorage.getItem("bbox_studio_init_text");
                if(!got && lt !== null && lt !== undefined && els.textarea) { els.textarea.value = lt; els.textarea.dispatchEvent(new Event("input",{bubbles:true})); got = true; }
            } catch(e){}
            if(!got && window.opener){
                try { const ot = window.opener.localStorage.getItem("bbox_studio_init_text"); if(ot !== null && ot !== undefined){ els.textarea.value = ot; els.textarea.dispatchEvent(new Event("input",{bubbles:true})); } } catch(e){}
            }
        }
        // 2. 导入图像显示（压暗），自由比例时自动使用图像比例由 setPreviewImage.onload 处理
        try {
            let imgPath = "";
            // 同窗口直接尝试获取主预览图
            const inPagePreview = document.getElementById("preview_img");
            // 若在同一文档内（非独立窗口），尝试直接获取选中路径
            if(window.__app && window.__app.gallerySelectedPath) imgPath = window.__app.gallerySelectedPath;
            if(!imgPath && window.opener && window.opener.__app && window.opener.__app.gallerySelectedPath) imgPath = window.opener.__app.gallerySelectedPath;
            if(!imgPath) {
                try { imgPath = await Neutralino.storage.getData("bbox_studio_init_image"); } catch(e){}
            }
            if(!imgPath) {
                try { imgPath = localStorage.getItem("bbox_studio_init_image") || ""; } catch(e){}
            }
            // 若仍无路径但同页有预览图，尝试复用其 src（浏览器模式）
            if(!imgPath && inPagePreview && inPagePreview.src && inPagePreview.getAttribute("src")){
                const s = inPagePreview.getAttribute("src");
                // 若是 blob/http 直接复用并压暗
                if(s.startsWith("blob:") || s.startsWith("http") || s.startsWith("data:")){
                    if(bgObjectUrl) { try{ URL.revokeObjectURL(bgObjectUrl); }catch(e){} bgObjectUrl=""; }
                    setPreviewImage(s, true);
                    if(els.bgPathLabel) els.bgPathLabel.textContent = "(当前预览)";
                    return;
                } else {
                    imgPath = s;
                }
            }
            if(imgPath){
                // 通过 api 读取本地文件为 blob
                try {
                    const buf = await api.readBinaryFile(imgPath);
                    if(buf && buf.byteLength){
                        if(bgObjectUrl) { try{ URL.revokeObjectURL(bgObjectUrl); }catch(e){} }
                        const blob = new Blob([buf]);
                        bgObjectUrl = URL.createObjectURL(blob);
                        setPreviewImage(bgObjectUrl, true);
                        if(els.bgPathLabel) els.bgPathLabel.textContent = imgPath + " (导入)";
                    } else {
                        // 读取失败则尝试直接设路径
                        setPreviewImage(imgPath, true);
                        if(els.bgPathLabel) els.bgPathLabel.textContent = imgPath + " (导入)";
                    }
                } catch(err){
                    // 浏览器环境下可能无 Neutralino，直接尝试用路径
                    setPreviewImage(imgPath, true);
                    if(els.bgPathLabel) els.bgPathLabel.textContent = imgPath + " (导入)";
                }
            }
        } catch(e){ console.warn("import image failed", e); }
    });
    if(els.clearBtn) els.clearBtn.addEventListener("click", ()=>{
        boxes=[]; selected=-1; draw(); writeBack();
    });
    if(els.clearTextBtn) els.clearTextBtn.addEventListener("click", ()=>{
        if(els.textarea){ els.textarea.value=""; els.textarea.dispatchEvent(new Event("input",{bubbles:true})); }
    });

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

    document.addEventListener("keydown", e=>{
        if(e.key==="Escape" && isStudioOpen()){
            e.stopPropagation();
            if(document.body.classList.contains("bbox-studio-standalone")){
                try{ Neutralino.app.exit(); }catch(err){ window.close(); }
            } else {
                closeStudio();
            }
        }
    });

    if(els.closeBtn) els.closeBtn.addEventListener("click", ()=>{
        if(document.body.classList.contains("bbox-studio-standalone")){
            try{ Neutralino.app.exit(); }catch(err){ window.close(); }
        } else {
            closeStudio();
        }
    });
    if(els.panel && !document.body.classList.contains("bbox-studio-standalone")) els.panel.addEventListener("click", e=>{ if(e.target===els.panel) closeStudio(); });

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
        let w, h;
        if (els.img && els.img.src && els.img.naturalWidth) {
            const r = els.img.getBoundingClientRect(); w = r.width; h = r.height;
        } else {
            const r = els.preview.getBoundingClientRect(); const cs = getComputedStyle(els.preview);
            w = r.width - (parseFloat(cs.borderLeftWidth)||0) - (parseFloat(cs.borderRightWidth)||0) - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0);
            h = r.height - (parseFloat(cs.borderTopWidth)||0) - (parseFloat(cs.borderBottomWidth)||0) - (parseFloat(cs.paddingTop)||0) - (parseFloat(cs.paddingBottom)||0);
        }
        if (w <= 0 || h <= 0) { selected = -1; dragging = null; draw(); return; }
        const all = hitTestAll(x, y, w, h);
        if (all.length === 0) { selected = -1; dragging = null; draw(); }
    });

    els.canvas.addEventListener("mousedown", e=>{
        if (e.button === 2) {
            e.preventDefault(); e.stopPropagation();
            const { x, y } = localPos(e);
            let w, h;
            if (els.img && els.img.src && els.img.naturalWidth) {
                const r = els.img.getBoundingClientRect(); w = r.width; h = r.height;
            } else {
                const r = els.preview.getBoundingClientRect(); const cs = getComputedStyle(els.preview);
                w = r.width - (parseFloat(cs.borderLeftWidth)||0) - (parseFloat(cs.borderRightWidth)||0) - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0);
                h = r.height - (parseFloat(cs.borderTopWidth)||0) - (parseFloat(cs.borderBottomWidth)||0) - (parseFloat(cs.paddingTop)||0) - (parseFloat(cs.paddingBottom)||0);
            }
            if (w <= 0 || h <= 0) return;
            rightCreate = { startX: x, startY: y, w, h, idx: -1, moved: false };
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
        let w,h;
        if(els.img && els.img.src && els.img.naturalWidth){
            const r=els.img.getBoundingClientRect(); w=r.width; h=r.height;
        } else {
            const r=els.preview.getBoundingClientRect(); const cs=getComputedStyle(els.preview);
            w = r.width - (parseFloat(cs.borderLeftWidth)||0) - (parseFloat(cs.borderRightWidth)||0) - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0);
            h = r.height - (parseFloat(cs.borderTopWidth)||0) - (parseFloat(cs.borderBottomWidth)||0) - (parseFloat(cs.paddingTop)||0) - (parseFloat(cs.paddingBottom)||0);
        }
        if(w<=0||h<=0) return;
        const all=hitTestAll(x,y,w,h);
        const isSamePoint= !!(lastClickPos && Math.hypot(x-lastClickPos.x, y-lastClickPos.y) < CLICK_TOL);
        lastClickPos={x,y};
        if(all.length===0){
            selected=-1; dragging=null; draw();
            const nx=x/w, ny=y/h, half=0.05;
            const box={label: nextDefaultLabel(), x1:clamp01(nx-half), y1:clamp01(ny-half), x2:clamp01(nx+half), y2:clamp01(ny+half)};
            boxes.push(box); selected=boxes.length-1; draw(); writeBack();
            return;
        }
        const sorted=sortedByNearest(all,x,y,w,h);
        let target;
        let pending = null;
        const wasOnSelected=all.indexOf(selected)>=0;
        const hitOnSelected= wasOnSelected ? hitTestFor(selected,x,y,w,h) : null;
        if(wasOnSelected && hitOnSelected?.type==="resize"){ target=selected; }
        else if(isSamePoint && wasOnSelected && sorted.length>1){ const ci=sorted.indexOf(selected); target=sorted[(ci+1)%sorted.length]; }
        else if(wasOnSelected && hitOnSelected){ target=selected; pending=sorted[0]; if(pending===selected) pending=null; }
        else { target=sorted[0]; }
        if(pending===null) selected=target;
        e.stopPropagation();
        const hit=hitTestFor(target,x,y,w,h);
        if(!hit){ draw(); return; }
        const b=boxes[target];
        dragging={i:target,type:hit.type,corner:hit.corner,startX:x,startY:y,moved:false,pending,orig:{x1:b.x1,y1:b.y1,x2:b.x2,y2:b.y2}};
        document.body.style.userSelect="none";
        draw();
    });
    els.canvas.addEventListener("mousemove", e=>{
        let w,h;
        if(els.img && els.img.src && els.img.naturalWidth){
            const r=els.img.getBoundingClientRect(); w=r.width; h=r.height;
        } else {
            const r=els.preview.getBoundingClientRect(); const cs=getComputedStyle(els.preview);
            w = r.width - (parseFloat(cs.borderLeftWidth)||0) - (parseFloat(cs.borderRightWidth)||0) - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0);
            h = r.height - (parseFloat(cs.borderTopWidth)||0) - (parseFloat(cs.borderBottomWidth)||0) - (parseFloat(cs.paddingTop)||0) - (parseFloat(cs.paddingBottom)||0);
        }
        const {x,y}=localPos(e); lastMousePos={x,y};
        if(dragging){
            if(Math.hypot(x-dragging.startX,y-dragging.startY)>3) dragging.moved=true;
            if(dragging.moved){ applyDrag(x,y,w,h); draw(); }
            return;
        }
        if (rightCreate) {
            if (Math.hypot(x - rightCreate.startX, y - rightCreate.startY) > 3) rightCreate.moved = true;
            if (!rightCreate.moved) return;
            if (rightCreate.idx === -1) {
                const x1 = clamp01(Math.min(rightCreate.startX, x) / rightCreate.w);
                const x2 = clamp01(Math.max(rightCreate.startX, x) / rightCreate.w);
                const y1 = clamp01(Math.min(rightCreate.startY, y) / rightCreate.h);
                const y2 = clamp01(Math.max(rightCreate.startY, y) / rightCreate.h);
                if (x2 - x1 < 0.005 || y2 - y1 < 0.005) return;
                const box = { label: nextDefaultLabel(), x1, y1, x2, y2 };
                boxes.push(box);
                rightCreate.idx = boxes.length - 1;
                selected = rightCreate.idx;
            } else {
                const b = boxes[rightCreate.idx];
                b.x1 = clamp01(Math.min(rightCreate.startX, x) / rightCreate.w);
                b.x2 = clamp01(Math.max(rightCreate.startX, x) / rightCreate.w);
                b.y1 = clamp01(Math.min(rightCreate.startY, y) / rightCreate.h);
                b.y2 = clamp01(Math.max(rightCreate.startY, y) / rightCreate.h);
            }
            draw();
            return;
        }
        if(boxes.length===0) return;
        const all=hitTestAll(x,y,w,h);
        if(all.length===0){ els.canvas.style.cursor="default"; return; }
        const wasOnSelected=all.indexOf(selected)>=0;
        const hitOnSelected= wasOnSelected ? hitTestFor(selected,x,y,w,h) : null;
        const target= hitOnSelected ? selected : sortedByNearest(all,x,y,w,h)[0];
        els.canvas.style.cursor=cursorFor(hitTestFor(target,x,y,w,h));
    });
    els.canvas.addEventListener("contextmenu", e=>{
        e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
        if (!rightCreate) return;
        const { x, y } = localPos(e);
        if (Math.hypot(x - rightCreate.startX, y - rightCreate.startY) > 3) rightCreate.moved = true;
        if (!rightCreate.moved) return;
        if (rightCreate.idx === -1) {
            const x1 = clamp01(Math.min(rightCreate.startX, x) / rightCreate.w);
            const x2 = clamp01(Math.max(rightCreate.startX, x) / rightCreate.w);
            const y1 = clamp01(Math.min(rightCreate.startY, y) / rightCreate.h);
            const y2 = clamp01(Math.max(rightCreate.startY, y) / rightCreate.h);
            if (x2 - x1 < 0.005 || y2 - y1 < 0.005) return;
            const box = { label: nextDefaultLabel(), x1, y1, x2, y2 };
            boxes.push(box);
            rightCreate.idx = boxes.length - 1;
            selected = rightCreate.idx;
        } else {
            const b = boxes[rightCreate.idx];
            b.x1 = clamp01(Math.min(rightCreate.startX, x) / rightCreate.w);
            b.x2 = clamp01(Math.max(rightCreate.startX, x) / rightCreate.w);
            b.y1 = clamp01(Math.min(rightCreate.startY, y) / rightCreate.h);
            b.y2 = clamp01(Math.max(rightCreate.startY, y) / rightCreate.h);
        }
        draw();
    });
    window.addEventListener("mouseup", e=>{
        if (rightCreate) {
            const rc = rightCreate; rightCreate = null; document.body.style.userSelect = "";
            if (e.button === 2 || rc.moved) {
                if (!rc.moved) {
                    const nx = rc.startX / rc.w, ny = rc.startY / rc.h, half = 0.05;
                    const box = { label: nextDefaultLabel(), x1: clamp01(nx - half), y1: clamp01(ny - half), x2: clamp01(nx + half), y2: clamp01(ny + half) };
                    boxes.push(box); selected = boxes.length - 1; draw(); writeBack();
                } else {
                    if (rc.idx >= 0) {
                        const b = boxes[rc.idx];
                        if ((b.x2 - b.x1) < MIN_SIZE || (b.y2 - b.y1) < MIN_SIZE) { boxes.splice(rc.idx, 1); selected = -1; }
                        else selected = rc.idx;
                        draw(); writeBack();
                    }
                }
                return;
            }
        }
        if(!dragging) return;
        const d=dragging; dragging=null; document.body.style.userSelect=""; els.canvas.style.cursor="default";
        if(d.moved){ writeBack(); return; }
        if(d.pending!==null && d.pending!==selected){
            selected=d.pending; draw();
            let w,h;
            if(els.img && els.img.src && els.img.naturalWidth){
                const r=els.img.getBoundingClientRect(); w=r.width; h=r.height;
            } else {
                const r=els.preview.getBoundingClientRect(); const cs=getComputedStyle(els.preview);
                w = r.width - (parseFloat(cs.borderLeftWidth)||0) - (parseFloat(cs.borderRightWidth)||0) - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0);
                h = r.height - (parseFloat(cs.borderTopWidth)||0) - (parseFloat(cs.borderBottomWidth)||0) - (parseFloat(cs.paddingTop)||0) - (parseFloat(cs.paddingBottom)||0);
            }
            if(hitLabel(d.startX,d.startY,w,h)){ openLabelEdit(); }
            return;
        }
        if(d.i===selected){
            let w,h;
            if(els.img && els.img.src && els.img.naturalWidth){
                const r=els.img.getBoundingClientRect(); w=r.width; h=r.height;
            } else {
                const r=els.preview.getBoundingClientRect(); const cs=getComputedStyle(els.preview);
                w = r.width - (parseFloat(cs.borderLeftWidth)||0) - (parseFloat(cs.borderRightWidth)||0) - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0);
                h = r.height - (parseFloat(cs.borderTopWidth)||0) - (parseFloat(cs.borderBottomWidth)||0) - (parseFloat(cs.paddingTop)||0) - (parseFloat(cs.paddingBottom)||0);
            }
            if(hitLabel(d.startX,d.startY,w,h)){ openLabelEdit(); return; }
        }
    });

    applyRatio();
}

export function openStudio(){
    if(document.body.classList.contains("bbox-studio-standalone")){
        requestAnimationFrame(()=>{
            updateHighlightOverlay();
            updateBboxesFromText();
            draw();
            syncOverlayLayout();
        });
        return;
    }
    if(!els.panel) initStudio();
    if(els.panel) els.panel.classList.remove("hidden");
    requestAnimationFrame(()=>{
        updateHighlightOverlay();
        updateBboxesFromText();
        draw();
        syncOverlayLayout();
    });
}
export function closeStudio(){
    if(document.body.classList.contains("bbox-studio-standalone")){
        try{ Neutralino.app.exit(); }catch(e){ window.close(); }
        return;
    }
    if(els.panel) els.panel.classList.add("hidden");
    cancelLabelEdit();
}
export function isStudioOpen(){
    if(document.body.classList.contains("bbox-studio-standalone")) return true;
    return els.panel && !els.panel.classList.contains("hidden");
}

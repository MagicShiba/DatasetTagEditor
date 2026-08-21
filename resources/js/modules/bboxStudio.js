// bboxStudio.js - 独立的边界框画板（应用级窗口）
// 左侧画布复用 bbox.js 的交互逻辑，右侧为比例/背景/文本控制
// 文本编辑复用 dte_edit_caption 的规则：高亮 + 自动补全 + JSON 展开/压缩

import { getSetting } from "./config.js";
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

function writeBackText(text) {
    const block = extractBboxBlock(text);
    if (!block) {
        if (boxes.length === 0) return text;
        const serialized = serializeBboxes(boxes);
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
    const rulesText = document.getElementById("tb_highlight_rules")?.value || "";
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
    if (img && img.src && img.naturalWidth) {
        const imgRect = img.getBoundingClientRect();
        const prevRect = preview.getBoundingClientRect();
        if (imgRect.width <= 0 || imgRect.height <= 0) { clearCanvas(); return; }
        w = imgRect.width; h = imgRect.height;
        offsetLeft = imgRect.left - prevRect.left - borderLeft - padLeft;
        offsetTop = imgRect.top - prevRect.top - borderTop - padTop;
    } else {
        w = rect.width - borderLeft - parseFloat(cs.borderRightWidth || 0) - padLeft - parseFloat(cs.paddingRight || 0);
        h = rect.height - borderTop - parseFloat(cs.borderBottomWidth || 0) - padTop - parseFloat(cs.paddingBottom || 0);
        if (w <= 0 || h <= 0) { clearCanvas(); return; }
        offsetLeft = 0; offsetTop = 0;
        if (els.preview.clientWidth === 0) return;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.style.display = "block";
    canvas.style.left = offsetLeft + "px";
    canvas.style.top = offsetTop + "px";
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < boxes.length; i++) if (i !== selected) drawBox(i, w, h);
    if (selected >= 0) drawBox(selected, w, h);
}

// 绘制单个边界框
function drawBox(i, w, h) {
    const b = boxes[i];
    const L = b.x1 * w, R = b.x2 * w, T = b.y1 * h, B = b.y2 * h;
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
        const pts = [[L,T],[R,T],[L,B],[R,B],[(L+R)/2,T],[(L+R)/2,B],[L,(T+B)/2],[R,(T+B)/2]];
        ctx.fillStyle = "#fff";
        for (const [hx, hy] of pts) ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs);
    }
}

// 命中检测：返回该点可交互的所有框索引
function hitTestAll(px, py, w, h) {
    return hitTestAllBoxes(boxes, px, py, w, h);
}

// 对指定框判断具体交互
function hitTestFor(i, px, py, w, h) {
    return hitTestForBox(boxes[i], px, py, w, h);
}

function cursorFor(hit) {
    return cursorForHit(hit);
}

function sortedByNearest(all, px, py, w, h) {
    return sortedByNearestBoxes(boxes, all, px, py, w, h);
}

function localPos(e){
    const r = els.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// 执行移动/缩放
function applyDrag(curX, curY, w, h){
    const d=dragging, b=boxes[d.i];
    const dx=(curX-d.startX)/w, dy=(curY-d.startY)/h;
    if(d.type==="move"){
        const width=d.orig.x2-d.orig.x1, height=d.orig.y2-d.orig.y1;
        const nx1=Math.min(clamp01(d.orig.x1+dx),1-width);
        const ny1=Math.min(clamp01(d.orig.y1+dy),1-height);
        b.x1=nx1; b.y1=ny1; b.x2=nx1+width; b.y2=ny1+height;
    }else{
        const o=d.orig; let x1=o.x1,y1=o.y1,x2=o.x2,y2=o.y2; const c=d.corner;
        if(c.includes("l")) x1=clamp01(o.x1+dx);
        if(c.includes("r")) x2=clamp01(o.x2+dx);
        if(c.includes("t")) y1=clamp01(o.y1+dy);
        if(c.includes("b")) y2=clamp01(o.y2+dy);
        if(x2-x1<MIN_SIZE){ if(c.includes("l")) x1=x2-MIN_SIZE; else x2=x1+MIN_SIZE; }
        if(y2-y1<MIN_SIZE){ if(c.includes("t")) y1=y2-MIN_SIZE; else y2=y1+MIN_SIZE; }
        b.x1=x1; b.y1=y1; b.x2=x2; b.y2=y2;
    }
}

function writeBack(){
    const ta=els.textarea;
    if(!ta) return;
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

// 判断点是否命中选中框左上角的标签文本区域
function hitLabel(px, py, w, h){
    if(selected<0||selected>=boxes.length) return false;
    const b=boxes[selected]; const L=b.x1*w,T=b.y1*h;
    ctx.font="13px sans-serif";
    const tw=ctx.measureText(b.label||"").width;
    const bw2=Math.max(MIN_LABEL_W, tw+6);
    return px>=L&&px<=L+bw2&&py>=T&&py<=T+15;
}

// 打开选中框标签编辑
function openLabelEdit(){
    if(!labelInput||selected<0||selected>=boxes.length) return;
    const b=boxes[selected];
    const cs=getComputedStyle(els.canvas);
    const offX=parseFloat(cs.left)||0, offY=parseFloat(cs.top)||0;
    let w,h;
    if(els.img && els.img.src && els.img.naturalWidth){
        const r=els.img.getBoundingClientRect(); w=r.width; h=r.height;
    } else {
        const r=els.preview.getBoundingClientRect(); const pcs=getComputedStyle(els.preview);
        w = r.width - (parseFloat(pcs.borderLeftWidth)||0) - (parseFloat(pcs.borderRightWidth)||0) - (parseFloat(pcs.paddingLeft)||0) - (parseFloat(pcs.paddingRight)||0);
        h = r.height - (parseFloat(pcs.borderTopWidth)||0) - (parseFloat(pcs.borderBottomWidth)||0) - (parseFloat(pcs.paddingTop)||0) - (parseFloat(pcs.paddingBottom)||0);
    }
    const L=b.x1*w, T=b.y1*h;
    labelInput.value=b.label||"";
    labelInput.style.left=(offX+L)+"px";
    labelInput.style.top=(offY+T)+"px";
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

// 复制当前选中的边界框
function copySelectedBox(){
    if(selected<0||selected>=boxes.length) return;
    const b=boxes[selected]; clipboardBox={label:b.label||"", w:b.x2-b.x1, h:b.y2-b.y1};
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
function setPreviewImage(src){
    if(!els.img) return;
    if(src){
        els.img.src = src;
        els.img.style.display = "block";
    }else{
        els.img.removeAttribute("src");
        els.img.style.display = "none";
    }
    els.img.onload = () => { draw(); };
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
    setPreviewImage("");
    if(els.bgPathLabel) els.bgPathLabel.textContent = "";
}

// 比例控制
function applyRatio(){
    const wInput = els.ratioW, hInput = els.ratioH, preset = els.ratioPreset;
    let w = parseInt(wInput.value,10), h = parseInt(hInput.value,10);
    if(preset && preset.value !== "free" && preset.value !== "custom"){
        const [pw,ph] = preset.value.split(":").map(Number);
        if(pw && ph){ w = pw; h = ph; wInput.value = pw; hInput.value = ph; }
    }
    if(!w || !h){
        els.preview.style.aspectRatio = "";
        els.preview.style.width = "";
        els.preview.style.height = "";
        draw();
        return;
    }
    els.preview.style.aspectRatio = `${w} / ${h}`;
    draw();
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
        ratioApply: document.getElementById("bbox_studio_apply_ratio"),
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

    if(els.ratioApply) els.ratioApply.addEventListener("click", applyRatio);
    if(els.ratioPreset) els.ratioPreset.addEventListener("change", ()=>{
        const v = els.ratioPreset.value;
        if(v==="free"){ els.ratioW.value=""; els.ratioH.value=""; }
        else if(v==="custom"){ }
        else { const [a,b]=v.split(":"); els.ratioW.value=a; els.ratioH.value=b; }
        applyRatio();
    });

    if(els.bgPick) els.bgPick.addEventListener("click", pickBackgroundImage);
    if(els.bgClear) els.bgClear.addEventListener("click", clearBackgroundImage);
    if(els.bgColor) els.bgColor.addEventListener("input", e=> setPreviewBgColor(e.target.value));
    if(els.bgColor) setPreviewBgColor(els.bgColor.value);

    if(els.copyBtn) els.copyBtn.addEventListener("click", async ()=>{
        try{ await navigator.clipboard.writeText(els.textarea.value); }catch(e){ await Neutralino.clipboard.writeText(els.textarea.value).catch(()=>{}); }
    });
    if(els.importBtn) els.importBtn.addEventListener("click", ()=>{
        const src = document.getElementById("dte_edit_caption");
        if(src) { els.textarea.value = src.value; els.textarea.dispatchEvent(new Event("input",{bubbles:true})); }
        else {
            try { Neutralino.storage.getData("bbox_studio_init_text").then(t=>{ if(t && els.textarea){ els.textarea.value = t; els.textarea.dispatchEvent(new Event("input",{bubbles:true})); }}).catch(()=>{}); } catch(e){}
        }
    });
    if(els.clearBtn) els.clearBtn.addEventListener("click", ()=>{
        boxes=[]; selected=-1; draw(); writeBack();
    });
    if(els.clearTextBtn) els.clearTextBtn.addEventListener("click", ()=>{
        if(els.textarea){ els.textarea.value=""; els.textarea.dispatchEvent(new Event("input",{bubbles:true})); }
    });

    const hlRuleTa = document.getElementById("tb_highlight_rules");
    if(hlRuleTa) hlRuleTa.addEventListener("input", updateHighlightOverlay);
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
            const box={label:"", x1:clamp01(nx-half), y1:clamp01(ny-half), x2:clamp01(nx+half), y2:clamp01(ny+half)};
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
                const box = { label: "", x1, y1, x2, y2 };
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
            const box = { label: "", x1, y1, x2, y2 };
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
                    const box = { label: "", x1: clamp01(nx - half), y1: clamp01(ny - half), x2: clamp01(nx + half), y2: clamp01(ny + half) };
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

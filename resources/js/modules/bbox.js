// bbox.js - 从编辑框文本解析归一化边界框，并在原图预览上绘制与交互
// 文本可包含 object / objects 格式的 JSON 块（不要求整段都是 JSON）：
//   数组形式： {"object":[
//   {"white rabbit creature": [0.21,0.41,0.38,0.70]},
//   {"large purple-black monster": [0.46,0.10,0.78,0.86]}
//   ]}
//   映射形式： {"objects":{
//   "物体名1": [0.1, 0.2, 0.15, 0.4],
//   "物体名2": [0.2, 0.3, 0.15, 0.3]
//   }}
// 坐标为归一化的 x1,y1,x2,y2（0~1）。
// 支持拖动整框移动、拖动边缘/角点缩放；重叠框通过多次点击循环切换。
// 编辑后写回的 JSON 块保持展开（多行）格式、小数位数由设置控制，且不干扰 Caption 中其它换行。

import { getSetting } from "./config.js";
import { formatJsonPretty } from "./utils.js";
import { bindAutocomplete } from "./autocomplete.js";

let canvas = null;
let preview = null;
let img = null;
let ctx = null;

let boxes = [];
let selected = -1;
let dragging = null;
let labelInput = null;
let lastClickPos = null;
let lastMousePos = null;
let clipboardBox = null;

let onBboxChange = null;
let rightCreate = null;

export const COLOR_PALETTE = ["#00e5ff", "#ffd54f", "#7ef29a", "#ff8a80", "#ce93d8", "#ffab91"];
export const HANDLE = 8;        // 手柄命中半径（CSS 像素）：鼠标距角点/边缘该距离内即判定命中，应略大于手柄边长 hs
export const MIN_SIZE = 0.01;   // 最小边长（归一化）
export const MIN_LABEL_W = 40;  // 标签背景/命中区域最小宽度（CSS 像素），空标签时仍可点击编辑
export const MIN_EDIT_W = 120;  // 标签编辑输入框最小宽度（CSS 像素）
export const CLICK_TOL = 1;     // 同点点击判定容差（CSS 像素），距离小于该值视为鼠标未移动，用于反复点击循环切换

export function setOnBboxChange(cb) {
    onBboxChange = cb;
}

export function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}

// 从 start（必须指向 '{'）扫描到配对的 '}'，返回 { end } 或 null
export function findBalancedObject(s, start) {
    if (s[start] !== "{") return null;
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
            if (depth === 0) return { end: i };
        }
    }
    return null;
}

// 校验并规范化一组坐标（归一化 x1,y1,x2,y2，范围 0~1）
export function parseCoords(coords) {
    if (!Array.isArray(coords) || coords.length !== 4) return null;
    const nums = coords.map(Number);
    if (!nums.every(n => Number.isFinite(n))) return null;
    return {
        x1: clamp01(nums[0]),
        y1: clamp01(nums[1]),
        x2: clamp01(nums[2]),
        y2: clamp01(nums[3]),
    };
}

// 在文本中查找 object / objects 格式的 JSON 块
// 返回 { start, end, key, isMap, items } 或 null
export function extractBboxBlock(text) {
    const s = String(text || "");
    const re = /\{\s*"(object|objects)"\s*:/g;
    let m;
    while ((m = re.exec(s))) {
        const start = m.index;
        const bal = findBalancedObject(s, start);
        if (!bal) continue;
        const end = bal.end;
        let json;
        try {
            json = JSON.parse(s.slice(start, end + 1));
        } catch (e) {
            continue;
        }
        const key = m[1];
        const raw = json[key];
        const items = [];
        let isMap = false;
        if (Array.isArray(raw)) {
            for (const item of raw) {
                if (!item || typeof item !== "object") continue;
                const entries = Object.entries(item);
                if (entries.length !== 1) continue;
                const [label, coords] = entries[0];
                const box = parseCoords(coords);
                if (box) items.push({ label: String(label), ...box });
            }
        } else if (raw && typeof raw === "object") {
            isMap = true;
            for (const [label, coords] of Object.entries(raw)) {
                const box = parseCoords(coords);
                if (box) items.push({ label: String(label), ...box });
            }
        }
        if (items.length) return { start, end, key, isMap, items };
    }
    return null;
}

// 边界框 JSON 坐标保留的小数位数（来自设置，默认 3 位）
function getBboxPrecision() {
    const v = Number(getSetting("bbox_json_decimal_places"));
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 3;
}

// 将边界框序列化为 JSON 块（小数位数由设置控制，展开为多行，写入时自动交换保证 x1<=x2 y1<=y2）
export function serializeBboxes(list, key = "object", isMap = false) {
    const precision = getBboxPrecision();
    let json;
    if (isMap) {
        const obj = {};
        for (const b of list) {
            const x1 = Math.min(b.x1, b.x2), x2 = Math.max(b.x1, b.x2), y1 = Math.min(b.y1, b.y2), y2 = Math.max(b.y1, b.y2);
            const coords = [x1, y1, x2, y2].map(n => +n.toFixed(precision));
            obj[b.label] = coords;
        }
        json = JSON.stringify({ [key]: obj });
    } else {
        const inner = list.map(b => {
            const x1 = Math.min(b.x1, b.x2), x2 = Math.max(b.x1, b.x2), y1 = Math.min(b.y1, b.y2), y2 = Math.max(b.y1, b.y2);
            const coords = [x1, y1, x2, y2].map(n => +n.toFixed(precision));
            return `{${JSON.stringify(b.label)}:[${coords.join(",")}]}`;
        }).join(",");
        json = `{"${key}":[${inner}]}`;
    }
    return formatJsonPretty(json);
}

// 用当前 boxes 替换文本中的 JSON 块，返回新文本
function writeBackText(text) {
    const block = extractBboxBlock(text);
    if (!block) return text;
    if (boxes.length === 0) {
        return text.slice(0, block.start) + text.slice(block.end + 1);
    }
    return text.slice(0, block.start) + serializeBboxes(boxes, block.key, block.isMap) + text.slice(block.end + 1);
}

// 根据文本更新边界框并重绘
export function updateBboxes() {
    const ta = document.getElementById("dte_edit_caption");
    if (!ta || !preview || !canvas) return;
    cancelLabelEdit();
    const block = extractBboxBlock(ta.value);
    if (block) {
        boxes = block.items;
        if (selected >= boxes.length) selected = -1;
        preview.classList.add("has-bbox");
        draw();
    } else {
        boxes = [];
        selected = -1;
        preview.classList.remove("has-bbox");
        clearCanvas();
    }
}

function clearCanvas() {
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = "none";
}

// 将 canvas 对齐到图像实际显示区域并重绘
function draw() {
    if (!img || !img.src || !img.naturalWidth) { clearCanvas(); return; }
    const imgRect = img.getBoundingClientRect();
    const prevRect = preview.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) { clearCanvas(); return; }
    const cs = getComputedStyle(preview);
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const dpr = window.devicePixelRatio || 1;
    const w = imgRect.width;
    const h = imgRect.height;
    canvas.style.display = "block";
    canvas.style.left = (imgRect.left - prevRect.left - borderLeft - padLeft) + "px";
    canvas.style.top = (imgRect.top - prevRect.top - borderTop - padTop) + "px";
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < boxes.length; i++) {
        if (i === selected) continue;
        drawBox(i, w, h);
    }
    if (selected >= 0) drawBox(selected, w, h);
}

// 绘制单个边界框（支持自由拖动时的坐标交换显示）
function drawBox(i, w, h) {
    const b = boxes[i];
    const L = Math.min(b.x1, b.x2) * w;
    const R = Math.max(b.x1, b.x2) * w;
    const T = Math.min(b.y1, b.y2) * h;
    const B = Math.max(b.y1, b.y2) * h;
    const color = COLOR_PALETTE[i % COLOR_PALETTE.length];
    const isSel = i === selected;

    ctx.strokeStyle = color;
    ctx.lineWidth = isSel ? 4 : 2;
    const lw = ctx.lineWidth;
    ctx.strokeRect(L + lw / 2, T + lw / 2, Math.max(0, R - L - lw), Math.max(0, B - T - lw));

    const label = b.label || "";
    ctx.font = "13px sans-serif";
    const tw = ctx.measureText(label).width;
    const bw = Math.max(MIN_LABEL_W, tw + 6);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(L, T, bw, 15);
    ctx.fillStyle = color;
    ctx.fillText(label, L + 3, T + 11);

    if (isSel) {
        const hs = 6;
        const pts = [
            {x:L, y:T, c:"tl"}, {x:R, y:T, c:"tr"}, {x:L, y:B, c:"bl"}, {x:R, y:B, c:"br"},
            {x:(L + R) / 2, y:T}, {x:(L + R) / 2, y:B},
            {x:L, y:(T + B) / 2}, {x:R, y:(T + B) / 2},
        ];
        for (const p of pts) {
            // 左上角与右下角颜色区分
            if(p.c === "tl") ctx.fillStyle = "#ffffff";
            else if(p.c === "br") ctx.fillStyle = "#ffe082";
            else ctx.fillStyle = "#ffffff";
            ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
            ctx.strokeStyle = "rgba(0,0,0,0.6)";
            ctx.lineWidth = 1;
            ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
        }
    }
}

// 命中检测：返回该点可交互的所有框索引（使用归一化后的显示坐标）
function hitTestAll(px, py, w, h) {
    const list = [];
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const L = Math.min(b.x1, b.x2) * w;
        const R = Math.max(b.x1, b.x2) * w;
        const T = Math.min(b.y1, b.y2) * h;
        const B = Math.max(b.y1, b.y2) * h;
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

// 计算边界框面积（用于最近判定：面积越小越近，支持自由拖动时的负向坐标）
export function boxArea(b) {
    return Math.abs(b.x2 - b.x1) * Math.abs(b.y2 - b.y1);
}

// 命中框按面积小优先排序，面积相近时按中心距离二次排序
function sortedByNearest(all, px, py, w, h) {
    return all.slice().sort((a, b) => {
        const ba = boxes[a], bb = boxes[b];
        const areaA = boxArea(ba);
        const areaB = boxArea(bb);
        if (Math.abs(areaA - areaB) > 1e-6) return areaA - areaB;
        const da = Math.hypot((ba.x1 + ba.x2) / 2 * w - px, (ba.y1 + ba.y2) / 2 * h - py);
        const db = Math.hypot((bb.x1 + bb.x2) / 2 * w - px, (bb.y1 + bb.y2) / 2 * h - py);
        return da - db;
    });
}

// 对指定框判断具体交互：返回 { type:"move" } 或 { type:"resize", corner } 或 null（归一化显示坐标）
function hitTestFor(i, px, py, w, h) {
    const b = boxes[i];
    const L = Math.min(b.x1, b.x2) * w;
    const R = Math.max(b.x1, b.x2) * w;
    const T = Math.min(b.y1, b.y2) * h;
    const B = Math.max(b.y1, b.y2) * h;
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

// 根据命中结果返回指针光标
function cursorFor(hit) {
    if (!hit) return "default";
    if (hit.type === "move") return "move";
    const map = {
        tl: "nwse-resize", br: "nwse-resize",
        tr: "nesw-resize", bl: "nesw-resize",
        l: "ew-resize", r: "ew-resize",
        t: "ns-resize", b: "ns-resize",
    };
    return map[hit.corner] || "default";
}

function localPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// 执行移动/缩放（允许自由拖动，手柄可越过对侧，写入时再交换保证规范化）
function applyDrag(curX, curY, w, h) {
    const d = dragging;
    const b = boxes[d.i];
    const dx = (curX - d.startX) / w;
    const dy = (curY - d.startY) / h;
    if (d.type === "move") {
        const width = Math.abs(d.orig.x2 - d.orig.x1);
        const height = Math.abs(d.orig.y2 - d.orig.y1);
        let nx1 = clamp01(Math.min(d.orig.x1, d.orig.x2) + dx);
        let ny1 = clamp01(Math.min(d.orig.y1, d.orig.y2) + dy);
        nx1 = Math.min(nx1, 1 - width);
        ny1 = Math.min(ny1, 1 - height);
        b.x1 = nx1;
        b.y1 = ny1;
        b.x2 = nx1 + width;
        b.y2 = ny1 + height;
        // 保持原始方向？移动时保持规范化即可
    } else {
        const o = d.orig;
        let x1 = o.x1, y1 = o.y1, x2 = o.x2, y2 = o.y2;
        const c = d.corner;
        if (c.includes("l")) x1 = clamp01(o.x1 + dx);
        if (c.includes("r")) x2 = clamp01(o.x2 + dx);
        if (c.includes("t")) y1 = clamp01(o.y1 + dy);
        if (c.includes("b")) y2 = clamp01(o.y2 + dy);
        b.x1 = x1; b.y1 = y1; b.x2 = x2; b.y2 = y2;
    }
}

// 拖拽结束：将新坐标写回文本框（写入前交换保证规范化）
function writeBack() {
    if (!onBboxChange) return;
    const ta = document.getElementById("dte_edit_caption");
    if (!ta) return;
    for (const b of boxes) {
        if (b.x1 > b.x2) [b.x1, b.x2] = [b.x2, b.x1];
        if (b.y1 > b.y2) [b.y1, b.y2] = [b.y2, b.y1];
    }
    const newText = writeBackText(ta.value);
    if (newText !== ta.value) onBboxChange(newText);
    draw();
}

// 删除当前选中的边界框并写回
function deleteSelectedBox() {
    if (selected < 0 || selected >= boxes.length) return;
    cancelLabelEdit();
    boxes.splice(selected, 1);
    selected = -1;
    draw();
    writeBack();
}

// 判断点是否命中选中框左上角的标签文本区域（归一化坐标）
function hitLabel(px, py, w, h) {
    if (selected < 0 || selected >= boxes.length) return false;
    const b = boxes[selected];
    const L = Math.min(b.x1, b.x2) * w;
    const T = Math.min(b.y1, b.y2) * h;
    ctx.font = "13px sans-serif";
    const tw = ctx.measureText(b.label || "").width;
    const bw = Math.max(MIN_LABEL_W, tw + 6);
    return px >= L && px <= L + bw && py >= T && py <= T + 15;
}

// 打开选中框标签编辑（左上角，归一化坐标）
function openLabelEdit() {
    if (!labelInput || selected < 0 || selected >= boxes.length) return;
    const b = boxes[selected];
    const imgRect = img.getBoundingClientRect();
    const w = imgRect.width;
    const h = imgRect.height;
    const L = Math.min(b.x1, b.x2) * w;
    const T = Math.min(b.y1, b.y2) * h;
    const cs = getComputedStyle(canvas);
    const offX = parseFloat(cs.left) || 0;
    const offY = parseFloat(cs.top) || 0;
    labelInput.value = b.label || "";
    labelInput.style.left = (offX + L) + "px";
    labelInput.style.top = (offY + T) + "px";
    ctx.font = "13px sans-serif";
    const tw = ctx.measureText(labelInput.value || "").width;
    labelInput.style.width = (Math.max(MIN_EDIT_W, tw) + 24) + "px";
    labelInput.style.display = "block";
    labelInput.focus();
    labelInput.select();
}

// 提交标签编辑
function commitLabelEdit() {
    if (!labelInput || labelInput.style.display === "none") return;
    const val = labelInput.value.trim();
    labelInput.style.display = "none";
    if (selected >= 0 && selected < boxes.length && val) {
        boxes[selected].label = val;
        draw();
        writeBack();
    }
}

function cancelLabelEdit() {
    if (!labelInput) return;
    labelInput.style.display = "none";
}

// 复制当前选中的边界框（归一化宽度）
function copySelectedBox() {
    if (selected < 0 || selected >= boxes.length) return;
    const b = boxes[selected];
    clipboardBox = {
        label: b.label || "",
        w: Math.abs(b.x2 - b.x1),
        h: Math.abs(b.y2 - b.y1),
    };
}

// 生成不与现有标签重复的标签
function uniqueLabel(base) {
    const names = new Set(boxes.map(b => b.label));
    if (!names.has(base)) return base;
    const m = String(base).match(/_(\d+)$/);
    const prefix = m ? base.replace(/_(\d+)$/, "") : base;
    let n = m ? parseInt(m[1], 10) + 1 : 2;
    let candidate = prefix + "_" + n;
    while (names.has(candidate)) {
        n++;
        candidate = prefix + "_" + n;
    }
    return candidate;
}

// 以鼠标位置为中心粘贴复制框
function pasteClipboardBox() {
    if (!clipboardBox) return;
    const imgRect = img.getBoundingClientRect();
    const w = imgRect.width;
    const h = imgRect.height;
    if (w <= 0 || h <= 0) return;
    const cx = lastMousePos ? lastMousePos.x : w / 2;
    const cy = lastMousePos ? lastMousePos.y : h / 2;
    const bw = Math.min(clipboardBox.w, 1);
    const bh = Math.min(clipboardBox.h, 1);
    const nx = cx / w;
    const ny = cy / h;
    const box = {
        label: uniqueLabel(clipboardBox.label),
        x1: clamp01(nx - bw / 2),
        y1: clamp01(ny - bh / 2),
        x2: clamp01(nx + bw / 2),
        y2: clamp01(ny + bh / 2),
    };
    boxes.push(box);
    selected = boxes.length - 1;
    draw();
    writeBack();
}

// 初始化：绑定画布与交互事件
export function initBbox() {
    canvas = document.getElementById("bbox_canvas");
    preview = document.getElementById("image_preview");
    img = document.getElementById("preview_img");
    if (!canvas || !preview || !img) return;
    ctx = canvas.getContext("2d");
    labelInput = document.getElementById("bbox_label_input");
    canvas.tabIndex = 0;
    canvas.addEventListener("keydown", (e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) {
            e.preventDefault();
            deleteSelectedBox();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === "c" && selected >= 0) {
            e.preventDefault();
            copySelectedBox();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === "v" && clipboardBox) {
            e.preventDefault();
            pasteClipboardBox();
        }
    });
    if (labelInput) {
        bindAutocomplete(labelInput, { appendComma: false });
        labelInput.addEventListener("mousedown", (e) => e.stopPropagation());
        labelInput.addEventListener("dblclick", (e) => e.stopPropagation());
        labelInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                commitLabelEdit();
            } else if (e.key === "Escape") {
                e.preventDefault();
                cancelLabelEdit();
            }
        });
        labelInput.addEventListener("blur", () => { if (labelInput.isConnected) commitLabelEdit(); });
    }

    let raf = 0;
    const scheduleDraw = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            if (boxes.length) draw();
            else clearCanvas();
        });
    };

    img.addEventListener("load", scheduleDraw);
    img.addEventListener("error", scheduleDraw);
    window.addEventListener("resize", scheduleDraw);
    if (window.ResizeObserver) {
        new ResizeObserver(scheduleDraw).observe(preview);
    }

    // 点击 preview 空白区域取消选中
    preview.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target === canvas || e.target === labelInput) return;
        if (selected < 0) return;
        const { x, y } = localPos(e);
        const imgRect = img.getBoundingClientRect();
        const w = imgRect.width, h = imgRect.height;
        if (w <= 0 || h <= 0) { selected = -1; dragging = null; draw(); return; }
        const all = hitTestAll(x, y, w, h);
        if (all.length === 0) {
            selected = -1;
            dragging = null;
            draw();
        }
    });

    canvas.addEventListener("mousedown", (e) => {
        if (e.button === 2) {
            e.preventDefault();
            e.stopPropagation();
            if (boxes.length === 0) return;
            const { x, y } = localPos(e);
            const imgRect = img.getBoundingClientRect();
            const w = imgRect.width, h = imgRect.height;
            if (w <= 0 || h <= 0) return;
            rightCreate = { startX: x, startY: y, w, h, idx: -1, moved: false };
            document.body.style.userSelect = "none";
            return;
        }
        e.preventDefault();
        canvas.focus();
        if (e.button !== 0) return;
        if (boxes.length === 0) return;
        const { x, y } = localPos(e);
        const imgRect = img.getBoundingClientRect();
        const w = imgRect.width;
        const h = imgRect.height;
        const all = hitTestAll(x, y, w, h);
        const isSamePoint = !!(lastClickPos && Math.hypot(x - lastClickPos.x, y - lastClickPos.y) < CLICK_TOL);
        lastClickPos = { x, y };
        if (all.length === 0) {
            selected = -1;
            dragging = null;
            draw();
            return;
        }
        const sorted = sortedByNearest(all, x, y, w, h);
        let target;
        let pending = null;
        const wasOnSelected = all.indexOf(selected) >= 0;
        const hitOnSelected = wasOnSelected ? hitTestFor(selected, x, y, w, h) : null;
        if (wasOnSelected && hitOnSelected?.type === "resize") {
            target = selected;
        } else if (isSamePoint && wasOnSelected && sorted.length > 1) {
            const ci = sorted.indexOf(selected);
            target = sorted[(ci + 1) % sorted.length];
        } else if (wasOnSelected && hitOnSelected) {
            // 鼠标移动后从最小开始选，但需保留拖动优先：mousedown先保持原选中用于拖动，
            // 若最终未拖动（纯点击）则在 mouseup 切换到最小
            target = selected;
            pending = sorted[0];
            if (pending === selected) pending = null;
        } else {
            target = sorted[0];
        }
        // pending 存在时先不切换，留到 mouseup 纯点击时再切换，避免拖动时误切
        if (pending === null) selected = target;
        e.stopPropagation();
        const hit = hitTestFor(target, x, y, w, h);
        if (!hit) { draw(); return; }
        const b = boxes[target];
        dragging = {
            i: target,
            type: hit.type,
            corner: hit.corner,
            startX: x,
            startY: y,
            moved: false,
            pending,
            orig: { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 },
        };
        document.body.style.userSelect = "none";
        draw();
    });

    canvas.addEventListener("mousemove", (e) => {
        const imgRect = img.getBoundingClientRect();
        const w = imgRect.width;
        const h = imgRect.height;
        const { x, y } = localPos(e);
        lastMousePos = { x, y };
        if (dragging) {
            if (Math.hypot(x - dragging.startX, y - dragging.startY) > 3) dragging.moved = true;
            if (dragging.moved) {
                applyDrag(x, y, w, h);
                draw();
            }
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
        if (preview.classList.contains("dragging-image")) return;
        if (boxes.length === 0) return;
        const all = hitTestAll(x, y, w, h);
        if (all.length === 0) { canvas.style.cursor = "default"; return; }
        let target;
        const wasOnSelected = all.indexOf(selected) >= 0;
        const hitOnSelected = wasOnSelected ? hitTestFor(selected, x, y, w, h) : null;
        if (hitOnSelected) {
            target = selected;
        } else {
            target = sortedByNearest(all, x, y, w, h)[0];
        }
        canvas.style.cursor = cursorFor(hitTestFor(target, x, y, w, h));
    });

    canvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
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

    window.addEventListener("mouseup", (e) => {
        if (rightCreate) {
            const rc = rightCreate;
            rightCreate = null;
            document.body.style.userSelect = "";
            if (e.button === 2 || rc.moved) {
                if (!rc.moved) {
                    const nx = rc.startX / rc.w, ny = rc.startY / rc.h, half = 0.05;
                    const box = { label: "", x1: clamp01(nx - half), y1: clamp01(ny - half), x2: clamp01(nx + half), y2: clamp01(ny + half) };
                    boxes.push(box);
                    selected = boxes.length - 1;
                    draw();
                    writeBack();
                } else {
                    if (rc.idx >= 0) {
                        const b = boxes[rc.idx];
                        if ((b.x2 - b.x1) < MIN_SIZE || (b.y2 - b.y1) < MIN_SIZE) {
                            boxes.splice(rc.idx, 1);
                            selected = -1;
                        } else {
                            selected = rc.idx;
                        }
                        draw();
                        writeBack();
                    }
                }
                return;
            }
        }
        if (!dragging) return;
        const d = dragging;
        dragging = null;
        document.body.style.userSelect = "";
        canvas.style.cursor = "default";
        if (d.moved) {
            writeBack();
            return;
        }
        // 纯点击：若 mousedown 时保留了 pending（鼠标在已选中框内移动后点击），此时切换到最小
        if (d.pending !== null && d.pending !== selected) {
            selected = d.pending;
            draw();
            // 切换后若点击在标签上则进入编辑
            const imgRect = img.getBoundingClientRect();
            if (hitLabel(d.startX, d.startY, imgRect.width, imgRect.height)) {
                openLabelEdit();
            }
            return;
        }
        if (d.i === selected) {
            const imgRect = img.getBoundingClientRect();
            if (hitLabel(d.startX, d.startY, imgRect.width, imgRect.height)) {
                openLabelEdit();
                return;
            }
        }
    });
}

// ---- 供 bboxStudio 复用的纯函数（无内部状态依赖） ----
export function hitTestAllBoxes(boxList, px, py, w, h) {
    const list = [];
    for (let i = 0; i < boxList.length; i++) {
        const b = boxList[i];
        const L = Math.min(b.x1, b.x2) * w, R = Math.max(b.x1, b.x2) * w, T = Math.min(b.y1, b.y2) * h, B = Math.max(b.y1, b.y2) * h;
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

export function hitTestForBox(box, px, py, w, h) {
    const L = Math.min(box.x1, box.x2) * w, R = Math.max(box.x1, box.x2) * w, T = Math.min(box.y1, box.y2) * h, B = Math.max(box.y1, box.y2) * h;
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

export function sortedByNearestBoxes(boxList, all, px, py, w, h) {
    return all.slice().sort((a, b) => {
        const ba = boxList[a], bb = boxList[b];
        const areaA = boxArea(ba), areaB = boxArea(bb);
        if (Math.abs(areaA - areaB) > 1e-6) return areaA - areaB;
        const da = Math.hypot((ba.x1 + ba.x2) / 2 * w - px, (ba.y1 + ba.y2) / 2 * h - py);
        const db = Math.hypot((bb.x1 + bb.x2) / 2 * w - px, (bb.y1 + bb.y2) / 2 * h - py);
        return da - db;
    });
}

export function cursorForHit(hit) {
    if (!hit) return "default";
    if (hit.type === "move") return "move";
    const map = { tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", l: "ew-resize", r: "ew-resize", t: "ns-resize", b: "ns-resize" };
    return map[hit.corner] || "default";
}

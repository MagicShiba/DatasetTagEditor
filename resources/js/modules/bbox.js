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

// 每帧绘制所依赖的元素
let canvas = null;
let preview = null;
let img = null;
let ctx = null;

// 当前解析出的边界框列表 [{ label, x1, y1, x2, y2 }]
let boxes = [];
// 当前选中的框索引（-1 表示未选中）
let selected = -1;
// 进行中的拖动交互状态
let dragging = null;
// 标签编辑输入框（选中框左上角文本编辑）
let labelInput = null;

// 拖拽结束后写回文本框的回调（由 ui.js 注入，避免循环依赖）
let onBboxChange = null;

const COLOR_PALETTE = ["#00e5ff", "#ffd54f", "#7ef29a", "#ff8a80", "#ce93d8", "#ffab91"];
const HANDLE = 8;        // 手柄命中半径（CSS 像素）：鼠标距角点/边缘该距离内即判定命中，应略大于手柄边长 hs
const MIN_SIZE = 0.01;   // 最小边长（归一化）
const MIN_LABEL_W = 40;  // 标签背景/命中区域最小宽度（CSS 像素），空标签时仍可点击编辑
const MIN_EDIT_W = 120;  // 标签编辑输入框最小宽度（CSS 像素）

// 注入写回回调：onBboxChange(text)
export function setOnBboxChange(cb) {
    onBboxChange = cb;
}

function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}

// 从 start（必须指向 '{'）扫描到配对的 '}'，返回 { end } 或 null
function findBalancedObject(s, start) {
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
function parseCoords(coords) {
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
// 返回 { start, end, key, isMap, items } 或 null（start/end 为块在文本中的起止下标，含花括号）
// 支持两种结构：
//   数组形式 {"object": [{"label":[x1,y1,x2,y2]}, ...]}
//   映射形式 {"objects": {"label":[x1,y1,x2,y2], ...}}   （isMap 为 true）
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
            // 数组形式：每个元素是 {"label":[x1,y1,x2,y2]}
            for (const item of raw) {
                if (!item || typeof item !== "object") continue;
                const entries = Object.entries(item);
                if (entries.length !== 1) continue;
                const [label, coords] = entries[0];
                const box = parseCoords(coords);
                if (box) items.push({ label: String(label), ...box });
            }
        } else if (raw && typeof raw === "object") {
            // 映射形式：{"label":[x1,y1,x2,y2], ...}
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

// 将边界框序列化为 JSON 块（小数位数由设置控制，isMap 为 true 时输出映射形式，否则输出数组形式）。
// 最终压缩由"自动压缩 json"设置项在应用更改时统一处理。
export function serializeBboxes(list, key = "object", isMap = false) {
    const precision = getBboxPrecision();
    let json;
    if (isMap) {
        const obj = {};
        for (const b of list) {
            const coords = [b.x1, b.y1, b.x2, b.y2].map(n => +n.toFixed(precision));
            obj[b.label] = coords;
        }
        json = JSON.stringify({ [key]: obj });
    } else {
        const inner = list.map(b => {
            const coords = [b.x1, b.y1, b.x2, b.y2].map(n => +n.toFixed(precision));
            return `{${JSON.stringify(b.label)}:[${coords.join(",")}]}`;
        }).join(",");
        json = `{"${key}":[${inner}]}`;
    }
    // 展开为多行格式写回编辑框
    return formatJsonPretty(json);
}

// 用当前 boxes 替换文本中的 JSON 块，返回新文本（保留块外的其它内容与换行，且保持原格式）
function writeBackText(text) {
    const block = extractBboxBlock(text);
    if (!block) return text;
    if (boxes.length === 0) {
        // 删除最后一个框后移除文本中的 JSON 块
        return text.slice(0, block.start) + text.slice(block.end + 1);
    }
    return text.slice(0, block.start) + serializeBboxes(boxes, block.key, block.isMap) + text.slice(block.end + 1);
}

// 根据文本更新边界框并重绘
export function updateBboxes() {
    const ta = document.getElementById("dte_edit_caption");
    if (!ta || !preview || !canvas) return;
    // 切换图像/文本变化时关闭未完成的标签编辑
    cancelLabelEdit();
    const block = extractBboxBlock(ta.value);
    if (block) {
        boxes = block.items;
        // 保留上次的选中状态，越界则取消选中（首次或切换后由点击决定选中）
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

// 清除画布
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
    // canvas 为绝对定位，其 left/top 相对 preview 的 padding box 原点（border 内侧）；
    // 而 getBoundingClientRect 返回的是 border box。若不减去 border 与 padding，
    // 画布会整体偏移 border 宽度，导致 x1/y1=0 时边框线不贴图像边界
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
        drawBox(i, w, h);
    }
}

// 绘制单个边界框（画布坐标按 CSS 像素计算）
function drawBox(i, w, h) {
    const b = boxes[i];
    const L = b.x1 * w;
    const R = b.x2 * w;
    const T = b.y1 * h;
    const B = b.y2 * h;
    const color = COLOR_PALETTE[i % COLOR_PALETTE.length];
    const isSel = i === selected;

    ctx.strokeStyle = color;
    // 边界框描边宽度（CSS 像素，经 dpr 缩放后绘制）：未选中 2px，选中 4px
    ctx.lineWidth = isSel ? 4 : 2;
    // 描边线以路径为中心绘制，若直接用 (L,T) 绘制，x1=0 时线条会向左溢出一半线宽（不贴边），
    // x2=1 时右侧同样向外溢出出界。因此向内缩进半个线宽，使四条边正好贴合图像边界
    const lw = ctx.lineWidth;
    ctx.strokeRect(L + lw / 2, T + lw / 2, Math.max(0, R - L - lw), Math.max(0, B - T - lw));

    // 标签：框内左上角（背景/命中区域有最小宽度，空标签时仍可点击编辑）
    const label = b.label || "";
    ctx.font = "13px sans-serif";
    const tw = ctx.measureText(label).width;
    const bw = Math.max(MIN_LABEL_W, tw + 6);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(L, T, bw, 15);
    ctx.fillStyle = color;
    ctx.fillText(label, L + 3, T + 11);

    // 选中框绘制 8 个手柄
    if (isSel) {
        const hs = 6; // 手柄尺寸：选中框方形手柄的边长（CSS 像素），命中检测半径见下方 HANDLE 常量
        const pts = [
            [L, T], [R, T], [L, B], [R, B],           // 角点
            [(L + R) / 2, T], [(L + R) / 2, B],        // 上/下边中点
            [L, (T + B) / 2], [R, (T + B) / 2],        // 左/右边中点
        ];
        ctx.fillStyle = "#fff";
        for (const [hx, hy] of pts) {
            ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        }
    }
}

// 命中检测：返回该点可交互的所有框索引（自下而上，底层在前、顶层在后）
function hitTestAll(px, py, w, h) {
    const list = [];
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const L = b.x1 * w;
        const R = b.x2 * w;
        const T = b.y1 * h;
        const B = b.y2 * h;
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

// 对指定框判断具体交互：返回 { type:"move" } 或 { type:"resize", corner } 或 null
function hitTestFor(i, px, py, w, h) {
    const b = boxes[i];
    const L = b.x1 * w;
    const R = b.x2 * w;
    const T = b.y1 * h;
    const B = b.y2 * h;
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

// 执行移动/缩放：curX/curY 为当前 CSS 像素，w/h 为图像 CSS 尺寸
function applyDrag(curX, curY, w, h) {
    const d = dragging;
    const b = boxes[d.i];
    const dx = (curX - d.startX) / w;
    const dy = (curY - d.startY) / h;
    if (d.type === "move") {
        // 保持框的宽高，整体平移，到达边界时停止
        const width = d.orig.x2 - d.orig.x1;
        const height = d.orig.y2 - d.orig.y1;
        const nx1 = Math.min(clamp01(d.orig.x1 + dx), 1 - width);
        const ny1 = Math.min(clamp01(d.orig.y1 + dy), 1 - height);
        b.x1 = nx1;
        b.y1 = ny1;
        b.x2 = nx1 + width;
        b.y2 = ny1 + height;
    } else {
        // 缩放：按角点/边缘更新对应边
        const o = d.orig;
        let x1 = o.x1, y1 = o.y1, x2 = o.x2, y2 = o.y2;
        const c = d.corner;
        if (c.includes("l")) x1 = clamp01(o.x1 + dx);
        if (c.includes("r")) x2 = clamp01(o.x2 + dx);
        if (c.includes("t")) y1 = clamp01(o.y1 + dy);
        if (c.includes("b")) y2 = clamp01(o.y2 + dy);
        // 保证最小尺寸
        if (x2 - x1 < MIN_SIZE) { if (c.includes("l")) x1 = x2 - MIN_SIZE; else x2 = x1 + MIN_SIZE; }
        if (y2 - y1 < MIN_SIZE) { if (c.includes("t")) y1 = y2 - MIN_SIZE; else y2 = y1 + MIN_SIZE; }
        b.x1 = x1; b.y1 = y1; b.x2 = x2; b.y2 = y2;
    }
}

// 拖拽结束：将新坐标写回文本框（不改变块外内容）
function writeBack() {
    if (!onBboxChange) return;
    const ta = document.getElementById("dte_edit_caption");
    if (!ta) return;
    const newText = writeBackText(ta.value);
    if (newText !== ta.value) onBboxChange(newText);
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

// 判断点是否命中选中框左上角的标签文本区域
function hitLabel(px, py, w, h) {
    if (selected < 0 || selected >= boxes.length) return false;
    const b = boxes[selected];
    const L = b.x1 * w;
    const T = b.y1 * h;
    ctx.font = "13px sans-serif";
    const tw = ctx.measureText(b.label || "").width;
    const bw = Math.max(MIN_LABEL_W, tw + 6);
    return px >= L && px <= L + bw && py >= T && py <= T + 15;
}

// 打开选中框标签编辑（左上角），定位输入框并聚焦（支持自动补全）
function openLabelEdit() {
    if (!labelInput || selected < 0 || selected >= boxes.length) return;
    const b = boxes[selected];
    const imgRect = img.getBoundingClientRect();
    const w = imgRect.width;
    const h = imgRect.height;
    const L = b.x1 * w;
    const T = b.y1 * h;
    // 输入框相对 preview 绝对定位，需叠加画布相对 preview 的偏移
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

// 提交标签编辑：非空则更新选中框标签并写回
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

// 取消标签编辑
function cancelLabelEdit() {
    if (!labelInput) return;
    labelInput.style.display = "none";
}

// 初始化：绑定画布与交互事件
export function initBbox() {
    canvas = document.getElementById("bbox_canvas");
    preview = document.getElementById("image_preview");
    img = document.getElementById("preview_img");
    if (!canvas || !preview || !img) return;
    ctx = canvas.getContext("2d");
    labelInput = document.getElementById("bbox_label_input");
    // 画布可聚焦，以便在画布上按 Delete/Backspace 删除选中边界框
    canvas.tabIndex = 0;
    canvas.addEventListener("keydown", (e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) {
            e.preventDefault();
            deleteSelectedBox();
        }
    });
    // 标签编辑输入框：Enter 提交 / Esc 取消 / 失焦提交（DOM 移除触发的 blur 除外）
    if (labelInput) {
        bindAutocomplete(labelInput, { appendComma: false });
        // 阻止鼠标事件冒泡到预览容器，否则左键会触发"拖动图像"，导致无法选中文本/移动光标
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

    // 图像加载完成 / 容器尺寸变化时重新对齐画布
    img.addEventListener("load", scheduleDraw);
    img.addEventListener("error", scheduleDraw);
    window.addEventListener("resize", scheduleDraw);
    if (window.ResizeObserver) {
        new ResizeObserver(scheduleDraw).observe(preview);
    }

    // 鼠标交互
    canvas.addEventListener("mousedown", (e) => {
        e.preventDefault();
        canvas.focus();
        // 仅左键进行边界框编辑；中键等交给图像平移
        if (e.button !== 0) return;
        if (boxes.length === 0) return;
        const { x, y } = localPos(e);
        const imgRect = img.getBoundingClientRect();
        const w = imgRect.width;
        const h = imgRect.height;
        const all = hitTestAll(x, y, w, h);
        if (all.length === 0) {
            selected = -1;
            dragging = null;
            draw();
            return;
        }
        // 已选中的框也在该点：直接操作它（拖动/缩放），不做切换；
        // 否则选中最上层
        const ci = all.indexOf(selected);
        const target = ci >= 0 ? selected : all[all.length - 1];
        selected = target;
        // 命中边界框：交给画布交互处理，阻止事件冒泡（避免触发图像平移）
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
            clickAll: all,
            wasSelected: ci >= 0,
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
        if (dragging) {
            // 超过阈值才视为拖动，纯点击用于循环切换重叠框
            if (Math.hypot(x - dragging.startX, y - dragging.startY) > 3) dragging.moved = true;
            if (dragging.moved) {
                applyDrag(x, y, w, h);
                draw();
            }
            return;
        }
        // 图像平移拖动中，跳过画布光标更新
        if (preview.classList.contains("dragging-image")) return;
        if (boxes.length === 0) return;
        const all = hitTestAll(x, y, w, h);
        // 与 mousedown 的目标选择保持一致：选中的框也在该点则按它判定，否则按最上层框判定。
        // 否则重叠时下层框边缘/手柄会因上层框遮挡而错误显示移动光标
        if (all.length === 0) { canvas.style.cursor = "default"; return; }
        const ci = all.indexOf(selected);
        const target = ci >= 0 ? selected : all[all.length - 1];
        canvas.style.cursor = cursorFor(hitTestFor(target, x, y, w, h));
    });

    // 右键点击创建新边界框（以鼠标为中心、归一化宽高 0.1），有边界框时才允许
    canvas.addEventListener("contextmenu", (e) => {
        if (boxes.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const { x, y } = localPos(e);
        const imgRect = img.getBoundingClientRect();
        const w = imgRect.width;
        const h = imgRect.height;
        if (w <= 0 || h <= 0) return;
        const nx = x / w;
        const ny = y / h;
        const half = 0.05;
        const box = {
            label: "",
            x1: clamp01(nx - half),
            y1: clamp01(ny - half),
            x2: clamp01(nx + half),
            y2: clamp01(ny + half),
        };
        boxes.push(box);
        selected = boxes.length - 1;
        draw();
        writeBack();
    });

    window.addEventListener("mouseup", (e) => {
        if (!dragging) return;
        const d = dragging;
        dragging = null;
        document.body.style.userSelect = "";
        canvas.style.cursor = "default";
        if (d.moved) {
            // 拖动完成：写回文本框
            writeBack();
            return;
        }
        // 纯点击：点击选中框左上角的标签文本则进入编辑
        if (d.i === selected) {
            const imgRect = img.getBoundingClientRect();
            if (hitLabel(d.startX, d.startY, imgRect.width, imgRect.height)) {
                openLabelEdit();
                return;
            }
        }
        // 纯点击：若之前选中的框在该点且存在重叠，则循环切换到下一层
        if (d.wasSelected && d.clickAll.length > 1) {
            const ci = d.clickAll.indexOf(d.i);
            selected = d.clickAll[(ci + 1) % d.clickAll.length];
            draw();
        }
        // 否则保持当前选中的框（首次点击选中该点最上层框）
    });
}

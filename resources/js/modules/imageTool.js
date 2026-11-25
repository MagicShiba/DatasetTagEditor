// imageTool.js - 图像分辨率调整：缩放（多种重采样核）与裁剪
// 所有重采样均为本地实现，无网络依赖、无第三方库。

import * as api from "./api.js";
import { t } from "./i18n.js";
import { setupPopup, showPopup } from "./popup.js";
import { getExtension, withSuffix } from "./utils.js";
import { getSetting, setSetting, settings, parseImageSize } from "./config.js";

const STEP = 64;
const MAX_SIZE = 10000;
// 预览单帧像素上限：目标尺寸很大时预览按比例降采样，避免画布与重采样内存暴涨
const MAX_PREVIEW_PIXELS = 4000000;
const ALGOS = ["nearest", "bicubic", "mitchell", "lanczos", "lanczos3"];

let srcImage = null;
let srcData = null;
let srcW = 0;
let srcH = 0;
let srcPath = "";
let srcExt = ""; // 原图扩展名（小写、不含点），如 "jpg" / "webp"
let objectUrl = "";

let mode = "scale";
let targetW = 0;
let targetH = 0;
let lockRatio = true;
let algorithm = "lanczos";
let crop = { x: 0, y: 0, w: 0, h: 0 };
let cropTouched = false;
let onApplied = null;
let popupPinned = false;
let previewTimer = 0;
let dragState = null;
let zoom = 1;
let pan = { x: 0, y: 0 };
let panDrag = null;
const PRESET_SIZES = Array.from({ length: 13 }, (_, i) => 512 + i * 128);

// 按 id 取元素（本模块高频使用，简写以减少噪音）
const $ = (id) => document.getElementById(id);

// ------------------------------ 重采样核 ------------------------------

function sinc(x) {
    if (x === 0) return 1;
    const v = Math.PI * x;
    return Math.sin(v) / v;
}

function kernelWeight(kind, x) {
    const a = Math.abs(x);
    switch (kind) {
        case "bicubic": {
            // Catmull-Rom (a = -0.5)
            const b = -0.5;
            if (a < 1) return ((1.5 + b) * a * a * a - (2.5 + b) * a * a + 1);
            if (a < 2) return (b * a * a * a - 5 * b * a * a + 8 * b * a - 4 * b);
            return 0;
        }
        case "mitchell": {
            const B = 1 / 3, C = 1 / 3;
            if (a < 1) {
                return ((12 - 9 * B - 6 * C) * a * a * a
                    + (-18 + 12 * B + 6 * C) * a * a
                    + (6 - 2 * B)) / 6;
            }
            if (a < 2) {
                return ((-B - 6 * C) * a * a * a
                    + (6 * B + 30 * C) * a * a
                    + (-12 * B - 48 * C) * a
                    + (8 * B + 24 * C)) / 6;
            }
            return 0;
        }
        case "lanczos":
        case "lanczos3": {
            const support = kind === "lanczos3" ? 3 : 2;
            if (a >= support) return 0;
            if (a === 0) return 1;
            return sinc(a) * sinc(a / support);
        }
        default:
            return 0;
    }
}

function kernelSupport(kind) {
    if (kind === "lanczos3") return 3;
    if (kind === "nearest") return 0;
    return 2;
}

const clampInt = (v, min, max) => Math.max(min, Math.min(max, Math.round(v)));
// 箭头按钮按 64 像素网格对齐：先把当前值吸附到最近的 64 倍数，再加减 64
const snap64 = (v) => Math.round(v / STEP) * STEP;

function nearestResize(src, sw, sh, dw, dh) {
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
        for (let x = 0; x < dw; x++) {
            const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw));
            const si = (sy * sw + sx) * 4;
            const di = (y * dw + x) * 4;
            out[di] = src[si];
            out[di + 1] = src[si + 1];
            out[di + 2] = src[si + 2];
            out[di + 3] = src[si + 3];
        }
    }
    return out;
}

// 一维卷积：src 为直 Alpha RGBA，输出直 Alpha RGBA
// 缩小时按采样率展宽核支持域（等效低通），避免直接抽样造成的锯齿/摩尔纹
function convolveAxis(src, sw, sh, dw, dh, kind, horizontal) {
    const out = new Uint8ClampedArray(dw * dh * 4);
    const inSize = horizontal ? sw : sh;
    const outSize = horizontal ? dw : dh;
    const outer = horizontal ? sh : dw;
    const scale = Math.max(1, inSize / outSize);
    const taps = Math.ceil(kernelSupport(kind) * scale);

    for (let o = 0; o < outer; o++) {
        for (let i = 0; i < outSize; i++) {
            const center = (i + 0.5) * inSize / outSize - 0.5;
            const base = Math.floor(center);
            let sumR = 0, sumG = 0, sumB = 0, sumA = 0, sumW = 0;
            for (let k = base - taps; k <= base + taps; k++) {
                const s = Math.max(0, Math.min(inSize - 1, k));
                const w = kernelWeight(kind, (center - k) / scale);
                if (w === 0) continue;
                const si = horizontal ? (o * sw + s) * 4 : (s * dw + o) * 4;
                const alpha = src[si + 3] / 255;
                sumR += src[si] * alpha * w;
                sumG += src[si + 1] * alpha * w;
                sumB += src[si + 2] * alpha * w;
                sumA += alpha * w;
                sumW += w;
            }
            const di = horizontal ? (o * dw + i) * 4 : (i * dw + o) * 4;
            // 负瓣核（Lanczos/Mitchell）可能出现近零或负的权重和，此时按透明处理
            if (sumA <= 1e-6 || sumW === 0) {
                out[di] = out[di + 1] = out[di + 2] = out[di + 3] = 0;
            } else {
                out[di] = sumR / sumA;
                out[di + 1] = sumG / sumA;
                out[di + 2] = sumB / sumA;
                out[di + 3] = (sumA / sumW) * 255;
            }
        }
    }
    return out;
}

// 双通道分离卷积重采样，返回直 Alpha RGBA
function resample(src, sw, sh, dw, dh, kind) {
    if (dw === sw && dh === sh) return new Uint8ClampedArray(src);
    if (!ALGOS.includes(kind)) kind = "lanczos";
    if (kind === "nearest") return nearestResize(src, sw, sh, dw, dh);
    const tmp = convolveAxis(src, sw, sh, dw, sh, kind, true);
    return convolveAxis(tmp, dw, sh, dw, dh, kind, false);
}

// ------------------------------ 工具函数 ------------------------------

// 提示统一走应用内 Toast（由 ui.js 注入），浮窗内不再保留状态栏
let notify = null;

function toast(message, type = "info") {
    if (!message) return;
    if (notify) notify(message, type);
    else console.warn("[imageTool]", message);
}

function clampSize(v) {
    return clampInt(v, 1, MAX_SIZE);
}

// 原图扩展名（小写、不含点）；无扩展名时返回空串
function formatFromPath(path) {
    return getExtension(String(path || "")).slice(1).toLowerCase();
}

function selectedFormat() {
    const v = document.querySelector('input[name="it_format"]:checked')?.value || "follow";
    if (v === "jpg" || v === "png") return v;
    // 跟随原图：只有 jpg/png 能按原格式编码，其它格式（webp/bmp 等）统一输出 PNG
    return srcExt === "jpg" || srcExt === "jpeg" ? "jpg" : "png";
}

function outputExt() {
    return selectedFormat() === "jpg" ? ".jpg" : ".png";
}

// 编码格式与原后缀一致时才允许原地写回，否则必须改扩展名，避免后缀与图像字节不符
function canWriteInPlace(ext) {
    if (ext === ".jpg") return srcExt === "jpg" || srcExt === "jpeg";
    return srcExt === "png";
}

function defaultOutputPath(path) {
    const ext = outputExt();
    if (!path) return `image_tool_output${ext}`;
    return withSuffix(String(path).replace(/\\/g, "/"), `_resized${ext}`);
}

function syncInputs() {
    const w = $("it_width"), h = $("it_height");
    if (w) w.value = targetW;
    if (h) h.value = targetH;
    if (mode === "crop") syncCropInputs();
    syncSizePresets();
}

function syncCropInputs() {
    const x = $("it_x"), y = $("it_y");
    if (x) x.value = crop.x;
    if (y) y.value = crop.y;
}

function syncFromCrop() {
    targetW = Math.max(1, crop.w);
    targetH = Math.max(1, crop.h);
    syncInputs();
}

// ------------------------------ 预览绘制 ------------------------------
// 预览使用「视口画布」：canvas 恒等于预览区大小，图像按 fitScale × zoom 绘制进去。
// 缩放只影响绘制参数，不产生超大图层，显存占用恒定（不会放大后白屏/卡顿）。

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 16;

// 预览用尺寸：超过像素上限时按比例缩小，避免超大目标尺寸撑爆内存
function previewSize(w, h) {
    const px = w * h;
    if (px <= MAX_PREVIEW_PIXELS) return { w, h };
    const s = Math.sqrt(MAX_PREVIEW_PIXELS / px);
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// 缩放结果位图缓存：只有目标尺寸/算法变化时才重新重采样，缩放与平移只是搬运这张位图
// sourceToken 用于区分「同一路径但图像字节已被覆盖」的情况
let bitmapCache = { key: "", canvas: null };
let sourceToken = 0;

function previewBitmap() {
    if (mode === "crop") return srcImage;
    const key = `${sourceToken}|${targetW}x${targetH}|${algorithm}`;
    if (bitmapCache.key === key) return bitmapCache.canvas;
    const pv = previewSize(targetW, targetH);
    const c = document.createElement("canvas");
    c.width = pv.w;
    c.height = pv.h;
    const out = resample(srcData.data, srcW, srcH, pv.w, pv.h, algorithm);
    c.getContext("2d").putImageData(new ImageData(out, pv.w, pv.h), 0, 0);
    bitmapCache = { key, canvas: c };
    return c;
}

// 当前视图参数：fit 为「只缩小不放大」的适配比例，scale = fit × zoom，坐标以预览区左上角为原点
function viewMetrics() {
    const box = $("it_preview");
    const boxW = Math.max(1, box ? box.clientWidth : 1);
    const boxH = Math.max(1, box ? box.clientHeight : 1);
    const iw = Math.max(1, mode === "crop" ? srcW : targetW);
    const ih = Math.max(1, mode === "crop" ? srcH : targetH);
    const fit = Math.min(1, (boxW - 2) / iw, (boxH - 2) / ih);
    const scale = Math.max(0.01, fit * zoom);
    const dw = iw * scale, dh = ih * scale;
    return {
        boxW, boxH, iw, ih, fit, scale, dw, dh,
        x: (boxW - dw) / 2 + pan.x,
        y: (boxH - dh) / 2 + pan.y,
    };
}

function resetPreviewView() {
    zoom = 1;
    pan = { x: 0, y: 0 };
    renderPreview();
}

// 底部显示当前显示比例：100% 即 1 图像像素 = 1 CSS 像素
function updateZoomInfo(m) {
    const el = $("it_zoom_info");
    if (el) el.textContent = `${Math.round(m.scale * 100)}%`;
}

// 裁剪浮层与画布同尺寸（视口大小），坐标直接复用 viewMetrics，缩放时线宽/手柄始终是固定 CSS 像素
function drawCropOverlay(m) {
    const ov = $("it_overlay");
    if (!ov) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(m.boxW * dpr));
    const bh = Math.max(1, Math.round(m.boxH * dpr));
    if (ov.width !== bw) ov.width = bw;
    if (ov.height !== bh) ov.height = bh;
    ov.style.width = m.boxW + "px";
    ov.style.height = m.boxH + "px";
    const ctx = ov.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.boxW, m.boxH);
    if (mode !== "crop" || !srcImage || crop.w <= 0 || crop.h <= 0) return;

    const s = m.scale;
    const ix = m.x, iy = m.y, iw = m.dw, ih = m.dh;
    const x = ix + crop.x * s, y = iy + crop.y * s;
    const cw = Math.max(1, crop.w * s), ch = Math.max(1, crop.h * s);

    ctx.save();
    // 只压暗图像范围内的区域（预览区留白不参与）
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    if (y > iy) ctx.fillRect(ix, iy, iw, y - iy);
    if (y + ch < iy + ih) ctx.fillRect(ix, y + ch, iw, iy + ih - y - ch);
    if (x > ix) ctx.fillRect(ix, y, x - ix, ch);
    if (x + cw < ix + iw) ctx.fillRect(x + cw, y, ix + iw - x - cw, ch);

    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0d6efd";
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.75, y + 0.75, Math.max(0, cw - 1.5), Math.max(0, ch - 1.5));

    // 手柄尺寸固定为 CSS 像素，缩放预览时不会变大变小
    const hs = 6;
    const pts = [
        [x, y], [x + cw / 2, y], [x + cw, y],
        [x + cw, y + ch / 2], [x + cw, y + ch],
        [x + cw / 2, y + ch], [x, y + ch], [x, y + ch / 2]
    ];
    ctx.fillStyle = accent;
    for (const [px, py] of pts) ctx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    for (const [px, py] of pts) ctx.strokeRect(px - hs / 2 + 0.5, py - hs / 2 + 0.5, hs - 1, hs - 1);
    ctx.restore();
}

function renderPreview() {
    if (!srcImage || !srcData) return;
    const canvas = $("it_canvas");
    if (!canvas) return;
    const m = viewMetrics();
    if (m.boxW < 8 || m.boxH < 8) return; // 浮窗尚未完成布局

    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(m.boxW * dpr));
    const bh = Math.max(1, Math.round(m.boxH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    canvas.style.width = m.boxW + "px";
    canvas.style.height = m.boxH + "px";

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.boxW, m.boxH);
    // 裁剪模式放大时用最近邻看清像素，其余情况平滑缩放
    ctx.imageSmoothingEnabled = mode === "crop" ? m.scale < 1 : true;
    try {
        // 只把视口里可见的那部分图像画出来：放大/平移时不会每帧处理整张原图
        const src = previewBitmap();
        const dLeft = Math.max(0, m.x), dTop = Math.max(0, m.y);
        const dRight = Math.min(m.boxW, m.x + m.dw), dBottom = Math.min(m.boxH, m.y + m.dh);
        if (dRight > dLeft && dBottom > dTop) {
            const kx = src.width / m.dw, ky = src.height / m.dh;
            ctx.drawImage(
                src,
                (dLeft - m.x) * kx, (dTop - m.y) * ky, (dRight - dLeft) * kx, (dBottom - dTop) * ky,
                dLeft, dTop, dRight - dLeft, dBottom - dTop
            );
        }
    } catch (e) {
        toast(String(e.message || e), "error");
        return;
    }
    drawCropOverlay(m);
    updateZoomInfo(m);
}

function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 90);
}

// ------------------------------ 尺寸与模式 ------------------------------

// 裁剪模式下尺寸输入即裁剪框大小，统一把目标尺寸写回裁剪框
function applyTargetToCrop() {
    cropTouched = true;
    crop.w = Math.min(targetW, srcW);
    crop.h = Math.min(targetH, srcH);
    clampCrop();
    syncFromCrop();
}

// fromInput 传入输入框元素时，允许用户清空或暂输非法值，不立即改写输入框内容
function setSize(dim, raw, fromInput = null) {
    if (!srcImage) return;
    const num = Number(raw);
    if (fromInput && (String(raw).trim() === "" || !Number.isFinite(num))) return;
    const v = clampSize(num || 1);
    if (lockRatio && srcW > 0 && srcH > 0) {
        const other = dim === "w"
            ? clampSize(v * srcH / srcW)
            : clampSize(v * srcW / srcH);
        if (dim === "w") {
            targetW = v;
            targetH = other;
        } else {
            targetH = v;
            targetW = other;
        }
    } else if (dim === "w") {
        targetW = v;
    } else {
        targetH = v;
    }
    if (mode === "crop") applyTargetToCrop();
    else syncInputs();
    schedulePreview();
}

function stepSize(dim, delta) {
    const cur = dim === "w" ? targetW : targetH;
    setSize(dim, snap64(cur) + delta);
}

// 常见尺寸单选直接指定两边，不受锁定比例推导影响
function setBothSizes(w, h) {
    if (!srcImage) return;
    targetW = clampSize(w);
    targetH = clampSize(h);
    if (mode === "crop") applyTargetToCrop();
    else syncInputs();
    schedulePreview();
}

// 交换宽高：只改当前编辑目标，不写入设置文件（纯窗口内的临时操作）
function swapSizes() {
    if (!srcImage) {
        // 尚未载入图像时只交换输入框里的数字，等选图后再按输入值推导
        const wi = $("it_width"), hi = $("it_height");
        if (!wi || !hi) return;
        const tmp = wi.value;
        wi.value = hi.value;
        hi.value = tmp;
        return;
    }
    setBothSizes(targetH, targetW);
}

// X/Y 即裁剪框左上角。余量足够时整体平移；
// 越界时改为拖动起始边（对边固定），w/h 自动钳制，连续调整会一路向内收
function setCropPos(dim, raw, fromInput = null) {
    if (!srcImage) return;
    const num = Number(raw);
    if (fromInput && (String(raw).trim() === "" || !Number.isFinite(num))) return;
    const horizontal = dim === "x";
    const limit = horizontal ? srcW : srcH;
    const slack = Math.max(0, limit - (horizontal ? crop.w : crop.h));
    const want = clampInt(num || 0, 0, Math.max(0, limit - 1));
    cropTouched = true;
    if (want <= slack) {
        if (horizontal) crop.x = want;
        else crop.y = want;
        syncCropInputs();
    } else {
        // 对边固定，起始边内收到 want
        const fixed = horizontal ? crop.x + crop.w : crop.y + crop.h;
        const trim = Math.min(want, fixed - 1);
        if (horizontal) {
            crop.x = trim;
            crop.w = fixed - trim;
        } else {
            crop.y = trim;
            crop.h = fixed - trim;
        }
        syncFromCrop();
    }
    schedulePreview();
}

// 屏幕上 1px 对应多少图像像素：滚轮步长按当前显示比例换算，缩小时不会「滚一格看不出变化」
function screenStep() {
    return Math.max(1, Math.round(1 / viewMetrics().scale));
}

// 滚轮/箭头微调：等价于拖动起始边，立即刷新（跳过防抖）
function nudgeCropPos(dim, delta) {
    if (!srcImage || mode !== "crop") return;
    const cur = dim === "x" ? crop.x : crop.y;
    setCropPos(dim, cur + delta);
    renderPreview();
}

function setMode(next) {
    mode = next;
    pan = { x: 0, y: 0 }; // 两种模式的适配比例不同，切换后回到居中
    const box = $("it_preview");
    if (box) box.classList.toggle("is-crop", mode === "crop");
    const sw = $("it_mode_scale"), cw = $("it_mode_crop");
    if (sw) sw.classList.toggle("active", mode === "scale");
    if (cw) cw.classList.toggle("active", mode === "crop");
    const scaleOpts = $("it_scale_options");
    if (scaleOpts) scaleOpts.classList.toggle("hidden", mode !== "scale");
    const posField = $("it_pos_field");
    if (posField) posField.classList.toggle("hidden", mode !== "crop");
    const hint = $("it_crop_hint");
    if (hint) hint.classList.toggle("hidden", mode !== "crop");
    if (mode === "crop" && srcImage) {
        if (!cropTouched || crop.w <= 0 || crop.h <= 0) {
            crop.w = Math.min(targetW, srcW);
            crop.h = Math.min(targetH, srcH);
            crop.x = Math.round((srcW - crop.w) / 2);
            crop.y = Math.round((srcH - crop.h) / 2);
        }
        syncFromCrop();
    }
    schedulePreview();
}

// ------------------------------ 裁剪交互 ------------------------------

// 视口坐标 → 图像像素坐标：与 renderPreview 使用同一套 viewMetrics，缩放/平移后依然准确
function canvasPoint(e) {
    const canvas = $("it_canvas");
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    const m = viewMetrics();
    const k = m.boxW / r.width; // CSS 尺寸可能因 DPR 取整有亚像素差
    return {
        x: ((e.clientX - r.left) * k - m.x) / m.scale,
        y: ((e.clientY - r.top) * k - m.y) / m.scale,
    };
}

function hitTest(px, py) {
    if (!srcImage || crop.w <= 0) return null;
    // 命中容差固定为屏幕 10px，换算成图像像素
    const pxTol = 10 / viewMetrics().scale;
    const x1 = crop.x, y1 = crop.y, x2 = crop.x + crop.w, y2 = crop.y + crop.h;
    const l = Math.abs(px - x1) <= pxTol;
    const rgt = Math.abs(px - x2) <= pxTol;
    const t = Math.abs(py - y1) <= pxTol;
    const b = Math.abs(py - y2) <= pxTol;
    if (t && l) return "nw";
    if (t && rgt) return "ne";
    if (b && rgt) return "se";
    if (b && l) return "sw";
    if (l) return "w";
    if (rgt) return "e";
    if (t) return "n";
    if (b) return "s";
    if (px >= x1 && px <= x2 && py >= y1 && py <= y2) return "inside";
    return null;
}

// 裁剪框四边始终钳制在原图范围内，左上和右下都不允许越界
function cropBounds() {
    return {
        minX: 0,
        maxX: Math.max(0, srcW - crop.w),
        minY: 0,
        maxY: Math.max(0, srcH - crop.h),
    };
}

function clampCrop() {
    crop.w = clampInt(crop.w, 1, srcW);
    crop.h = clampInt(crop.h, 1, srcH);
    const b = cropBounds();
    crop.x = clampInt(crop.x, b.minX, b.maxX);
    crop.y = clampInt(crop.y, b.minY, b.maxY);
}

// 基于「固定边」推导尺寸：w/n 边向内缩小、e/s 边向外扩大；锁定比例时按固定边算可用上限
function resizeCrop(kind, dx, dy, orig) {
    if (!srcImage || srcW <= 0 || srcH <= 0) return;
    const isW = kind.includes("w"), isE = kind.includes("e");
    const isN = kind.includes("n"), isS = kind.includes("s");
    let x1 = orig.x, x2 = orig.x + orig.w, y1 = orig.y, y2 = orig.y + orig.h;
    if (isW) x1 = Math.max(0, Math.min(x2 - 1, orig.x + dx));
    if (isE) x2 = Math.min(srcW, Math.max(x1 + 1, orig.x + orig.w + dx));
    if (isN) y1 = Math.max(0, Math.min(y2 - 1, orig.y + dy));
    if (isS) y2 = Math.min(srcH, Math.max(y1 + 1, orig.y + orig.h + dy));

    let w = x2 - x1, h = y2 - y1;
    if (lockRatio) {
        const ratio = srcW / srcH;
        const corner = (isW || isE) && (isN || isS);
        const widthDriven = !corner
            ? (isW || isE)
            : (Math.abs(dx) / Math.max(1, orig.w)) >= (Math.abs(dy) / Math.max(1, orig.h));
        if (widthDriven) h = w / ratio;
        else w = h * ratio;

        let maxW = srcW, maxH = srcH;
        if (isW && !isE) maxW = x2;          // 右边固定
        else if (isE && !isW) maxW = srcW - x1; // 左边固定
        if (isN && !isS) maxH = y2;          // 下边固定
        else if (isS && !isN) maxH = srcH - y1; // 上边固定
        if (w > Math.min(maxW, maxH * ratio)) {
            w = Math.min(maxW, maxH * ratio);
            h = w / ratio;
        }
        w = Math.max(1, Math.round(w));
        h = Math.max(1, Math.round(h));
    }

    const bx = isW ? x2 - w : isE ? x1 : orig.x + (orig.w - w) / 2;
    const by = isN ? y2 - h : isS ? y1 : orig.y + (orig.h - h) / 2;
    crop = { x: bx, y: by, w, h };
    clampCrop();
}

// 以裁剪框中心为锚点整体缩放（滚轮用），w/h 自动钳制；锁比例时同步两边
function scaleCropBy(delta) {
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    let w = clampInt(crop.w + delta * 2, 1, srcW);
    let h = clampInt(crop.h + delta * 2, 1, srcH);
    if (lockRatio && srcW > 0 && srcH > 0) {
        h = clampInt(w * srcH / srcW, 1, srcH);
        w = clampInt(h * srcW / srcH, 1, srcW);
    }
    crop.w = w;
    crop.h = h;
    crop.x = clampInt(cx - w / 2, 0, Math.max(0, srcW - w));
    crop.y = clampInt(cy - h / 2, 0, Math.max(0, srcH - h));
}

// 预览滚轮缩放：以鼠标位置为锚点，zoom 为相对「适配比例」的倍数
function onPreviewWheel(e) {
    if (!srcImage) return;
    e.preventDefault();
    const box = $("it_preview");
    const rect = box.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const cx = rect.width / 2, cy = rect.height / 2;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    if (next === zoom) return;
    pan.x = (mx - cx) - (mx - cx - pan.x) * (next / zoom);
    pan.y = (my - cy) - (my - cy - pan.y) * (next / zoom);
    zoom = next;
    renderPreview();
}

// 裁剪模式：滚轮直接调裁剪框（边框上拖该边，框内整体缩放），Alt/Ctrl+滚轮才是缩放预览。
// 这样默认「裁剪框=全图」时滚轮依然有效：向内缩即等价拖动手柄，x/y 随钳制自动变化。
function onCanvasWheel(e) {
    if (!srcImage) return;
    e.stopPropagation();
    if (mode !== "crop" || e.altKey || e.ctrlKey) {
        onPreviewWheel(e);
        return;
    }
    e.preventDefault();
    const p = canvasPoint(e);
    const kind = hitTest(p.x, p.y);
    const step = (e.shiftKey ? 8 : 1) * screenStep();
    const dir = e.deltaY < 0 ? 1 : -1;
    cropTouched = true;
    if (kind && kind !== "inside") {
        // 统一语义：上滚变大、下滚变小（左/上边框向反方向移动）
        const dx = kind.includes("e") ? dir * step : kind.includes("w") ? -dir * step : 0;
        const dy = kind.includes("s") ? dir * step : kind.includes("n") ? -dir * step : 0;
        resizeCrop(kind, dx, dy, { ...crop });
    } else {
        scaleCropBy(dir * step);
    }
    syncFromCrop();
    renderPreview();
}

function onCanvasMouseDown(e) {
    if (mode !== "crop" || !srcImage || e.button !== 0 || e.altKey) return;
    e.preventDefault();
    const p = canvasPoint(e);
    const kind = hitTest(p.x, p.y) || "new";
    const orig = { ...crop };
    dragState = { kind, startX: p.x, startY: p.y, orig };
    cropTouched = true;
    if (kind === "new") crop = { x: Math.round(p.x), y: Math.round(p.y), w: 1, h: 1 };

    const move = (ev) => {
        if (!dragState) return;
        const cur = canvasPoint(ev);
        const dx = cur.x - dragState.startX;
        const dy = cur.y - dragState.startY;
        if (dragState.kind === "inside") {
            const b = cropBounds();
            crop.x = clampInt(dragState.orig.x + dx, b.minX, b.maxX);
            crop.y = clampInt(dragState.orig.y + dy, b.minY, b.maxY);
        } else if (dragState.kind === "new") {
            const x1 = Math.max(0, Math.min(srcW, Math.round(dragState.startX)));
            const y1 = Math.max(0, Math.min(srcH, Math.round(dragState.startY)));
            const x2 = Math.max(0, Math.min(srcW, Math.round(cur.x)));
            const y2 = Math.max(0, Math.min(srcH, Math.round(cur.y)));
            crop = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(1, Math.abs(x2 - x1)), h: Math.max(1, Math.abs(y2 - y1)) };
        } else {
            resizeCrop(dragState.kind, dx, dy, dragState.orig);
        }
        clampCrop();
        syncFromCrop();
        renderPreview();
    };
    const up = () => {
        dragState = null;
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
}

// 中键或 Alt+左键平移缩放后的预览
function onPreviewMouseDown(e) {
    if (!srcImage) return;
    if (e.button === 0 && !e.altKey) return; // 左键交给裁剪手柄/框选
    e.preventDefault();
    panDrag = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    const move = (ev) => {
        if (!panDrag) return;
        pan.x = panDrag.panX + (ev.clientX - panDrag.x);
        pan.y = panDrag.panY + (ev.clientY - panDrag.y);
        renderPreview();
    };
    const up = () => {
        panDrag = null;
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
}

// ------------------------------ 图像加载与保存 ------------------------------

function showImageState(hasImage) {
    const el = $("it_no_image");
    if (el) el.classList.toggle("hidden", !!hasImage);
}

// 解码二进制为 Image，返回 { img, url }；解码失败时释放 objectURL 并抛错
function decodeImageBuffer(buffer) {
    const url = URL.createObjectURL(new Blob([buffer]));
    const img = new Image();
    return new Promise((resolve, reject) => {
        img.onload = () => resolve({ img, url });
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("decode failed"));
        };
        img.src = url;
    });
}

// 统一设置图像源：刷新尺寸/裁剪/输入框等状态，loadImage 与本地文件选择共用
async function setSourceImage(img, path, url) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = url;
    srcImage = img;
    srcPath = path;
    srcExt = formatFromPath(path);
    srcW = img.naturalWidth;
    srcH = img.naturalHeight;
    sourceToken++;

    const c = document.createElement("canvas");
    c.width = srcW;
    c.height = srcH;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    srcData = ctx.getImageData(0, 0, srcW, srcH);

    targetW = srcW;
    targetH = srcH;
    crop = { x: 0, y: 0, w: srcW, h: srcH };
    cropTouched = false;
    syncInputs();
    showImageState(true);
    const info = $("it_source_info");
    if (info) info.textContent = `${srcW} × ${srcH} · ${(srcExt || "?").toUpperCase()} · ${path}`;
    resetPreviewView();
    renderPreview();
}

// 清空图像状态：未指定图像就打开浮窗时调用，避免残留上一张图的画布
function clearSource() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    srcImage = null;
    srcData = null;
    srcPath = "";
    srcExt = "";
    srcW = 0;
    srcH = 0;
    sourceToken++;
    crop = { x: 0, y: 0, w: 0, h: 0 };
    cropTouched = false;
    const canvas = $("it_canvas");
    if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
    }
    const info = $("it_source_info");
    if (info) info.textContent = "";
    const zoomInfo = $("it_zoom_info");
    if (zoomInfo) zoomInfo.textContent = "";
    showImageState(false);
    resetPreviewView();
}

async function loadImage(path) {
    if (!path) return false;
    const buffer = await api.readBinaryFile(path);
    if (!buffer) {
        toast(t("image_tool.load_failed") + path, "error");
        return false;
    }
    let decoded;
    try {
        decoded = await decodeImageBuffer(buffer);
    } catch (e) {
        toast(t("image_tool.load_failed") + String(e.message || e), "error");
        return false;
    }
    await setSourceImage(decoded.img, path, decoded.url);
    return true;
}

// 选择图像：优先系统对话框；仅当原生接口不可用（浏览器模式）时才回退到文件选择框
async function pickImage() {
    if (typeof Neutralino !== "undefined" && Neutralino.os && Neutralino.os.showOpenDialog) {
        let picked = "";
        let failed = false;
        try {
            picked = await Neutralino.os.showOpenDialog(t("image_tool.title"), {
                filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
            });
        } catch (e) {
            failed = true;
        }
        const path = Array.isArray(picked) ? picked[0] : picked;
        if (path) await loadImage(String(path));
        else if (failed) $("it_file_input")?.click();
        return;
    }
    $("it_file_input")?.click();
}

async function renderOutputBlob(ext) {
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    // JPEG 无透明通道，透明区域先铺白，否则导出后会是黑底
    if (ext === ".jpg") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, targetW, targetH);
    }
    if (mode === "crop") {
        // 直接取裁剪区域的原图像素；目标尺寸与裁剪框一致时即为 1:1 复制
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(srcImage, crop.x, crop.y, crop.w, crop.h, 0, 0, targetW, targetH);
    } else {
        const out = resample(srcData.data, srcW, srcH, targetW, targetH, algorithm);
        ctx.putImageData(new ImageData(out, targetW, targetH), 0, 0);
    }
    const mime = ext === ".jpg" ? "image/jpeg" : "image/png";
    const quality = ext === ".jpg" ? 1 : undefined;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, quality));
    if (!blob) throw new Error("toBlob failed");
    return blob;
}

// 保存并应用：新字节写入成功后才把原图移入回收站，避免写入失败导致原图丢失
async function applyToCurrentImage() {
    if (!srcImage) {
        toast(t("image_tool.no_image"), "error");
        return;
    }
    // 没有目录信息（浏览器模式从文件选择框载入，只有文件名）时无法写回原文件
    if (!srcPath || !/[/\\]/.test(srcPath)) {
        toast(t("image_tool.no_source_path"), "error");
        return;
    }
    const ext = outputExt();
    const oldPath = srcPath;
    const inPlace = canWriteInPlace(ext); // 格式与原后缀一致才能原地写回
    const newPath = inPlace ? oldPath : withSuffix(oldPath, ext);
    const tmpPath = `${newPath}.imgtool_tmp`;

    try {
        // 改扩展名时目标可能已存在（如 a.jpg 与 a.png 并存），不做覆盖
        if (!inPlace && await api.pathExists(newPath)) {
            toast(t("image_tool.target_exists") + newPath, "error");
            return;
        }
        const buf = await (await renderOutputBlob(ext)).arrayBuffer();
        // 原地写回先落临时文件，新字节就绪后再移走原图
        const writePath = inPlace ? tmpPath : newPath;
        if (!await api.writeBinaryFile(writePath, buf)) throw new Error("writeBinaryFile failed");
        if (!await api.trashItem(oldPath)) {
            await api.removeFile(writePath);
            throw new Error("trashItem failed");
        }
        if (inPlace && !await api.moveFile(tmpPath, newPath)) throw new Error(`moveFile failed: ${tmpPath}`);
    } catch (e) {
        toast(t("image_tool.apply_failed") + String(e.message || e), "error");
        return;
    }

    // 文件已替换：迁移数据集/画廊中的路径引用并刷新（回调失败不影响主流程）
    if (typeof onApplied === "function") {
        try {
            await onApplied(oldPath, newPath);
        } catch (e) {
            console.warn("image tool onApplied failed:", e);
        }
    }
    await loadImage(newPath);
    toast(t("image_tool.applied") + newPath, "success");
}

// 另存为：点击时走系统保存对话框选路径，不影响当前图像
async function saveAsImage() {
    if (!srcImage) {
        toast(t("image_tool.no_image"), "error");
        return;
    }
    const ext = outputExt();
    let outPath = "";
    try {
        if (typeof Neutralino !== "undefined" && Neutralino.os && Neutralino.os.showSaveDialog) {
            outPath = await Neutralino.os.showSaveDialog(t("image_tool.title"), {
                defaultPath: defaultOutputPath(srcPath),
                filters: [{ name: ext === ".jpg" ? "JPEG" : "PNG", extensions: [ext.slice(1)] }],
            });
        }
    } catch (e) {
        toast(t("image_tool.save_failed") + String(e.message || e), "error");
        return;
    }
    if (!outPath) return; // 用户取消
    outPath = String(outPath);
    if (!new RegExp(`\\${ext}$`, "i").test(outPath)) outPath += ext;

    try {
        const buf = await (await renderOutputBlob(ext)).arrayBuffer();
        const ok = await api.writeBinaryFile(outPath, buf);
        if (!ok) throw new Error("writeBinaryFile failed");
        toast(t("image_tool.saved") + outPath, "success");
    } catch (e) {
        toast(t("image_tool.save_failed") + String(e.message || e), "error");
    }
}

// ------------------------------ 尺寸预设 ------------------------------

function syncSizePresets() {
    for (const [id, value] of [["it_w_preset", targetW], ["it_h_preset", targetH]]) {
        const sel = $(id);
        if (!sel) continue;
        sel.value = PRESET_SIZES.includes(value) ? String(value) : "";
    }
}

// 常用尺寸的持久化：全部尺寸统一保存在设置文件的 image_tool_common_sizes 中，
// 可在「设置 → 图像工具」里增删改，本窗口内也能添加
const COMMON_SIZES_KEY = "image_tool_common_sizes";

// 当前生效的常用尺寸：设置里存的是 "宽x高" 字符串，这里解析成 [宽, 高]（非法项忽略）
function currentCommonSizes() {
    const raw = getSetting(COMMON_SIZES_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map(parseImageSize).filter(Boolean);
}

// 保存常用尺寸列表到设置文件（写盘失败时提示，避免用户以为已经记住）
// 落盘为 ["1024x1024", ...]，每个尺寸只占一行
function saveCommonSizes(list) {
    setSetting(COMMON_SIZES_KEY, list.map(([w, h]) => `${w}x${h}`));
    settings.save().catch((e) => {
        console.warn("save common sizes failed:", e);
        toast(t("image_tool.save_size_failed"), "error");
    });
}

// 自定义尺寸输入框与 + 按钮在同一格里就地切换，不额外占用一行
function setCustomSizeEditing(show) {
    const cell = $("it_size_add_cell");
    if (!cell) return;
    cell.classList.toggle("active", !!show);
    const toggle = $("it_add_size_toggle");
    const input = $("it_custom_size");
    if (toggle) {
        toggle.hidden = !!show;
        if (show) toggle.title = t("image_tool.add_size");
    }
    if (input) {
        input.hidden = !show;
        if (show) {
            // 就地输入：点开时再取文案，保证初始化早于语言包加载时也能显示正确占位
            input.placeholder = t("image_tool.custom_size");
            input.value = "";
            input.focus();
        }
    }
}

// 重绘本窗口的常用尺寸列表（设置页保存后也会调用，见 ui.js）
export function renderCommonSizes() {
    const box = $("it_common_sizes");
    if (!box) return;
    box.innerHTML = "";
    // 预设尺寸的增删改与排序都在设置页维护，这里只负责选择
    for (const [w, h] of currentCommonSizes()) {
        const label = document.createElement("label");
        label.className = "it-size-chip";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "it_common_size";
        input.value = `${w}x${h}`;
        input.addEventListener("change", () => {
            if (!input.checked) return;
            setBothSizes(w, h);
        });
        const span = document.createElement("span");
        span.textContent = `${w}×${h}`;
        label.append(input, span);
        box.appendChild(label);
    }

    // 追加格：默认只有一个 + 按钮，点开后「就地」换成输入框（不占新行），回车添加
    const cell = document.createElement("span");
    cell.className = "it-size-add";
    cell.id = "it_size_add_cell";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.id = "it_add_size_toggle";
    toggle.className = "it-add-size-btn";
    toggle.textContent = "+";
    toggle.title = t("image_tool.add_size");
    toggle.dataset.i18nTitle = "image_tool.add_size";
    toggle.addEventListener("click", () => setCustomSizeEditing(true));

    const input = document.createElement("input");
    input.type = "text";
    input.id = "it_custom_size";
    input.className = "it-custom-input";
    input.placeholder = t("image_tool.custom_size");
    input.dataset.i18nPlaceholder = "image_tool.custom_size";
    input.hidden = true;
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addCommonSize();
        else if (e.key === "Escape") setCustomSizeEditing(false);
    });
    // 失焦：已填写则提交，空值直接收起，避免留下一个孤立的输入框
    input.addEventListener("blur", () => {
        // 重新渲染会换掉整个格子，旧节点上的 blur 不再处理
        if (document.getElementById("it_size_add_cell") !== cell) return;
        if (!cell.classList.contains("active")) return;
        if (input.value.trim()) addCommonSize();
        else setCustomSizeEditing(false);
    });

    cell.append(toggle, input);
    box.appendChild(cell);
    syncCheckedSizeChip();
}

// 按当前目标尺寸勾选对应的预设单选项（列表重建后调用）
function syncCheckedSizeChip() {
    const radio = $("it_common_sizes")?.querySelector(`input[value="${targetW}x${targetH}"]`);
    if (radio) radio.checked = true;
}

// 添加常用尺寸：写进设置文件后再重绘，保证重启后仍在
function addCommonSize() {
    const raw = ($("it_custom_size")?.value || "").trim().toLowerCase();
    const m = raw.match(/^(\d+)\s*[x×]\s*(\d+)$/);
    if (!m) {
        toast(t("image_tool.invalid_size"), "error");
        return;
    }
    const w = clampSize(Number(m[1])), h = clampSize(Number(m[2]));
    const list = currentCommonSizes();
    if (!list.some(([a, b]) => a === w && b === h)) saveCommonSizes([...list, [w, h]]);
    renderCommonSizes();
    setBothSizes(w, h);
    // 未载入图像时 setBothSizes 不更新目标尺寸，这里直接勾选刚添加的尺寸
    const radio = $("it_common_sizes")?.querySelector(`input[value="${w}x${h}"]`);
    if (radio) radio.checked = true;
}

// ------------------------------ 初始化 ------------------------------

function bind(id, event, handler, options) {
    const el = $(id);
    if (el) el.addEventListener(event, handler, options);
}

export function initImageTool(options = {}) {
    onApplied = typeof options.onApplied === "function" ? options.onApplied : null;
    notify = typeof options.notify === "function" ? options.notify : null;

    const popup = document.getElementById("image_tool_popup");
    if (popup) {
        setupPopup(popup, {
            closeBtn: $("it_close"),
            pinBtn: $("it_pin"),
            isPinned: () => popupPinned,
            onPinToggle: () => {
                popupPinned = !popupPinned;
                popup.classList.toggle("pinned", popupPinned);
            },
            outsideClose: "pointerdown",
            dragIgnore: "button",
            minW: 640,
            minH: 420,
            maxW: () => Math.min(1200, window.innerWidth - 8),
            maxH: () => window.innerHeight - 8,
        });
    }

    for (const [id, dim] of [["it_w_preset", "w"], ["it_h_preset", "h"]]) {
        const sel = $(id);
        if (!sel) continue;
        for (const v of PRESET_SIZES) {
            const opt = document.createElement("option");
            opt.value = String(v);
            opt.textContent = String(v);
            sel.appendChild(opt);
        }
        sel.addEventListener("change", (e) => {
            if (e.target.value) setSize(dim, e.target.value);
        });
    }
    // 常用尺寸直接读设置文件
    renderCommonSizes();

    bind("it_pick_image", "click", pickImage);
    bind("it_file_input", "change", async (e) => {
        const input = e.target;
        const file = input.files && input.files[0];
        if (!file) return;
        input.value = ""; // 清空后可重复选择同一文件
        try {
            const decoded = await decodeImageBuffer(await file.arrayBuffer());
            await setSourceImage(decoded.img, file.name, decoded.url);
        } catch (err) {
            toast(t("image_tool.load_failed") + String(err.message || err), "error");
        }
    });

    bind("it_mode_scale", "click", () => setMode("scale"));
    bind("it_mode_crop", "click", () => setMode("crop"));
    // 「常见尺寸」标题右侧的交换宽高按钮：纯 UI 操作，不改设置文件
    bind("it_swap_wh", "click", swapSizes);

    for (const [id, dim, delta] of [
        ["it_w_dec", "w", -STEP], ["it_w_inc", "w", STEP],
        ["it_h_dec", "h", -STEP], ["it_h_inc", "h", STEP],
    ]) {
        bind(id, "click", () => stepSize(dim, delta));
    }
    for (const [id, dim, delta] of [
        ["it_x_dec", "x", -STEP], ["it_x_inc", "x", STEP],
        ["it_y_dec", "y", -STEP], ["it_y_inc", "y", STEP],
    ]) {
        bind(id, "click", () => nudgeCropPos(dim, delta));
    }
    bind("it_width", "input", (e) => setSize("w", e.target.value, e.target));
    bind("it_height", "input", (e) => setSize("h", e.target.value, e.target));
    bind("it_x", "input", (e) => setCropPos("x", e.target.value, e.target));
    bind("it_y", "input", (e) => setCropPos("y", e.target.value, e.target));
    // X/Y 也支持滚轮微调（等价拖动起始边）
    bind("it_x", "wheel", (e) => {
        e.preventDefault();
        nudgeCropPos("x", e.deltaY < 0 ? screenStep() : -screenStep());
    }, { passive: false });
    bind("it_y", "wheel", (e) => {
        e.preventDefault();
        nudgeCropPos("y", e.deltaY < 0 ? screenStep() : -screenStep());
    }, { passive: false });
    // 输入框被清空时不会立即回填，失焦后再同步为真实值
    bind("it_width", "blur", syncInputs);
    bind("it_height", "blur", syncInputs);
    bind("it_x", "blur", syncCropInputs);
    bind("it_y", "blur", syncCropInputs);
    bind("it_lock_ratio", "change", (e) => {
        lockRatio = !!e.target.checked;
        if (lockRatio && srcImage) setSize("w", targetW);
    });
    bind("it_algorithm", "change", (e) => {
        algorithm = ALGOS.includes(e.target.value) ? e.target.value : "lanczos";
        schedulePreview();
    });
    bind("it_reset", "click", () => {
        if (!srcImage) return;
        targetW = srcW; targetH = srcH;
        crop = { x: 0, y: 0, w: srcW, h: srcH };
        cropTouched = false;
        if ($("it_algorithm")) $("it_algorithm").value = "lanczos";
        algorithm = "lanczos";
        const follow = document.querySelector('input[name="it_format"][value="follow"]');
        if (follow) follow.checked = true;
        resetPreviewView();
        syncInputs();
        renderPreview();
    });
    bind("it_save", "click", applyToCurrentImage);
    bind("it_save_as", "click", saveAsImage);

    const canvas = $("it_canvas");
    if (canvas) {
        canvas.addEventListener("mousedown", onCanvasMouseDown);
        canvas.addEventListener("wheel", onCanvasWheel, { passive: false });
    }
    const previewBox = $("it_preview");
    if (previewBox) {
        previewBox.addEventListener("wheel", onPreviewWheel, { passive: false });
        previewBox.addEventListener("mousedown", onPreviewMouseDown);
        if (typeof ResizeObserver !== "undefined") {
            new ResizeObserver(() => schedulePreview()).observe(previewBox);
        }
    }
    window.addEventListener("resize", schedulePreview);

    showImageState(false);
    setMode("scale");
}

// 从额外工具或画廊右键打开页面内浮窗，并载入指定图像（无图像时清空上次状态）
export async function openImageTool(path) {
    const popup = document.getElementById("image_tool_popup");
    if (!popup) return;
    showPopup(popup, 1040, 720);
    if (path) await loadImage(path);
    else clearSource();
}

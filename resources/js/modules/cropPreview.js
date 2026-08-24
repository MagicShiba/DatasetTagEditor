// cropPreview.js - 分桶裁剪预览
// 复刻 OneTrainer（mgds AspectBucketing / ScaleCropImage）的图像分桶与裁剪策略，
// 在原图预览上用虚线框演示：训练时该图会被缩放到哪个桶、中心裁剪保留哪些区域。
//
// OneTrainer 策略要点：
// 1. 预定义 9 种宽高比 (1,1)(1,1.25)...(1,4)，连同转置共 18 个方向；
// 2. 每个桶面积恒等于目标分辨率 T²（等面积），边长四舍五入量化到 64 的倍数并去重；
// 3. 选桶：取与原图宽高比最接近的桶（argmin |bucket_aspect - img_aspect|）；
// 4. 裁剪：cover 式缩放（短边贴齐桶尺寸、长边溢出），再默认中心裁剪到桶尺寸。

// mgds 中预定义的基础宽高比集合（横向方向，竖向由转置生成）
const BUCKET_ASPECTS = [
    [1.0, 1.0], [1.0, 1.25], [1.0, 1.5], [1.0, 1.75], [1.0, 2.0],
    [1.0, 2.5], [1.0, 3.0], [1.0, 3.5], [1.0, 4.0],
];
// 桶边长量化粒度（OneTrainer 各模型均为 64）
const QUANTIZATION = 64;

let canvas = null;
let ctx = null;
let previewBox = null;
let img = null;

// 实时读取开关状态：不缓存到模块变量，避免配置加载等程序化设置 checked 后不同步
function isEnabled() {
    const cb = document.getElementById("cb_crop_preview");
    return !!(cb && cb.checked);
}

// 裁剪预览状态变化回调（开关/分辨率变化时通知外部，如 bbox 画布重新对齐）
let onCropPreviewChange = null;
export function setOnCropPreviewChange(cb) { onCropPreviewChange = cb; }
function notifyChange() { if (onCropPreviewChange) onCropPreviewChange(); }

// 边长量化到 QUANTIZATION 的整数倍（最小一个粒度，避免极端比例下出现 0）
function quantize(v) {
    return Math.max(QUANTIZATION, Math.round(v / QUANTIZATION) * QUANTIZATION);
}

// 生成目标分辨率下的所有桶 [h, w] 列表：
// 等面积缩放到 T² → 追加转置方向 → 量化 → 去重（与 mgds __create_automatic_buckets 一致）
export function createBuckets(target) {
    const base = BUCKET_ASPECTS.map(([a, b]) => {
        const s = Math.sqrt(a * b);
        return [quantize((a / s) * target), quantize((b / s) * target)];
    });
    const all = base.concat(base.map(([h, w]) => [w, h]));
    const seen = new Set();
    return all.filter(([h, w]) => {
        const key = `${h}x${w}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// 选择宽高比最接近原图的桶（argmin，同 mgds __get_bucket）
function pickBucket(buckets, iw, ih) {
    const aspect = ih / iw;
    let best = null;
    let bestDiff = Infinity;
    for (const [bh, bw] of buckets) {
        const d = Math.abs(bh / bw - aspect);
        if (d < bestDiff) { bestDiff = d; best = { h: bh, w: bw }; }
    }
    return best;
}

// 按给定图像尺寸返回命中的分桶 {w, h}；未启用裁剪预览时返回 null
// （供状态栏等外部显示使用，与画布上的裁剪框一致）
export function getBucketForSize(iw, ih) {
    if (!isEnabled() || !(iw > 0) || !(ih > 0)) return null;
    return pickBucket(createBuckets(getTargetResolution()), iw, ih);
}

// 计算裁剪区域在【原始图像像素坐标系】中的位置与大小
// 返回 { bucket:{h,w}, x, y, w, h }；无法计算时返回 null
export function computeCropRect(iw, ih, target) {
    if (!(target >= QUANTIZATION) || !(iw > 0) || !(ih > 0)) return null;
    const bucket = pickBucket(createBuckets(target), iw, ih);
    // cover 式缩放：短边贴齐桶尺寸，长边溢出（同 AspectBucketing.get_item 的 scale_resolution 计算）
    let scale;
    if (ih / iw > bucket.h / bucket.w) {
        scale = bucket.w / iw;   // 原图更高瘦 → 按宽缩放，高度溢出
    } else {
        scale = bucket.h / ih;   // 原图更矮胖 → 按高缩放，宽度溢出
    }
    const scaledW = iw * scale;
    const scaledH = ih * scale;
    // 中心裁剪偏移（同 ScaleCropImage 的整除偏移）
    const xOff = Math.floor((scaledW - bucket.w) / 2);
    const yOff = Math.floor((scaledH - bucket.h) / 2);
    // 把裁剪框从缩放后坐标映射回原始像素坐标
    return {
        bucket,
        x: xOff / scale,
        y: yOff / scale,
        w: bucket.w / scale,
        h: bucket.h / scale,
    };
}

function clearCanvas() {
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = "none";
}

// 将画布对齐到图像实际显示区域，绘制裁剪虚线框与遮罩
function draw() {
    if (!isEnabled() || !img || !img.src || !img.naturalWidth || !previewBox || !canvas) {
        clearCanvas();
        return;
    }
    const imgRect = img.getBoundingClientRect();
    const prevRect = previewBox.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) { clearCanvas(); return; }
    // 图像尚未加载完成时（切换图像的加载窗口）不绘制：
    // 此时 imgRect 仍是上一张图像的尺寸，裁剪框位置会与图像内容错位
    if (!img.complete) { clearCanvas(); return; }
    const cs = getComputedStyle(previewBox);
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const dpr = window.devicePixelRatio || 1;
    const w = imgRect.width;
    const h = imgRect.height;

    // 防止 preview 容器滚动导致画布与图像错位
    previewBox.scrollTop = 0;
    previewBox.scrollLeft = 0;
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

    // 计算裁剪区域（原图像素坐标 → 显示坐标按 w/iw 缩放）
    const rect = computeCropRect(img.naturalWidth, img.naturalHeight, getTargetResolution());
    if (!rect) { clearCanvas(); return; }
    const k = w / img.naturalWidth;
    const L = rect.x * k;
    const T = rect.y * k;
    const R = (rect.x + rect.w) * k;
    const B = (rect.y + rect.h) * k;

    // 保留区域外加深色遮罩，直观展示被裁掉的部分
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(L, T, R - L, B - T);
    ctx.fill("evenodd");

    // 虚线框表示训练时实际保留的区域（桶分辨率显示在下方状态栏，避免与边界框标签互相遮挡）
    ctx.strokeStyle = "#ffd54a";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(L + 1, T + 1, Math.max(0, R - L - 2), Math.max(0, B - T - 2));
    ctx.setLineDash([]);
}

// 读取输入框中的目标分辨率（非法时回退默认 1024）
function getTargetResolution() {
    const input = document.getElementById("crop_preview_res");
    const v = input ? Number(input.value) : NaN;
    return Number.isFinite(v) && v >= QUANTIZATION ? Math.round(v) : 1024;
}

// 返回当前启用的裁剪区域相对【图像显示区左上角】的 CSS 像素矩形 {left, top, width, height}；
// 未启用裁剪预览或无图像时返回 null（供 bbox 画布对齐裁剪区域使用）
export function getActiveCropRect() {
    if (!isEnabled() || !img || !img.src || !img.naturalWidth) return null;
    const imgRect = img.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) return null;
    const rect = computeCropRect(img.naturalWidth, img.naturalHeight, getTargetResolution());
    if (!rect) return null;
    const k = imgRect.width / img.naturalWidth;   // 原图像素 → 显示像素
    return {
        left: rect.x * k,
        top: rect.y * k,
        width: rect.w * k,
        height: rect.h * k,
    };
}

// 重绘入口：供外部在图像切换/缩放/平移后调用
export function updateCropPreview() {
    draw();
}

// 初始化：绑定控件与自动重绘事件
export function initCropPreview() {
    canvas = document.getElementById("crop_canvas");
    previewBox = document.getElementById("image_preview");
    img = document.getElementById("preview_img");
    const cb = document.getElementById("cb_crop_preview");
    const resInput = document.getElementById("crop_preview_res");
    if (!canvas || !previewBox || !img || !cb) return;
    ctx = canvas.getContext("2d");

    // 开关与分辨率变化时立即重绘，并通知外部（bbox 画布重新对齐到裁剪区域）
    cb.addEventListener("change", () => {
        draw();
        notifyChange();
    });
    if (resInput) resInput.addEventListener("change", () => { draw(); notifyChange(); });

    // 图像加载/出错、窗口尺寸、预览容器尺寸变化时重绘（与 bbox 画布保持一致的对齐逻辑）
    img.addEventListener("load", draw);
    img.addEventListener("error", () => clearCanvas());
    window.addEventListener("resize", draw);
    if (window.ResizeObserver) {
        new ResizeObserver(draw).observe(previewBox);
    }
}

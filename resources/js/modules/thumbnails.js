// thumbnails.js - 缩略图生成与缓存（Canvas 前端生成）
// 缓存目录: {NL_PATH}/cache/thumbnails/{md5(absPath_maxRes_mtime)}.jpg
// 与 Python 版缓存命名一致，便于复用已有缓存

import * as api from "./api.js";
import { md5, normalizePath } from "./utils.js";
import { getSetting } from "./config.js";

let cacheDir = "";
let cacheUrl = "";          // 缓存目录的 mount URL 前缀
let datasetUrl = "";        // 数据集目录的 mount URL 前缀
let datasetMountedDir = "";

// 图片加载去重/生成队列，避免同一图片并发重复生成
const genQueue = new Map(); // key -> Promise

// 初始化缩略图系统：确保缓存目录存在并挂载
export async function initThumbnails() {
    cacheDir = normalizePath(`${NL_PATH}/cache/thumbnails`);
    await api.createDirectory(cacheDir);
    cacheUrl = await api.mountDir(cacheDir);
    return cacheUrl;
}

// 获取缓存 key
function getCacheKey(imgPath, maxRes, mtime) {
    return md5(`${imgPath}_${maxRes}_${mtime}`);
}

// 导出计算缓存 key（供 app.js 使用）
export function md5Key(imgPath, maxRes, mtime) {
    return getCacheKey(imgPath, maxRes, mtime);
}

// 挂载数据集目录，返回 URL 前缀
export async function mountDataset(dir) {
    // 若相同目录已挂载则直接复用
    if (datasetUrl && datasetMountedDir === normalizePath(dir)) {
        return datasetUrl;
    }
    // 卸载旧的数据集挂载
    if (datasetUrl) {
        await api.unmountDir(datasetUrl);
    }
    datasetMountedDir = normalizePath(dir);
    datasetUrl = await api.mountDir(dir);
    return datasetUrl;
}

// 获取数据集中图片的原始 URL（用于生成缩略图）
export function getOriginalImageUrl(imgPath) {
    if (!datasetUrl) return "";
    const n = normalizePath(imgPath);
    const rel = n.slice(datasetMountedDir.length).replace(/^[/\\]+/, "");
    return `${datasetUrl}/${rel.split("/").map(seg => encodeURIComponent(seg)).join("/")}`;
}

// 获取缓存缩略图的 URL
export function getThumbCacheUrl(key) {
    return `${cacheUrl}/${key}.jpg`;
}

// 检查缩略图缓存是否存在
export async function thumbCacheExists(key) {
    return await api.pathExists(normalizePath(`${cacheDir}/${key}.jpg`));
}

// 生成单张缩略图并保存到缓存，返回缓存 key
// imgPath: 绝对路径; maxRes: 最大分辨率; mtime: 文件修改时间
export async function generateThumbnail(imgPath, maxRes, mtime) {
    const key = getCacheKey(imgPath, maxRes, mtime);

    // 若已有缓存文件则直接返回
    if (await thumbCacheExists(key)) {
        return key;
    }

    // 并发去重：同一 key 的生成任务只跑一次
    if (genQueue.has(key)) {
        return genQueue.get(key);
    }

    const promise = (async () => {
        const srcUrl = getOriginalImageUrl(imgPath);
        if (!srcUrl) throw new Error("dataset not mounted");

        // 读取图片并绘制到 canvas
        const blob = await fetch(srcUrl).then(r => r.blob()).catch(() => null);
        if (!blob) throw new Error("failed to load image");

        const bitmap = await createImageBitmap(blob).catch(() => null);
        if (!bitmap) throw new Error("failed to decode image");

        try {
            // 生成保持原始比例的缩略图：最长边缩放到 maxRes，不裁剪、不添加黑边
            const scale = Math.min(1, maxRes / Math.max(bitmap.width, bitmap.height));
            const w = Math.max(1, Math.round(bitmap.width * scale));
            const h = Math.max(1, Math.round(bitmap.height * scale));

            const out = document.createElement("canvas");
            out.width = w;
            out.height = h;
            const octx = out.getContext("2d");
            octx.drawImage(bitmap, 0, 0, w, h);

            const dataUrl = out.toDataURL("image/jpeg", 0.85);
            const base64 = dataUrl.split(",")[1];
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            const buffer = bytes.buffer;

            await api.writeBinaryFile(normalizePath(`${cacheDir}/${key}.jpg`), buffer);
            return key;
        } finally {
            bitmap.close();
        }
    })();

    genQueue.set(key, promise);
    try {
        return await promise;
    } finally {
        genQueue.delete(key);
    }
}

// 为一批图片生成缩略图（用于后台预生成），带并发控制
// onProgress: (done, total) => void
export async function generateThumbnailsBatch(imgPaths, maxRes, mtimes, concurrency = 4, onProgress = null) {
    const total = imgPaths.length;
    let done = 0;
    const queue = [...imgPaths];

    async function worker() {
        while (queue.length > 0) {
            const imgPath = queue.shift();
            const mtime = mtimes && mtimes[imgPath] ? mtimes[imgPath] : 0;
            try {
                await generateThumbnail(imgPath, maxRes, mtime);
            } catch (e) {
                // 单张失败不中断
            }
            done++;
            if (onProgress) onProgress(done, total);
        }
    }

    const workers = [];
    const n = Math.max(1, Math.min(concurrency, total));
    for (let i = 0; i < n; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
}

// 获取展示用 URL：优先使用缩略图缓存，否则返回原图 URL 并后台生成
export async function getThumbUrl(imgPath, maxRes, mtime) {
    if (!maxRes || maxRes <= 0) {
        return getOriginalImageUrl(imgPath);
    }
    const key = getCacheKey(imgPath, maxRes, mtime);
    if (await thumbCacheExists(key)) {
        return getThumbCacheUrl(key);
    }
    // 后台生成（不阻塞返回）
    generateThumbnail(imgPath, maxRes, mtime).catch(() => {});
    return getOriginalImageUrl(imgPath);
}

// 清除所有缩略图缓存，返回清除的文件数
export async function clearThumbCache() {
    if (!cacheDir) await initThumbnails();
    let count = 0;
    try {
        const files = await Neutralino.filesystem.readDirectory(cacheDir);
        for (const f of files) {
            if (f.type === "FILE" && f.entry.endsWith(".jpg")) {
                await api.removeFile(normalizePath(`${cacheDir}/${f.entry}`));
                count++;
            }
        }
    } catch (e) { }
    return count;
}
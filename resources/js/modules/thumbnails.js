// thumbnails.js - 缩略图生成与缓存（Canvas 前端生成）
// 缓存目录: {NL_PATH}/cache/thumbnails/{md5(absPath_maxRes_mtime)}.jpg
// 与 Python 版缓存命名一致，便于复用已有缓存

import * as api from "./api.js";
import { md5, normalizePath, encodePathUrl } from "./utils.js";

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
    try {
        cacheUrl = await api.mountDir(cacheDir);
    } catch (e) {
        // 挂载失败不应导致整个应用无法启动：退化为无缩略图缓存（原图 URL 仍可用）
        console.error("mount thumbnail cache failed", e);
        cacheUrl = "";
    }
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

// 合并路径中的重复分隔符（listFiles 在目录带结尾斜杠时会生成 "E:/data//a.jpg"）
function collapseSlashes(p) {
    return normalizePath(p).replace(/\/{2,}/g, "/");
}

// 规范化目录路径：合并重复分隔符并去掉尾部分隔符，便于做前缀比较
function normalizeDirPath(p) {
    return collapseSlashes(p).replace(/\/+$/, "");
}

// 判断 imgPath 是否位于已挂载的数据集目录内。
// Windows 路径大小写不敏感，比较时统一转小写，避免 "E:/Data" 与 "E:/data/a.jpg" 判定失败。
function isUnderDir(p, dir) {
    if (!dir) return false;
    const a = collapseSlashes(p);
    const b = collapseSlashes(dir);
    const isWin = /^[a-zA-Z]:/.test(b) || b.startsWith("//");
    if (isWin) {
        const la = a.toLowerCase(), lb = b.toLowerCase();
        return la === lb || la.startsWith(lb + "/");
    }
    return a === b || a.startsWith(b + "/");
}

// 挂载数据集目录，返回 URL 前缀
export async function mountDataset(dir) {
    const dirKey = normalizeDirPath(dir);
    // 若相同目录已挂载则直接复用
    if (datasetUrl && datasetMountedDir === dirKey) {
        return datasetUrl;
    }
    // 先挂载新目录（失败会抛错，由调用方提示），成功后才切换 URL，
    // 避免切换失败后仍用无效前缀去拼图片地址
    const url = await api.mountDir(dir);
    const prevUrl = datasetUrl;
    datasetUrl = url;
    datasetMountedDir = dirKey;
    // 新挂载就绪后再延迟卸载旧挂载：切换瞬间仍在加载的图片请求不会被提前掐断成 404
    if (prevUrl && prevUrl !== url) {
        setTimeout(() => {
            if (prevUrl !== datasetUrl) api.unmountDir(prevUrl);
        }, 8000);
    }
    return url;
}

// 获取数据集中图片的原始 URL（用于生成缩略图）
// 路径不在当前已挂载的数据集目录内时返回空字符串，避免构造出错误的 URL
export function getOriginalImageUrl(imgPath) {
    if (!datasetUrl || !datasetMountedDir) return "";
    const n = collapseSlashes(imgPath);
    const dir = collapseSlashes(datasetMountedDir);
    if (!isUnderDir(n, dir)) return "";
    const rel = n.slice(dir.length).replace(/^[/\\]+/, "");
    if (!rel) return "";
    return `${datasetUrl}/${encodePathUrl(rel)}`;
}

// 获取缓存缩略图的 URL（缓存目录挂载失败时返回空串，调用方需回退到原图）
export function getThumbCacheUrl(key) {
    if (!cacheUrl) return "";
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
// api.js - Neutralino 文件系统/系统 API 封装

import { normalizePath } from "./utils.js";

// 应用根目录
export const APP_DIR = NL_PATH;

// 支持的图片扩展名（小写，含点）
const IMAGE_EXTS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".avif", ".ico"
]);

export function isImagePath(p) {
    const n = normalizePath(p);
    const idx = n.lastIndexOf(".");
    if (idx < 0) return false;
    const ext = n.slice(idx).toLowerCase();
    return IMAGE_EXTS.has(ext);
}

// 检查路径是否存在
export async function pathExists(p) {
    try {
        await Neutralino.filesystem.getStats(p);
        return true;
    } catch (e) {
        return false;
    }
}

// 获取文件状态
export async function getStats(p) {
    try {
        return await Neutralino.filesystem.getStats(p);
    } catch (e) {
        return null;
    }
}

// 创建目录（递归）
export async function createDirectory(p) {
    try {
        await Neutralino.filesystem.createDirectory(p);
    } catch (e) {
        // 目录已存在则忽略
        if (!String(e.code || e.message || e).includes("DIRCRER")) {
            throw e;
        }
    }
}

// 递归读取目录，返回所有文件绝对路径（统一正斜杠）
export async function listFilesRecursive(dir) {
    const results = [];
    const root = normalizePath(dir);
    async function walk(current, rel) {
        let entries;
        try {
            entries = await Neutralino.filesystem.readDirectory(current);
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            const absPath = normalizePath(`${current}/${entry.entry}`);
            if (entry.type === "DIRECTORY") {
                await walk(absPath, rel ? `${rel}/${entry.entry}` : entry.entry);
            } else if (entry.type === "FILE") {
                results.push(absPath);
            }
        }
    }
    await walk(root, "");
    return results;
}

// 非递归读取目录文件
export async function listFiles(dir) {
    const results = [];
    const root = normalizePath(dir);
    try {
        const entries = await Neutralino.filesystem.readDirectory(root);
        for (const entry of entries) {
            if (entry.type === "FILE") {
                results.push(normalizePath(`${root}/${entry.entry}`));
            }
        }
    } catch (e) {
        return results;
    }
    return results;
}

// 读取文本文件（UTF-8）
export async function readTextFile(p) {
    try {
        return await Neutralino.filesystem.readFile(p);
    } catch (e) {
        return null;
    }
}

// 写入文本文件（UTF-8）
export async function writeTextFile(p, data) {
    try {
        await Neutralino.filesystem.writeFile(p, data);
        return true;
    } catch (e) {
        return false;
    }
}

// 读取二进制文件为 ArrayBuffer
export async function readBinaryFile(p) {
    try {
        return await Neutralino.filesystem.readBinaryFile(p);
    } catch (e) {
        return null;
    }
}

// 写入二进制文件
export async function writeBinaryFile(p, data) {
    try {
        await Neutralino.filesystem.writeBinaryFile(p, data);
        return true;
    } catch (e) {
        return false;
    }
}

// 读取图片头部解析宽高（PNG/JPEG/GIF/BMP/WebP），返回 { w, h } 或 null
export async function getImageSize(p) {
    const buffer = await readBinaryFile(p);
    if (!buffer) return null;
    const b = new Uint8Array(buffer);
    if (b.length < 8) return null;

    // PNG：8 字节签名后为 IHDR，宽高为大端 4 字节
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        if (b.length < 24) return null;
        return {
            w: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19],
            h: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23],
        };
    }

    // GIF：第 6/7 字节宽，第 8/9 字节高（小端）
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
    }

    // BMP：第 18 字节起为宽高（小端 4 字节）
    if (b[0] === 0x42 && b[1] === 0x4d) {
        if (b.length < 26) return null;
        return {
            w: ((b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24)) >>> 0),
            h: ((b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24)) >>> 0),
        };
    }

    // JPEG：扫描 SOF 标记读取宽高（大端）
    if (b[0] === 0xff && b[1] === 0xd8) {
        let i = 2;
        while (i < b.length - 8) {
            if (b[i] !== 0xff) { i++; continue; }
            const marker = b[i + 1];
            // 跳过无长度段的标记
            if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
            const len = (b[i + 2] << 8) | b[i + 3];
            // SOF0-15（排除 DHT C4 / JPG C8 / DAC CC）
            if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return {
                    h: (b[i + 5] << 8) | b[i + 6],
                    w: (b[i + 7] << 8) | b[i + 8],
                };
            }
            i += 2 + len;
        }
        return null;
    }

    // WebP：RIFF....WEBP，支持 VP8 / VP8L / VP8X
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        if (b.length >= 30 && b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x20) {
            // VP8：宽高在 26-29 字节（各 14 位小端）
            return {
                w: b[26] | ((b[27] & 0x3f) << 8),
                h: b[28] | ((b[29] & 0x3f) << 8),
            };
        }
        if (b.length >= 30 && b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x4c) {
            // VP8L：宽高在 21-24 字节，各 14 位交错
            const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
            return {
                w: (bits & 0x3fff) + 1,
                h: ((bits >> 14) & 0x3fff) + 1,
            };
        }
        if (b.length >= 30 && b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58) {
            // VP8X：宽高在 24-29 字节（各 24 位）
            return {
                w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
                h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
            };
        }
        return null;
    }

    return null;
}

// 将 ArrayBuffer 转换为 Blob
export function bufferToBlob(buffer, type) {
    return new Blob([buffer], { type: type || "application/octet-stream" });
}

// 将 ArrayBuffer 转换为 Blob URL（用于 <img> 显示）
export function bufferToObjectUrl(buffer, type) {
    const blob = bufferToBlob(buffer, type);
    return URL.createObjectURL(blob);
}

// 移动文件或目录
export async function moveFile(src, dest) {
    try {
        await Neutralino.filesystem.move(src, dest);
        return true;
    } catch (e) {
        return false;
    }
}

// 删除文件或目录
export async function removeFile(p) {
    try {
        await Neutralino.filesystem.remove(p);
        return true;
    } catch (e) {
        return false;
    }
}

// 移动到系统回收站
export async function trashItem(p) {
    try {
        await Neutralino.os.trashItem(p);
        return true;
    } catch (e) {
        return false;
    }
}

// 复制文件或目录
export async function copyFile(src, dest) {
    try {
        await Neutralino.filesystem.copy(src, dest);
        return true;
    } catch (e) {
        return false;
    }
}

// 显示文件夹选择对话框
export async function showFolderDialog(title, defaultPath) {
    try {
        const opts = {};
        if (defaultPath) opts.defaultPath = defaultPath;
        return await Neutralino.os.showFolderDialog(title, opts);
    } catch (e) {
        return null;
    }
}

// 显示消息框
export async function showMessageBox(title, content, choice, icon) {
    try {
        return await Neutralino.os.showMessageBox(title, content, choice, icon);
    } catch (e) {
        return null;
    }
}

// 显示通知
export async function showNotification(title, content, icon) {
    try {
        await Neutralino.os.showNotification(title, content, icon);
    } catch (e) { }
}

// 挂载本地目录到静态服务器，返回 URL 前缀
let mountCounter = 0;
export async function mountDir(path) {
    const n = normalizePath(path);
    const target = `/dte-mount-${mountCounter++}`;
    try {
        await Neutralino.server.mount(target, n);
        return target;
    } catch (e) {
        // 可能已挂载，尝试获取现有挂载
        return target;
    }
}

// 卸载目录
export async function unmountDir(target) {
    try {
        await Neutralino.server.unmount(target);
    } catch (e) { }
}

// 获取图片的访问 URL（通过 server mount）
// 返回 relative URL 如 /dte-mount-0/image.png
export function getMountedUrl(mountPrefix, filePath) {
    const n = normalizePath(filePath);
    // mountPrefix 对应路径 n 的根
    const rel = n.split("/").map(seg => encodeURIComponent(seg)).join("/");
    return `${mountPrefix}/${rel}`;
}

// 应用路径（NL_PATH）
export function appPath() {
    return NL_PATH;
}
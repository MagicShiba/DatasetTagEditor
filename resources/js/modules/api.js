// api.js - Neutralino 文件系统/系统 API 封装

import { normalizePath, getDirname } from "./utils.js";

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

// 在系统资源管理器中定位文件（打开所在文件夹并选中该文件）
export async function revealInExplorer(p) {
    try {
        const clean = String(p || "").replace(/"/g, "");
        if (!clean) return false;
        const os = window.NL_OS || "";
        if (os === "Windows") {
            // 路径转反斜杠，避免正斜杠被 explorer 误解析
            await Neutralino.os.execCommand(`explorer /select,"${clean.replace(/\//g, "\\")}"`);
        } else if (os === "Darwin") {
            await Neutralino.os.execCommand(`open -R "${clean}"`);
        } else {
            // Linux 无统一选中语义，打开所在文件夹
            await Neutralino.os.open(getDirname(clean));
        }
        return true;
    } catch (e) {
        return false;
    }
}

// ---------------- 目录挂载（静态服务器路由） ----------------
// 注意 Neutralino 的三条实现细节（均会导致图片 404，且「有时才出现」）：
// 1) 路由是前缀匹配：pathname.find(mountedPath) == 0，所以前缀不能互为前缀。
//    若用 /dte-mount-1 这类变长名字，遗留的 /dte-mount-1 会截走 /dte-mount-10/xxx.jpg
//    的请求，映射到别的目录 → 404。这里统一用等长编号，任意两个前缀互不为前缀。
// 2) server.mount 在「目录不存在 / 前缀已被占用」时会失败（SDK reject），
//    旧实现把错误吞掉并照常返回前缀，之后所有图片请求全部 404（缩略图走缓存挂载，
//    仍然正常显示）——表现为「有缩略图、预览空白」。
// 3) 页面刷新（如 F5、恢复默认设置）后 JS 里的计数器归零，但服务器上的挂载仍然存在，
//    新会话再次申请同样的前缀会失败。必须先用 getMounts 校验/清理。
const MOUNT_PREFIX_BASE = "/dte-mnt-";
let mountSeq = 0;

// 读取服务器当前挂载表 { url前缀: 本地目录 }
export async function getMounts() {
    try {
        const res = await Neutralino.server.getMounts();
        return res && typeof res === "object" ? res : {};
    } catch (e) {
        return {};
    }
}

// 卸载目录，成功返回 true（未挂载时静默失败）
export async function unmountDir(target) {
    try {
        await Neutralino.server.unmount(target);
        return true;
    } catch (e) {
        return false;
    }
}

// 清理本应用遗留的挂载点（页面刷新后旧挂载仍指向旧数据集，会占用前缀）
export async function clearStaleMounts() {
    const mounts = await getMounts();
    let count = 0;
    for (const p of Object.keys(mounts)) {
        if (p.startsWith(MOUNT_PREFIX_BASE) && await unmountDir(p)) count++;
    }
    mountSeq = 0;
    return count;
}

// 挂载本地目录，成功返回 URL 前缀（不带结尾斜杠），失败抛出异常。
// 调用方必须处理异常，不能继续使用未真正生效的前缀。
export async function mountDir(path) {
    const n = normalizePath(path);
    const expect = n.replace(/\/+$/, "");
    let lastErr = null;
    for (let attempt = 0; attempt < 20; attempt++) {
        // 等长编号（000~999）保证前缀之间不会互相截获请求
        const target = MOUNT_PREFIX_BASE + String(mountSeq++ % 1000).padStart(3, "0");
        for (let retry = 0; retry < 2; retry++) {
            lastErr = null;
            let mounted = false;
            try {
                await Neutralino.server.mount(target, n);
                mounted = true;
            } catch (e) {
                lastErr = e;
            }
            if (mounted) {
                // 校验本次挂载确实指向目标目录：服务器上可能残留同前缀的旧挂载，
                // 只看「前缀存在」会误把旧目录当成新目录（图片 404 的根源之一）
                const mounts = await getMounts();
                const hasTable = Object.keys(mounts).length > 0;
                if (!hasTable) return target;   // 老版本 core 查不到挂载表，信任成功返回
                const got = mounts[target];
                if (got && normalizePath(got).replace(/\/+$/, "") === expect) return target;
            }
            const code = lastErr && lastErr.code;
            // 前缀被遗留挂载占用：清掉后重试同一前缀；其它错误（目录不存在等）换前缀也没用
            if (code !== "NE_SR_MPINUSE") break;
            await unmountDir(target);
        }
        if (lastErr && lastErr.code !== "NE_SR_MPINUSE") throw lastErr;
    }
    throw lastErr || new Error("mount failed: no free mount prefix");
}
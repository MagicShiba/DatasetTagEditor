// app.js - 全局应用状态与共享更新逻辑

import { DatasetTagEditor } from "./dataset.js";
import { PathFilter, FilterMode } from "./dataset.js";
import { joinTagsWithSepts } from "./dataset.js";
import * as api from "./api.js";
import * as thumbs from "./thumbnails.js";
import { config, settings, getSetting } from "./config.js";
import { t } from "./i18n.js";
import { normalizePath, getStem, getExtension, getBasename, setTagSeparators } from "./utils.js";

class App {
    constructor() {
        this.dte = new DatasetTagEditor();
        this.ready = false;

        // 画廊状态
        this.gallerySelectedIndex = -1;
        this.gallerySelectedPath = "";
        this.galleryPaths = []; // 当前画廊显示的路径（已排序）
        this.galleryState = {}; // key -> text
        this.galleryMultiSelected = new Set(); // Ctrl 多选选中的路径

        // 画廊排序方式：key 为 name/resolution/mtime，dir 为 1（升序）或 -1（降序）
        this.gallerySort = { key: "name", dir: 1 };

        // 画廊显示方式：grid（网格）或 list（列表，行内显示标注文本）
        this.galleryDisplay = "grid";

        // 选择筛选状态
        this.tmpSelection = new Set();
        this.pathFilter = new PathFilter();

        // 过滤器引用（由 UI 模块注册）
        this.filterP = null;   // TagFilterState 正向
        this.filterN = null;   // TagFilterState 反向

        // 编辑选中状态
        this.changeIsSaved = true;   // 文本区内容是否已应用到内存数据
        this.datasetDirty = false;   // 内存数据是否有未写回磁盘的修改
        this.prevEditText = "";
    }

    // 当前使用的全部过滤器
    getFilters() {
        const filters = [];
        if (this.filterP) filters.push(this.filterP.getFilter());
        if (this.filterN) filters.push(this.filterN.getFilter());
        filters.push(this.pathFilter);
        return filters;
    }

    // 获取除指定筛选器之外的其他筛选器
    getOtherFilters(except) {
        const filters = [];
        if (this.filterP && this.filterP !== except) filters.push(this.filterP.getFilter());
        if (this.filterN && this.filterN !== except) filters.push(this.filterN.getFilter());
        if (this.pathFilter !== except) filters.push(this.pathFilter);
        return filters;
    }

    // 注册画廊状态值
    registerGalleryState(key, value) {
        this.galleryState[key] = value;
        const el = document.getElementById("gallery_state_txt");
        if (el) {
            let html = "";
            for (const [k, v] of Object.entries(this.galleryState)) {
                html += `${k} : ${v}<br>`;
            }
            el.innerHTML = html;
        }
    }

    clearGalleryState() {
        this.galleryState = {};
        const el = document.getElementById("gallery_state_txt");
        if (el) el.innerHTML = "";
    }
}

// 全局应用实例
export const app = new App();
window.__app = app;

// 标签筛选变化回调（由 UI 模块注册，触发画廊等刷新）
app.onTagFilterChanged = null;

// ================================================================
// 全局初始化
// ================================================================

export async function initApp() {
    await config.load();
    await settings.load();
    // 应用标签分隔符设置（加载标注时按此拆分标签）
    setTagSeparators(getSetting("tag_separators"));

    // 应用语言：先加载语言包（settings.load 已调用 setLang 设置当前语言）
    const { applyI18n, discoverLanguages } = await import("./i18n.js");
    await applyI18n();
    // 预发现可用语言包（设置界面的语言下拉框使用）
    discoverLanguages().catch(() => {});

    // 初始化缩略图系统
    await thumbs.initThumbnails();

    // 启动时清除缩略图缓存（若设置启用）
    if (getSetting("cleanup_tmpdir")) {
        await thumbs.clearThumbCache();
    }

    // 设置列数
    applyColumns();

    app.ready = true;
    return app;
}

// 应用画廊列数：根据单张缩略图的显示宽度设置与容器宽度自适应计算
export function applyColumns() {
    const cellWidth = Math.max(1, getSetting("gallery_image_width") || 128);
    document.querySelectorAll(".gallery-grid").forEach(el => {
        const w = el.clientWidth;
        const cols = Math.max(1, Math.floor((w + 2) / (cellWidth + 2)));
        el.style.setProperty("--cols", cols);
        // 列表显示方式下缩略图宽度与网格一致（使用同一设置）
        el.style.setProperty("--thumb-w", cellWidth + "px");
    });
}

// ================================================================
// 画廊排序
// ================================================================

// 图像宽高缓存（用于按分辨率/比例排序，缓存键为路径，值为 { w, h }）
const imageDimsCache = new Map();

async function getImageDims(path) {
    if (imageDimsCache.has(path)) return imageDimsCache.get(path);
    return new Promise((resolve) => {
        const url = thumbs.getOriginalImageUrl(path);
        if (!url) {
            imageDimsCache.set(path, { w: 0, h: 0 });
            return resolve({ w: 0, h: 0 });
        }
        const img = new Image();
        const timer = setTimeout(() => {
            img.onload = img.onerror = null;
            imageDimsCache.set(path, { w: 0, h: 0 });
            resolve({ w: 0, h: 0 });
        }, 10000);
        img.onload = () => {
            clearTimeout(timer);
            const dims = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
            imageDimsCache.set(path, dims);
            resolve(dims);
        };
        img.onerror = () => {
            clearTimeout(timer);
            imageDimsCache.set(path, { w: 0, h: 0 });
            resolve({ w: 0, h: 0 });
        };
        img.src = url;
    });
}

async function getImageArea(path) {
    const { w, h } = await getImageDims(path);
    return w * h;
}

// 图像与 1:1 的偏离程度（|宽高比-1|），越接近 1:1 值越小，用于按比例排序
async function getAspectDeviation(path) {
    const { w, h } = await getImageDims(path);
    if (!w || !h) return 1e9; // 未知尺寸排到最后
    return Math.abs(w / h - 1);
}

// 文件修改时间缓存（用于按修改时间排序）
const mtimeCache = new Map();

async function getFileMtime(path) {
    if (mtimeCache.has(path)) return mtimeCache.get(path);
    try {
        const st = await api.getStats(path);
        const m = st && st.mtime ? Number(st.mtime) : 0;
        mtimeCache.set(path, m);
        return m;
    } catch {
        mtimeCache.set(path, 0);
        return 0;
    }
}

// 按当前排序方式对画廊路径排序
// name 为同步排序；resolution / mtime / aspect 需要读取文件信息，为异步
export async function sortGalleryPaths(paths) {
    const { key, dir } = app.gallerySort;
    if (key === "resolution" || key === "mtime" || key === "aspect") {
        const keyFn = key === "resolution" ? getImageArea
            : key === "mtime" ? getFileMtime
            : getAspectDeviation;
        const items = await Promise.all(paths.map(async p => ({ p, v: await keyFn(p) })));
        items.sort((a, b) => (a.v - b.v) * dir || a.p.localeCompare(b.p));
        return items.map(x => x.p);
    }
    if (key === "edit") {
        // 编辑状态排序：红点(0) → 绿点(1) → 无标记(2)，dir 决定整体顺序，红点在前或最后
        const status = p => {
            const d = app.dte.dataset.getData(p);
            if (d && d.missing_caption && !(d.applied && d.tags.length > 0)) return 0;
            if (d && d.applied && d.tags.length > 0) return 1;
            return 2;
        };
        return [...paths].sort((a, b) => (status(a) - status(b)) * dir || dir * a.localeCompare(b));
    }
    return [...paths].sort((a, b) => dir * a.localeCompare(b));
}

// ================================================================
// 画廊渲染（懒加载缩略图）
// ================================================================

// 缩略图 URL 内存缓存：key = `${path}|${maxRes}`，避免重复调用原生 API
const thumbUrlCache = new Map();
function thumbCacheKey(path, maxRes) {
    return `${path}|${maxRes}`;
}
export function invalidateThumbUrlCache() {
    thumbUrlCache.clear();
}

const PLACEHOLDER_SRC = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const ERROR_SRC = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect fill='%23333' width='100' height='100'/></svg>";

// 渲染画廊到指定容器
// opts: { el, paths, selectedIndex, onSelect, renderThumbs }
// 复用已存在的缩略图 item（按路径匹配），刷新时不会闪黑/重新加载
export function renderGallery(opts) {
    const { el, paths, selectedIndex = -1, onSelect, useThumbs = true, multiSelected } = opts;
    const maxRes = useThumbs ? (getSetting("max_resolution") || 0) : 0;

    el.classList.toggle("list", app.galleryDisplay === "list");
    el.classList.remove("thumb-loading");

    if (!paths || paths.length === 0) {
        el.innerHTML = '<div class="small-note">(empty)</div>';
        return;
    }

    // 清除上次的占位文本（如 "(empty)"），避免残留占用格子
    el.querySelectorAll(":scope > *:not(.thumb-item)").forEach(n => n.remove());

    // 收集现有 item（按路径）
    const existing = new Map();
    el.querySelectorAll(".thumb-item").forEach(item => {
        existing.set(item.dataset.path, item);
    });

    const frag = document.createDocumentFragment();
    const used = new Set();

    paths.forEach((path, idx) => {
        let item = existing.get(path);
        if (!item) {
            item = document.createElement("div");
            item.className = "thumb-item";
            item.dataset.path = path;
            item.draggable = true;
            item.addEventListener("dragstart", (e) => {
                // 供拖入 LLM 反推管理窗口使用
                e.dataTransfer.setData("text/plain", path);
                e.dataTransfer.effectAllowed = "copy";
            });
            const imgWrap = document.createElement("div");
            imgWrap.className = "thumb-img";
            const img = document.createElement("img");
            img.alt = "";
            img.loading = "lazy";
            img.src = PLACEHOLDER_SRC;
            imgWrap.appendChild(img);
            item.appendChild(imgWrap);
            item.addEventListener("click", (e) => {
                if (onSelect) onSelect(Number(item.dataset.index), path, e);
            });
        }
        item.dataset.index = idx;
        // 高亮：单选索引或 Ctrl 多选集合中的路径
        item.classList.toggle("selected", idx === selectedIndex || (multiSelected && multiSelected.has(path)));
        // 列表模式下整行不拖动，允许标准文本选中/复制；仅缩略图本身可拖（拖入 LLM 反推管理窗口）
        item.draggable = app.galleryDisplay !== "list";
        syncThumbBadge(item, path);
        syncThumbName(item, path);
        syncThumbCaption(item, path);
        used.add(path);
        frag.appendChild(item);
    });

    // 移除不再显示的 item
    existing.forEach((item, path) => {
        if (!used.has(path)) {
            const img = item.querySelector("img");
            if (img) img.dataset.scheduled = "";
            item.remove();
        }
    });

    // 为新 item 填充缩略图；命中缓存直接设置 src
    // 先收集再 append，避免 frag 被清空后无法查询
    const newImgs = [];
    frag.querySelectorAll(".thumb-item img").forEach(img => newImgs.push(img));

    el.appendChild(frag);

    newImgs.forEach(img => {
        const item = img.closest(".thumb-item");
        const path = item.dataset.path;
        if (img.dataset.loaded === "1" && img.dataset.res === String(maxRes)) return;
        img.dataset.res = String(maxRes);
        if (img.dataset.scheduled === "1") return;
        const ck = thumbCacheKey(path, maxRes);
        if (thumbUrlCache.has(ck)) {
            img.src = thumbUrlCache.get(ck);
            img.onerror = () => { img.src = ERROR_SRC; };
            img.dataset.loaded = "1";
        } else {
            scheduleThumbLoad(img, path, maxRes);
        }
    });
}

// 缩略图上同步状态角标：
// - 红点：加载时缺失文本文件，且尚未打标
// - 绿点（半透明、显眼）：用户已编辑并通过"将更改应用于图像"应用了非空标注
// - 黄点：原本无标注，通过 LLM 反推打标得到非空标注（未被用户应用）
function syncThumbBadge(item, path) {
    const data = app.dte.dataset.getData(path);
    // 空标注时 Data.tags 为 [""]，需排除空字符串后再判定是否真正有内容
    const hasContent = !!(data && data.tags.some(t => t));
    const showGreen = !!(data && data.applied && hasContent);
    const showYellow = !!(data && data.reversed && hasContent && !showGreen);
    const showRed = !!(data && data.missing_caption && !hasContent);
    let badge = null;
    const imgWrap = item.querySelector(".thumb-img");
    if (imgWrap) {
        for (const child of imgWrap.children) {
            if (child.classList && child.classList.contains("thumb-badge")) {
                badge = child;
                break;
            }
        }
    }
    if (showRed || showYellow || showGreen) {
        if (!badge && imgWrap) {
            badge = document.createElement("span");
            badge.className = "thumb-badge";
            imgWrap.appendChild(badge);
        }
        if (badge) {
            badge.classList.toggle("applied", showGreen);
            badge.classList.toggle("reversed", showYellow);
            badge.title = showGreen ? t("gallery.edited_badge")
                : showYellow ? t("gallery.reversed_badge")
                : t("gallery.missing_caption_badge");
        }
    } else if (badge) {
        badge.remove();
    }
}

// 缩略图底部图像名称（悬停时显示）：位于图像浮层内，网格/列表模式一致
function syncThumbName(item, path) {
    const imgWrap = item.querySelector(".thumb-img");
    if (!imgWrap) return;
    let name = imgWrap.querySelector(".thumb-name");
    if (!name) {
        name = document.createElement("span");
        name.className = "thumb-name";
        imgWrap.appendChild(name);
    }
    name.textContent = getBasename(path);
}

// 列表显示方式下同步标注文本：显示原始文本（仅裁剪首尾空白，不经过标签编辑处理）
function syncThumbCaption(item, path) {
    let cap = item.querySelector(".thumb-caption");
    if (app.galleryDisplay !== "list") {
        if (cap) cap.remove();
        return;
    }
    if (!cap) {
        cap = document.createElement("div");
        cap.className = "thumb-caption";
        item.appendChild(cap);
    }
    const data = app.dte.dataset.getData(path);
    cap.textContent = data ? joinTagsWithSepts(data.tags, data.septs) : "";
}

// LLM 反推 / 应用更改后刷新指定缩略图的状态角标
export function updateThumbBadge(path) {
    document.querySelectorAll(".thumb-item").forEach(item => {
        if (item.dataset.path === path) syncThumbBadge(item, path);
    });
}

// 应用更改 / 反推后刷新指定缩略图的名称与标注文本（列表模式显示文本）
export function updateThumbCaption(path) {
    document.querySelectorAll(".thumb-item").forEach(item => {
        if (item.dataset.path !== path) return;
        syncThumbName(item, path);
        syncThumbCaption(item, path);
    });
}

// 使用 requestIdleCallback 分批填充缩略图，避免一次性全部加载
let thumbQueue = [];
let thumbScheduled = false;

function scheduleThumbLoad(img, path, maxRes) {
    img.dataset.scheduled = "1";
    thumbQueue.push({ img, path, maxRes });
    if (!thumbScheduled) {
        thumbScheduled = true;
        scheduleThumbFlush();
    }
}

function scheduleThumbFlush() {
    const task = () => {
        thumbScheduled = false;
        // 一次处理一批
        const batch = thumbQueue.splice(0, 30);
        batch.forEach(({ img, path, maxRes }) => loadThumbInto(img, path, maxRes));
        if (thumbQueue.length > 0) {
            thumbScheduled = true;
            scheduleThumbFlush();
        }
    };
    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(task, { timeout: 2000 });
    } else {
        setTimeout(task, 50);
    }
}

async function loadThumbInto(img, path, maxRes) {
    try {
        const ck = thumbCacheKey(path, maxRes);
        if (thumbUrlCache.has(ck)) {
            if (img.isConnected) {
                img.src = thumbUrlCache.get(ck);
                img.dataset.loaded = "1";
            }
            return;
        }
        let mtime = 0;
        const st = await api.getStats(path);
        if (st && st.mtime) mtime = st.mtime;
        let url;
        if (maxRes > 0) {
            const key = thumbs.md5Key(path, maxRes, mtime);
            if (await thumbs.thumbCacheExists(key)) {
                url = thumbs.getThumbCacheUrl(key);
            } else {
                url = thumbs.getOriginalImageUrl(path);
                thumbs.generateThumbnail(path, maxRes, mtime).then(k => {
                    if (k) {
                        const newUrl = thumbs.getThumbCacheUrl(k);
                        thumbUrlCache.set(ck, newUrl);
                        if (img.isConnected) {
                            img.src = newUrl;
                            img.dataset.loaded = "1";
                        }
                    }
                }).catch(() => {});
            }
        } else {
            url = thumbs.getOriginalImageUrl(path);
        }
        if (url) thumbUrlCache.set(ck, url);
        if (img.isConnected) {
            img.src = url;
            img.dataset.loaded = "1";
            img.onerror = () => { img.src = ERROR_SRC; };
        }
    } catch (e) {
        // 忽略加载失败
    }
}

// ================================================================
// 缩略图 key 导出（thumbnails 模块）
// ================================================================

// 更新画廊状态区域
export function updateGalleryStateDisplay(imgs) {
    const total = app.dte.dataset.length;
    const displayed = imgs.length;
    // 附加当前选中的图像序号（显示列表中的位置，1-based）
    let state = `${displayed} / ${total} total`;
    const selIdx = app.gallerySelectedIndex;
    if (selIdx >= 0) state += t("gallery.selected_index").replace("{n}", String(selIdx + 1));
    app.registerGalleryState(t("gallery.displayed_images"), state);
    app.registerGalleryState(t("gallery.current_tag_filter"), currentFilterText());
    app.registerGalleryState(t("gallery.current_selection_filter"), `${app.pathFilter.paths.size} images`);
}

function currentFilterText() {
    let txt = "";
    const p = app.filterP ? app.filterP.getFilter().toString() : "";
    const n = app.filterN ? app.filterN.getFilter().toString() : "";
    if (p) {
        txt += p;
        if (n) txt += " AND ";
    }
    if (n) txt += n;
    return txt;
}

// 打开目录对话框
export async function openFolderDialog() {
    const dir = await api.showFolderDialog("选择数据集目录");
    return dir || "";
}

// 工具函数导出（供其他模块使用）
export { thumbs, api, config, settings, getSetting, t, normalizePath, getStem, getExtension };
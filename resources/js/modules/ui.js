// ui.js - UI 事件绑定与各功能模块初始化

import { app, renderGallery, openFolderDialog, applyColumns, updateGalleryStateDisplay, sortGalleryPaths, invalidateThumbUrlCache, updateThumbBadge, updateThumbCaption } from "./app.js";
import { config, settings, getSetting, setSetting, SETTINGS_DEFAULT, SETTINGS_DESCRIPTIONS, SETTINGS_HIDDEN, LLM_CONFIG_DEFAULT, LLM_FN_DEFAULT, getActiveProfile, setActiveProfile, saveProfile } from "./config.js";
import { t, getLang, setLang, applyI18n, discoverLanguages, getAvailableLanguages } from "./i18n.js";
import { PathFilter, FilterMode, FilterLogic, SortBy, SortOrder, joinTagsWithSepts } from "./dataset.js";
import { TagFilterState } from "./tagfilter_state.js";
import * as api from "./api.js";
import * as thumbs from "./thumbnails.js";
import { normalizePath, getStem, getExtension, withSuffix, getBasename, getDirname, formatAspectRatio, floorToMultiple, splitCaption, splitCaptionWithSepts, setTagSeparators, normalizeSepSpaces } from "./utils.js";
import { parseRules, applyHighlight, escapeHtml } from "./highlight.js";
import { initAutocomplete, loadAutocompleteData, bindAutocomplete } from "./autocomplete.js";
import * as llm from "./llm.js";
import { initBbox, updateBboxes, setOnBboxChange } from "./bbox.js";
import { init as initCapsule, setOnChange as setCapsuleOnChange, refresh as capsuleRefresh, setEnabled as setCapsuleEnabled } from "./capsule.js";

// ================================================================
// 1. 标签筛选（正向/反向/移除）
// ================================================================

function initTagFilters() {
    const elP = document.getElementById("tag-filter-positive");
    const elN = document.getElementById("tag-filter-negative");

    app.filterP = new TagFilterState({ mode: FilterMode.INCLUSIVE, showLogic: true });
    app.filterN = new TagFilterState({ mode: FilterMode.EXCLUSIVE, showLogic: true });

    // 从 config 加载默认
    const cfgP = config.read("filter")?.positive || {};
    const cfgN = config.read("filter")?.negative || {};
    app.filterP.create(elP);
    app.filterN.create(elN);
    app.filterP.applyConfig(cfgP);
    app.filterN.applyConfig(cfgN);

    // 标签筛选变化时刷新画廊
    app.onTagFilterChanged = () => { refreshAll(); };

    // 移除面板中的标签选择
    const elRemove = document.getElementById("tag-select-remove");
    app.removeTagSelect = new TagFilterState({ mode: FilterMode.NONE, showLogic: false });
    app.removeTagSelect.create(elRemove);

    // 清除标签筛选
    document.getElementById("btn_clear_tag_filters").addEventListener("click", () => {
        app.filterP.clearFilter();
        app.filterN.clearFilter();
        refreshAll();
    });

    // 清除所有筛选（含选择筛选）
    document.getElementById("btn_clear_all_filters").addEventListener("click", () => {
        app.filterP.clearFilter();
        app.filterN.clearFilter();
        app.tmpSelection.clear();
        app.pathFilter = new PathFilter();
        app.gallerySelectedIndex = -1;
        app.gallerySelectedPath = "";
        app.galleryMultiSelected.clear();
        const gl = document.getElementById("filter_gallery");
        gl.innerHTML = "";
        refreshAll();
    });
}

// ================================================================
// 2. 全局刷新（画廊 + 状态 + 公共标签 + 选择筛选画廊）
// ================================================================

function refreshAll() {
    const imgs = app.dte.getFilteredImgpaths(app.getFilters());
    updateGallery(imgs);
    updateGalleryStateDisplay(imgs);
    updateCommonTags();
    updateSrSelectedTags();
    updateEditCaptionPanel();
    if (app.removeTagSelect) app.removeTagSelect.update();
    if (app.filterP) app.filterP.update();
    if (app.filterN) app.filterN.update();
}

// 只刷新标签相关面板（不重绘画廊，避免保存标注时画廊无谓刷新）
function refreshTagPanels() {
    updateCommonTags();
    updateSrSelectedTags();
    if (app.removeTagSelect) app.removeTagSelect.update();
    if (app.filterP) app.filterP.update();
    if (app.filterN) app.filterN.update();
}

async function updateGallery(imgs) {
    // 按当前排序方式排序，排序后重新计算选中项索引（跟随选中路径）
    const sorted = await sortGalleryPaths(imgs);
    app.galleryPaths = sorted;
    let selIdx = app.gallerySelectedIndex;
    if (app.gallerySelectedPath) {
        selIdx = sorted.indexOf(app.gallerySelectedPath);
    }
    app.gallerySelectedIndex = selIdx;

    const galleryEl = document.getElementById("dataset_gallery");
    renderGallery({
        el: galleryEl,
        paths: sorted,
        selectedIndex: selIdx,
        multiSelected: app.galleryMultiSelected,
        onSelect: onGallerySelect,
    });
    updateSelectionGallery();
    updatePreview(app.gallerySelectedPath);
}

// 画廊排序控件（在 gallery-label 同一行）
function initGallerySort() {
    const keySel = document.getElementById("gallery_sort_key");
    const dirBtn = document.getElementById("gallery_sort_dir");

    keySel.addEventListener("change", () => {
        app.gallerySort.key = keySel.value;
        refreshAll();
    });

    dirBtn.addEventListener("click", () => {
        app.gallerySort.dir *= -1;
        dirBtn.textContent = app.gallerySort.dir === 1 ? "▲" : "▼";
        dirBtn.title = app.gallerySort.dir === 1 ? t("common.ascending") : t("common.descending");
        refreshAll();
    });

    // 初始同步箭头方向
    dirBtn.textContent = app.gallerySort.dir === 1 ? "▲" : "▼";

    // 画廊显示方式切换：⊞ 网格 / ☰ 列表（列表行内显示标注原始文本）
    const dispBtn = document.getElementById("gallery_display_toggle");
    const syncDispBtn = () => {
        const isList = app.galleryDisplay === "list";
        dispBtn.textContent = isList ? "☰" : "⊞";
        dispBtn.title = isList ? t("gallery.display_list") : t("gallery.display_grid");
    };
    dispBtn.addEventListener("click", () => {
        app.galleryDisplay = app.galleryDisplay === "list" ? "grid" : "list";
        syncDispBtn();
        refreshAll();
    });
    // 初始同步按钮符号与提示
    syncDispBtn();
}

// 原图预览左右边缘点击切换上/下一张图像
function initPreviewNav() {
    document.getElementById("btn_prev_image").addEventListener("click", () => {
        const n = app.galleryPaths.length;
        if (n === 0 || app.gallerySelectedIndex < 0) return;
        const idx = app.gallerySelectedIndex <= 0 ? n - 1 : app.gallerySelectedIndex - 1;
        onGallerySelect(idx, app.galleryPaths[idx]);
    });
    document.getElementById("btn_next_image").addEventListener("click", selectNextImage);
}

// 切换到画廊中当前选中图像的下一张（末张回到第一张）
function selectNextImage() {
    const n = app.galleryPaths.length;
    if (n === 0 || app.gallerySelectedIndex < 0) return;
    const idx = app.gallerySelectedIndex >= n - 1 ? 0 : app.gallerySelectedIndex + 1;
    onGallerySelect(idx, app.galleryPaths[idx]);
}

// 更新中列原图预览
function updatePreview(path) {
    const img = document.getElementById("preview_img");
    if (!img) return;
    // 切换图像时重置缩放与背景
    resetPreviewZoom();
    if (path) {
        const url = thumbs.getOriginalImageUrl(path);
        img.src = url || "";
        img.onerror = () => { img.removeAttribute("src"); updateBboxes(); };
    } else {
        img.removeAttribute("src");
    }
    // 依据编辑框文本同步边界框（图像加载完成后会自动重绘）
    updateBboxes();
}

// 预览背景色：黑、深灰、浅灰、透明，点击按钮轮流切换
const PREVIEW_BG_MODES = ["#000", "#222", "#666", "transparent"];
let previewBgIndex = 0;
function initPreviewBgToggle() {
    const btn = document.getElementById("btn_toggle_preview_bg");
    const box = document.getElementById("image_preview");
    if (!btn || !box) return;
    btn.addEventListener("click", () => {
        previewBgIndex = (previewBgIndex + 1) % PREVIEW_BG_MODES.length;
        box.style.background = PREVIEW_BG_MODES[previewBgIndex];
    });
}

// 预览图像缩放：滚轮向上放大、向下缩小，范围为 1 ~ 20 倍，缩放以鼠标位置为锚点；支持左键拖动平移
let previewZoom = 1;
let previewPan = { x: 0, y: 0 };   // 图像中心的像素偏移（平移量）
let previewDragging = false;
let previewDragStart = { x: 0, y: 0, panX: 0, panY: 0 };

function applyPreviewTransform() {
    const img = document.getElementById("preview_img");
    if (img) img.style.transform = `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`;
}

function resetPreviewZoom() {
    previewZoom = 1;
    previewPan = { x: 0, y: 0 };
    previewDragging = false;
    const img = document.getElementById("preview_img");
    if (img) {
        img.style.transform = "";
        img.style.cursor = "";
    }
    const box = document.getElementById("image_preview");
    if (box) box.classList.remove("dragging-image");
}

function initPreviewZoom() {
    const box = document.getElementById("image_preview");
    const img = document.getElementById("preview_img");
    if (!box || !img) return;

    // 滚轮缩放：保持鼠标位置下的图像点不动
    box.addEventListener("wheel", (e) => {
        if (!img.src) return;
        e.preventDefault();
        const rect = box.getBoundingClientRect();
        const mx = e.clientX - rect.left;   // 鼠标在容器内的坐标
        const my = e.clientY - rect.top;
        const Cx = rect.width / 2;          // 图像中心（transform-origin 为默认 center）
        const Cy = rect.height / 2;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newZoom = Math.min(20, Math.max(1, previewZoom * factor));
        // 锚点公式：新平移量 = 鼠标位置 - 缩放后的(鼠标相对图像中心)距离
        previewPan.x = (mx - Cx) - (mx - Cx - previewPan.x) * (newZoom / previewZoom);
        previewPan.y = (my - Cy) - (my - Cy - previewPan.y) * (newZoom / previewZoom);
        previewZoom = newZoom;
        applyPreviewTransform();
        // 缩放后重绘边界框画布，使其与图像实际显示区域对齐
        updateBboxes();
    }, { passive: false });

    // 左键或中键拖动平移图像（图像或边界框画布空白处按下均可；左键点击命中边界框时由画布交互接管）
    box.addEventListener("mousedown", (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        previewDragging = true;
        previewDragStart = { x: e.clientX, y: e.clientY, panX: previewPan.x, panY: previewPan.y };
        // 标记图像平移中：bbox 画布据此跳过自身的交互与光标更新
        box.classList.add("dragging-image");
        img.style.cursor = "grabbing";
        const canvas = box.querySelector(".bbox-canvas");
        if (canvas) canvas.style.cursor = "grabbing";
        e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
        if (!previewDragging) return;
        previewPan.x = previewDragStart.panX + (e.clientX - previewDragStart.x);
        previewPan.y = previewDragStart.panY + (e.clientY - previewDragStart.y);
        applyPreviewTransform();
        updateBboxes();
    });
    window.addEventListener("mouseup", () => {
        if (!previewDragging) return;
        previewDragging = false;
        box.classList.remove("dragging-image");
        img.style.cursor = "";
        const canvas = box.querySelector(".bbox-canvas");
        if (canvas) canvas.style.cursor = "";
    });
}

// 画廊选择（切换图像时检测未保存修改）
async function onGallerySelect(idx, path, e) {
    // Ctrl/Meta 点击：仅切换多选状态，不切换预览/编辑（避免未保存修改弹窗打断多选）
    if (e && (e.ctrlKey || e.metaKey)) {
        if (app.galleryMultiSelected.has(path)) {
            app.galleryMultiSelected.delete(path);
        } else {
            app.galleryMultiSelected.add(path);
        }
        syncGallerySelectionHighlight();
        return;
    }
    // 普通点击：清空多选，恢复单选
    if (app.galleryMultiSelected.size > 0) {
        app.galleryMultiSelected.clear();
    }
    // 点击同一图像不处理
    if (idx === app.gallerySelectedIndex && path === app.gallerySelectedPath) return;
    // 切换前检测未保存修改
    if (!(await confirmUnsavedSwitch())) return;

    app.gallerySelectedIndex = idx;
    app.gallerySelectedPath = path;
    app.registerGalleryState(t("gallery.selected_image"), path);

    // 异步显示选中图像分辨率、宽高比（两位小数）与最接近的 64 倍数分辨率
    api.getImageSize(path).then(size => {
        if (app.gallerySelectedPath !== path) return; // 期间已切换图像
        const text = size
            ? `${size.w}×${size.h} (${formatAspectRatio(size.w, size.h)}) [${floorToMultiple(size.w)}×${floorToMultiple(size.h)}]`
            : t("gallery.unknown");
        app.registerGalleryState(t("gallery.resolution"), text);
    });

    // 高亮选中
    syncGallerySelectionHighlight();

    // 更新编辑选中图像面板与预览
    updateEditCaptionPanel();
    updatePreview(path);
}

// 同步画廊选中高亮：单选当前路径 + Ctrl 多选集合
function syncGallerySelectionHighlight() {
    document.querySelectorAll("#dataset_gallery .thumb-item").forEach(item => {
        const path = item.dataset.path;
        item.classList.toggle("selected", path === app.gallerySelectedPath || app.galleryMultiSelected.has(path));
    });
}

// 将当前编辑框内容应用到当前选中图像（内存中）
function applyEditToSelected() {
    const ta = document.getElementById("dte_edit_caption");
    // 规范化分隔符后的空格：无则补一个，多个则合并为一个，并写回编辑框
    const text = normalizeSepSpaces(ta.value);
    ta.value = text;
    // 文本被规范化改写后，刷新高亮层、边界框与胶囊标签
    updateHighlightOverlay();
    updateBboxes();
    capsuleRefresh();
    const captionSplit = splitCaptionWithSepts(text);
    const tags = captionSplit.tags;
    const septs = captionSplit.septs;
    let path = null;
    // 优先按选中路径，其次按画廊排序列表中的索引
    if (app.gallerySelectedPath && app.galleryPaths.includes(app.gallerySelectedPath)) {
        path = app.gallerySelectedPath;
    } else {
        const idx = app.gallerySelectedIndex;
        const imgs = app.galleryPaths;
        if (idx >= 0 && idx < imgs.length) {
            path = imgs[idx];
        }
    }
    if (!path) return;
    // 应用非空内容时标记为"已编辑"，用于画廊绿点；空内容不标记
    app.dte.setTagsByImagePath(path, tags, undefined, tags.length > 0, septs);
    // 刷新角标：缺失标记 + 已编辑红/绿点；列表模式同步刷新名称与标注文本
    updateThumbBadge(path);
    updateThumbCaption(path);
    app.changeIsSaved = true;
    app.datasetDirty = true;
}

// 自定义确认对话框（HTML/JS/CSS）
// buttons: [{ key, label, cls }]，返回用户点击按钮的 key；点击遮罩或按 Esc 视为取消
function showConfirmDialog(title, message, buttons) {
    return new Promise((resolve) => {
        const overlay = document.getElementById("confirm_modal");
        const titleEl = overlay.querySelector(".modal-title");
        const msgEl = overlay.querySelector(".modal-message");
        const actionsEl = overlay.querySelector(".modal-actions");

        let done = false;
        const finish = (key) => {
            if (done) return;
            done = true;
            overlay.classList.add("hidden");
            document.removeEventListener("keydown", onKey);
            overlay.removeEventListener("click", onOverlayClick);
            resolve(key);
        };
        const onKey = (e) => { if (e.key === "Escape") finish("cancel"); };
        const onOverlayClick = (e) => { if (e.target === overlay) finish("cancel"); };

        titleEl.textContent = title;
        msgEl.textContent = message;
        actionsEl.innerHTML = "";
        buttons.forEach(btn => {
            const b = document.createElement("button");
            b.className = "btn" + (btn.cls ? " " + btn.cls : "");
            b.textContent = btn.label;
            b.addEventListener("click", () => finish(btn.key));
            actionsEl.appendChild(b);
        });

        document.addEventListener("keydown", onKey);
        overlay.addEventListener("click", onOverlayClick);
        overlay.classList.remove("hidden");
        // 聚焦默认按钮
        const def = actionsEl.querySelector(".btn.primary") || actionsEl.querySelector(".btn");
        if (def) def.focus();
    });
}

// 底部提示（Toast），用于替代浏览器 alert 弹窗
// type: "info" | "success" | "error"，数秒后自动消失，无需点击确认
export function showToast(message, type = "info") {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        container.className = "toast-container";
        document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = "toast" + (type === "success" ? " toast-success" : type === "error" ? " toast-error" : "");
    toast.textContent = message;
    container.appendChild(toast);
    // 下一帧再添加 show 类以触发过渡动画
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("show")));
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

// 切换图像前检测未保存修改，返回是否可继续
// 返回 true 继续切换；false 表示用户取消
async function confirmUnsavedSwitch() {
    if (app.changeIsSaved) return true;
    const warn = document.getElementById("cb_ask_save_when_caption_changed").checked;
    if (!warn) return true;
    const key = await showConfirmDialog(
        t("dialog.switch_image"),
        t("dialog.switch_image_msg"),
        [
            { key: "save", label: t("common.save"), cls: "primary" },
            { key: "discard", label: t("common.dont_save") },
            { key: "cancel", label: t("common.cancel") },
        ]
    );
    if (key === "save") {
        applyEditToSelected();
        return true;
    }
    if (key === "discard") {
        // 用户明确选择不保存，视为已处理该修改
        app.changeIsSaved = true;
        return true;
    }
    return false;
}

// 卸载/切换数据集前检测未保存修改，返回是否可继续
// 除文本区未应用修改外，还检测内存数据中未写回磁盘的修改
async function confirmUnsavedDataset() {
    if (app.changeIsSaved && !app.datasetDirty) return true;
    const warn = document.getElementById("cb_ask_save_when_caption_changed").checked;
    if (!warn) return true;
    const key = await showConfirmDialog(
        t("dialog.switch_dataset"),
        t("dialog.switch_dataset_msg"),
        [
            { key: "save", label: t("common.save"), cls: "primary" },
            { key: "discard", label: t("common.dont_save") },
            { key: "cancel", label: t("common.cancel") },
        ]
    );
    if (key === "save") {
        await saveAllChangesToDisk();
        return true;
    }
    if (key === "discard") {
        // 用户明确选择不保存，视为已处理
        app.changeIsSaved = true;
        app.datasetDirty = false;
        return true;
    }
    return false;
}

// 应用文本区未应用修改，并把内存数据写回磁盘
async function saveAllChangesToDisk() {
    if (!app.changeIsSaved) applyEditToSelected();
    const backup = document.getElementById("cb_backup").checked;
    const captionExt = document.getElementById("tb_caption_file_ext").value.trim() || ".txt";
    await app.dte.saveDataset(backup, captionExt, document.getElementById("cb_remove_newlines").checked);
    app.changeIsSaved = true;
    app.datasetDirty = false;
}

// 关闭程序前检测未保存修改，返回是否允许退出
export async function checkBeforeExit() {
    if (app.changeIsSaved && !app.datasetDirty) return true;
    const warn = document.getElementById("cb_ask_save_when_caption_changed").checked;
    if (!warn) return true;
    const key = await showConfirmDialog(
        t("dialog.confirm_exit"),
        t("dialog.confirm_exit_msg"),
        [
            { key: "save", label: t("dialog.save_exit"), cls: "primary" },
            { key: "discard", label: t("dialog.exit_without_saving") },
            { key: "cancel", label: t("common.cancel") },
        ]
    );
    if (key === "save") {
        await saveAllChangesToDisk();
        return true;
    }
    if (key === "discard") return true;
    // 取消：不退出
    return false;
}

// 选择筛选画廊
function updateSelectionGallery() {
    const el = document.getElementById("filter_gallery");
    const paths = [...app.tmpSelection].sort();
    renderGallery({
        el,
        paths,
        onSelect: (i, p) => {
            app.tmpSelectionSelectedPath = p;
            updateSelectionTxt();
            syncFilterGalleryHighlight();
        },
    });
    // 渲染后统一按当前选中路径同步高亮，避免残留/误高亮
    syncFilterGalleryHighlight();
}

// 同步选择筛选画廊高亮：仅当前选中且仍在选择集合中的路径高亮
function syncFilterGalleryHighlight() {
    document.querySelectorAll("#filter_gallery .thumb-item").forEach(item => {
        item.classList.toggle("selected", !!app.tmpSelectionSelectedPath && item.dataset.path === app.tmpSelectionSelectedPath);
    });
}

function updateSelectionTxt() {
    const el = document.getElementById("txt_selection");
    el.textContent = `${t("gallery.selected_image")} : ${app.tmpSelectionSelectedPath || ""}`;
}

// ================================================================
// 3. 加载/卸载数据集
// ================================================================

// 目录历史上限
const DIR_HISTORY_MAX = 20;

// 读取目录历史（最近加载的在最前）
function getDirHistory() {
    const h = getSetting("dataset_dir_history");
    return Array.isArray(h) ? h : [];
}

// 保存目录历史
async function saveDirHistory(list) {
    setSetting("dataset_dir_history", list);
    await settings.save();
}

// 记录加载过的目录：去重并置顶，最近的在最上面
async function addDirHistory(dir) {
    const list = getDirHistory().filter(d => d !== dir);
    list.unshift(dir);
    if (list.length > DIR_HISTORY_MAX) list.length = DIR_HISTORY_MAX;
    await saveDirHistory(list);
}

// 渲染历史下拉列表
function renderDirHistory() {
    const menu = document.getElementById("dir_history_menu");
    const list = getDirHistory();
    menu.innerHTML = "";
    if (list.length === 0) {
        const empty = document.createElement("div");
        empty.className = "dir-history-empty";
        empty.textContent = t("dir_history.empty");
        menu.appendChild(empty);
        return;
    }
    for (const dir of list) {
        const item = document.createElement("div");
        item.className = "dir-history-item";
        item.title = dir;

        const path = document.createElement("span");
        path.className = "dir-history-path";
        path.textContent = dir;

        const del = document.createElement("button");
        del.type = "button";
        del.className = "dir-history-del";
        del.textContent = "×";
        del.title = t("common.delete");
        del.addEventListener("click", async (e) => {
            e.stopPropagation();
            await saveDirHistory(getDirHistory().filter(d => d !== dir));
            renderDirHistory();
        });

        item.appendChild(path);
        item.appendChild(del);
        item.addEventListener("click", () => {
            document.getElementById("tb_img_directory").value = dir;
            closeDirHistory();
        });
        menu.appendChild(item);
    }
}

function openDirHistory() {
    renderDirHistory();
    document.getElementById("dir_history_menu").classList.remove("hidden");
}

function closeDirHistory() {
    document.getElementById("dir_history_menu").classList.add("hidden");
}

// 设置数据集目录输入框的值并关闭历史下拉
function setDatasetDir(dir) {
    if (!dir) return;
    document.getElementById("tb_img_directory").value = dir;
    closeDirHistory();
}

// 处理拖放得到的路径：目录直接用，文件取其所在目录，然后设置目录并加载数据集
async function applyDroppedPath(path) {
    try {
        const st = await api.getStats(path);
        // getStats 返回的是 isFile/isDirectory 字段（type 字段只存在于 readDirectory 条目）
        const dir = (st && st.isDirectory) ? path : getDirname(path);
        setDatasetDir(dir);
    } catch (e) {
        setDatasetDir(path);
    }
    await doLoadDataset();
}

// 初始化目录历史下拉
function initDirHistoryDropdown() {
    const btn = document.getElementById("btn_dir_history");
    const menu = document.getElementById("dir_history_menu");
    const input = document.getElementById("tb_img_directory");

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menu.classList.contains("hidden")) {
            openDirHistory();
        } else {
            closeDirHistory();
        }
    });

    // 点击输入框也可打开历史
    input.addEventListener("click", (e) => {
        e.stopPropagation();
        openDirHistory();
    });

    // 输入时关闭下拉
    input.addEventListener("input", closeDirHistory);

    // 点击外部关闭
    document.addEventListener("click", (e) => {
        if (!menu.classList.contains("hidden")) {
            if (e.target.closest(".dir-input-wrap")) return;
            closeDirHistory();
        }
    });

    // 系统文件夹选择按钮（点击输入框旁打开文件夹，保留手动输入功能）
    document.getElementById("btn_pick_dir").addEventListener("click", async () => {
        closeDirHistory();
        const dir = await api.showFolderDialog(t("dataset.pick_dir"));
        if (dir) {
            setDatasetDir(dir);
            await doLoadDataset();
        }
    });

    // 原生拖放事件：需要 neutralino.config.json 中 window.emitDropEvents=true
    // 兼容 filesDropped / fileDrop / windowFileDrop 多种事件名及不同的 payload 结构
    const handleNativeFilesDropped = (e) => {
        const detail = e && e.detail;
        let paths = [];
        if (Array.isArray(detail)) {
            paths = detail;
        } else if (detail && Array.isArray(detail.paths)) {
            paths = detail.paths;
        } else if (typeof detail === "string") {
            paths = [detail];
        }
        if (paths.length && paths[0]) {
            applyDroppedPath(paths[0]);
        }
    };

    try {
        if (window.Neutralino && Neutralino.events) {
            Neutralino.events.on("filesDropped", handleNativeFilesDropped);
            Neutralino.events.on("fileDrop", handleNativeFilesDropped);
            Neutralino.events.on("windowFileDrop", handleNativeFilesDropped);
        }
    } catch (e) { /* 浏览器模式下无原生拖放 */ }

    // 阻止浏览器默认拖拽打开文件的行为
    window.addEventListener("dragover", (e) => {
        e.preventDefault();
    });
    window.addEventListener("drop", (e) => {
        e.preventDefault();
    });

    // 「加载数据集」面板区域支持 DOM 拖放与高亮反馈
    const panel = document.getElementById("load-panel");
    if (panel) {
        let dragCounter = 0;
        panel.addEventListener("dragenter", (e) => {
            e.preventDefault();
            dragCounter++;
            panel.classList.add("drag-over");
        });
        panel.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (!panel.classList.contains("drag-over")) {
                panel.classList.add("drag-over");
            }
        });
        panel.addEventListener("dragleave", (e) => {
            e.preventDefault();
            dragCounter = Math.max(0, dragCounter - 1);
            if (dragCounter === 0) {
                panel.classList.remove("drag-over");
            }
        });
        panel.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            panel.classList.remove("drag-over");
            const files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length > 0) {
                const file = files[0];
                // 部分 WebView2 / Electron 环境下 File 对象直接包含 path
                if (file && file.path) {
                    applyDroppedPath(file.path);
                }
            }
        });
    }
}

function initLoadDataset() {
    document.getElementById("btn_load_datasets").addEventListener("click", async () => {
        await doLoadDataset();
    });

    // 「从文件名加载」与「LLM 反推」互斥：勾选一个自动取消另一个
    const cbFilename = document.getElementById("cb_load_caption_from_filename");
    const cbLlmReverse = document.getElementById("cb_load_caption_llm_reverse");
    cbFilename.addEventListener("change", () => {
        if (cbFilename.checked) cbLlmReverse.checked = false;
    });
    cbLlmReverse.addEventListener("change", () => {
        if (cbLlmReverse.checked) cbFilename.checked = false;
    });

    // 目录历史下拉
    initDirHistoryDropdown();

    // 目录选择按钮（点击输入框旁打开文件夹）
    document.getElementById("btn_unload_datasets").addEventListener("click", async () => {
        // 卸载前检测未保存修改
        if (!(await confirmUnsavedDataset())) return;
        // 清空反推队列
        resetLlmReverse();
        app.dte.clear();
        app.clearGalleryState();
        app.tmpSelection.clear();
        app.pathFilter = new PathFilter();
        app.gallerySelectedIndex = -1;
        app.gallerySelectedPath = "";
        app.galleryMultiSelected.clear();
        document.getElementById("dataset_gallery").innerHTML = "";
        document.getElementById("filter_gallery").innerHTML = "";
        document.getElementById("tb_common_tags").value = "";
        document.getElementById("tb_edit_tags").value = "";
        document.getElementById("html_caption_display").innerHTML = "";
        document.getElementById("dte_edit_caption").value = "";
        capsuleRefresh();
        if (app.filterP) app.filterP.clearFilter();
        if (app.filterN) app.filterN.clearFilter();
        if (app.removeTagSelect) app.removeTagSelect.update();
        updatePreview("");
        updateGalleryStateDisplay([]);
    });
}

async function doLoadDataset() {
    // 加载新数据集前检测未保存修改
    if (!(await confirmUnsavedDataset())) return;
    // 清空上一轮的反推队列与画廊多选
    resetLlmReverse();
    app.galleryMultiSelected.clear();

    const dir = document.getElementById("tb_img_directory").value.trim();
    const captionExt = document.getElementById("tb_caption_file_ext").value.trim() || ".txt";
    const recursive = document.getElementById("cb_load_recursive").checked;
    const loadFromFilename = document.getElementById("cb_load_caption_from_filename").checked;
    const replaceNewLine = document.getElementById("cb_replace_new_line_with_comma").checked;
    const loadCaptionFromLlm = document.getElementById("cb_load_caption_llm_reverse").checked;

    if (!dir) {
        showToast("请先输入数据集目录", "error");
        return;
    }

    const btn = document.getElementById("btn_load_datasets");
    const oldText = btn.textContent;
    btn.textContent = "Loading...";
    btn.disabled = true;

    // 挂载目录
    let result = null;
    try {
        await thumbs.mountDataset(dir);
        invalidateThumbUrlCache();
        result = await app.dte.loadDataset(dir, captionExt, recursive, loadFromFilename, replaceNewLine);
        // 记录目录历史（去重置顶）
        await addDirHistory(dir);
        // 生成缩略图（后台）
        if (getSetting("max_resolution") > 0) {
            const mtimes = {};
            for (const p of result.paths) {
                const st = await api.getStats(p);
                mtimes[p] = st ? st.mtime : 0;
            }
            thumbs.generateThumbnailsBatch(result.paths, getSetting("max_resolution"), mtimes, 4, (done, total) => {
                const prog = document.getElementById("gallery_progress");
                if (prog) {
                    prog.hidden = false;
                    prog.textContent = `Thumbnails: ${done}/${total}`;
                    if (done >= total) prog.hidden = true;
                }
            });
        }
    } catch (e) {
        console.error("load failed", e);
        showToast("加载失败: " + (e.message || e), "error");
    } finally {
        btn.textContent = oldText;
        btn.disabled = false;
    }

    // 新数据集与磁盘一致
    app.changeIsSaved = true;
    app.datasetDirty = false;
    refreshAll();
    populateRename();

    // 启用 LLM 反推时，对缺失文本文件的图像启动反推处理
    if (result && loadCaptionFromLlm && result.missingPaths && result.missingPaths.length > 0) {
        startLlmReverseProcess(result.missingPaths);
    } else if (result && result.missingPaths && result.missingPaths.length > 0) {
        showToast(`${t("llm_progress.missing_hint")}: ${result.missingPaths.length}`, "info");
    }
}

// ================================================================
// LLM 反推管理（浮动窗口 + 队列处理 + 画廊拖入）
// ================================================================

// 反推管理器状态：队列、状态、行元素
const llmReverse = {
    paths: [],           // 队列（待处理 / 处理中 / 已完成 / 失败）
    status: new Map(),   // path -> 'pending' | 'processing' | 'done' | 'failed'
    rows: new Map(),     // path -> { row, statusEl, cancelBtn }
    running: false,      // 是否正在执行单个反推任务
};
// 任务代际：数据集重载时递增，使进行中的反推任务失效，避免并发
let llmReverseRunId = 0;
// 窗口是否固定（固定后点击窗口外不关闭）
let llmPinned = false;

// 更新反推窗口固定状态样式
function updateLlmPinState() {
    const panel = document.getElementById("llm_progress_panel");
    if (panel) panel.classList.toggle("pinned", llmPinned);
}

// 清空反推队列（数据集重载 / 卸载时调用）
function resetLlmReverse() {
    llmReverseRunId++;
    llmReverse.paths = [];
    llmReverse.status = new Map();
    llmReverse.rows = new Map();
    llmReverse.running = false;
    const listEl = document.getElementById("llm_progress_list");
    if (listEl) listEl.innerHTML = "";
    updateProgress();
}

// 打开 / 关闭反推管理窗口（可拖动窗口：点击窗口外关闭，拖入图像不触发关闭）
function toggleLlmReversePanel(force) {
    const panel = document.getElementById("llm_progress_panel");
    const show = force !== undefined ? force : panel.classList.contains("hidden");
    if (show) {
        panel.classList.remove("hidden");
        // 首次打开：设置初始尺寸与居中位置（之后拖动/缩放会记住位置）
        if (!panel.style.width || !panel.style.left) {
            const w = Math.min(480, window.innerWidth - 16);
            const h = Math.min(360, Math.max(240, window.innerHeight - 16));
            panel.style.width = w + "px";
            panel.style.height = h + "px";
            panel.style.left = Math.max(0, Math.round((window.innerWidth - w) / 2)) + "px";
            panel.style.top = Math.max(0, Math.round((window.innerHeight - h) / 2)) + "px";
        }
        // 同步追加/覆盖选项
        document.getElementById("cb_llm_reverse_append").checked = getSetting("llm_reverse_append") !== false;
        renderAllRows();
        updateProgress();
    } else {
        panel.classList.add("hidden");
        hideLlmPreview();
    }
}

// 加载完成后启动反推：打开窗口并加入缺失文本文件的图像
function startLlmReverseProcess(missingPaths) {
    toggleLlmReversePanel(true);
    for (const p of missingPaths) addLlmReverseImage(p);
}

// 将图像加入待反推队列（画廊拖入 / 加载缺失文件）；成功加入返回 true
function addLlmReverseImage(path) {
    if (llmReverse.status.has(path)) return false;
    if (!app.dte.dataset.getData(path)) return false;
    llmReverse.paths.push(path);
    llmReverse.status.set(path, "pending");
    renderRow(path);
    updateProgress();
    pumpLlmReverse(); // 空闲则开始处理
    return true;
}

// 从队列移除（取消）：行元素直接删除
function removeLlmReverseImage(path) {
    const info = llmReverse.rows.get(path);
    if (info) info.row.remove();
    llmReverse.rows.delete(path);
    llmReverse.status.delete(path);
    const idx = llmReverse.paths.indexOf(path);
    if (idx >= 0) llmReverse.paths.splice(idx, 1);
    updateProgress();
}

// 渲染单行（依据当前状态）
function renderRow(path) {
    const listEl = document.getElementById("llm_progress_list");
    const s = llmReverse.status.get(path) || "pending";

    const row = document.createElement("div");
    row.className = "llm-progress-row";

    const nameEl = document.createElement("span");
    nameEl.className = "llm-progress-name";
    nameEl.textContent = getBasename(path);
    nameEl.title = path;

    const statusEl = document.createElement("span");
    statusEl.className = "llm-progress-status " + s;
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn compact";
    cancelBtn.textContent = t("llm_progress.cancel");
    cancelBtn.addEventListener("click", () => removeLlmReverseImage(path));

    if (s === "done") {
        statusEl.textContent = t("llm_progress.done");
        cancelBtn.disabled = true;
    } else if (s === "failed") {
        statusEl.textContent = t("llm_progress.failed");
    } else if (s === "processing") {
        statusEl.textContent = t("llm_progress.processing");
    } else {
        statusEl.textContent = t("llm_progress.pending");
    }

    row.appendChild(nameEl);
    row.appendChild(statusEl);
    row.appendChild(cancelBtn);
    // 悬停行时显示对应的图像预览
    row.addEventListener("mouseenter", (e) => showLlmPreview(path, e.clientX, e.clientY));
    row.addEventListener("mousemove", (e) => moveLlmPreview(e.clientX, e.clientY));
    row.addEventListener("mouseleave", hideLlmPreview);
    listEl.appendChild(row);
    llmReverse.rows.set(path, { row, statusEl, cancelBtn });
}

// 反推列表悬停预览：在鼠标附近显示对应图像
function showLlmPreview(path, x, y) {
    const img = document.getElementById("llm_progress_preview");
    if (!img) return;
    img.src = thumbs.getOriginalImageUrl(path);
    img.classList.remove("hidden");
    positionLlmPreview(img, x, y);
}

// 鼠标移动时跟随定位
function moveLlmPreview(x, y) {
    const img = document.getElementById("llm_progress_preview");
    if (img && !img.classList.contains("hidden")) positionLlmPreview(img, x, y);
}

// 将预览定位到鼠标右下侧，空间不足时移到左上侧，避免超出窗口
function positionLlmPreview(img, x, y) {
    const pad = 14;
    const w = img.offsetWidth || 160;
    const h = img.offsetHeight || 160;
    img.style.left = Math.max(4, x + pad) + "px";
    img.style.top = Math.max(4, y + pad) + "px";
    if (x + pad + w > window.innerWidth - 4) img.style.left = Math.max(4, x - pad - w) + "px";
    if (y + pad + h > window.innerHeight - 4) img.style.top = Math.max(4, y - pad - h) + "px";
}

// 隐藏预览
function hideLlmPreview() {
    const img = document.getElementById("llm_progress_preview");
    if (img) img.classList.add("hidden");
}

// 重建全部行（打开窗口时同步当前状态）
function renderAllRows() {
    const listEl = document.getElementById("llm_progress_list");
    listEl.innerHTML = "";
    llmReverse.rows.clear();
    for (const path of llmReverse.paths) renderRow(path);
}

// 更新进度显示（已完成 / 当前相关总数）
function updateProgress() {
    const summaryEl = document.getElementById("llm_progress_summary");
    const fillEl = document.getElementById("llm_progress_fill");
    let done = 0, failed = 0, pending = 0, processing = 0;
    for (const s of llmReverse.status.values()) {
        if (s === "done") done++;
        else if (s === "failed") failed++;
        else if (s === "processing") processing++;
        else pending++;
    }
    const finished = done + failed;
    const total = finished + pending + processing;
    summaryEl.textContent = `${finished} / ${total}`;
    fillEl.style.width = total > 0 ? `${(finished / total) * 100}%` : "100%";
    // 同步"反推管理"按钮底部进度条（从左到右，绿色；无任务时清空）
    const openBtn = document.getElementById("btn_open_llm_progress");
    if (openBtn) {
        const pct = total > 0 ? (finished / total) * 100 : 0;
        openBtn.style.setProperty("--llm-open-progress", pct + "%");
    }
}

// 更新某行状态显示（行元素可能因窗口重新渲染被替换，需取当前元素）
function updateRowStatus(path) {
    const info = llmReverse.rows.get(path);
    if (!info) return;
    const s = llmReverse.status.get(path) || "pending";
    info.statusEl.classList.remove("pending", "processing", "done", "failed");
    info.statusEl.classList.add(s);
    const labels = {
        pending: "llm_progress.pending",
        processing: "llm_progress.processing",
        done: "llm_progress.done",
        failed: "llm_progress.failed",
    };
    info.statusEl.textContent = t(labels[s] || "llm_progress.pending");
}

// 单任务队列处理：每次处理一个待反推图像，完成后自动处理下一个
async function pumpLlmReverse() {
    if (llmReverse.running) return;
    let next = null;
    for (const p of llmReverse.paths) {
        if (llmReverse.status.get(p) === "pending") { next = p; break; }
    }
    if (!next) return;
    const myRunId = llmReverseRunId;
    llmReverse.running = true;
    llmReverse.status.set(next, "processing");
    updateRowStatus(next);
    try {
        const text = await llm.reverseCaption(next);
        if (!llmReverse.status.has(next)) return; // 处理期间被移除（取消）
        const append = getSetting("llm_reverse_append") !== false;
        const captionSplit = splitCaptionWithSepts(text);
        const tags = captionSplit.tags;
        const septs = captionSplit.septs;
        app.dte.setReverseTags(next, tags, append, septs);
        updateThumbBadge(next); // 刷新画廊状态角标
        updateThumbCaption(next); // 列表模式刷新标注文本
        // 若反推的图像正被选中编辑，直接刷新编辑面板，避免需切换图像才显示打标结果
        if (next === app.gallerySelectedPath) updateEditCaptionPanel();
        llmReverse.status.set(next, "done");
        updateRowStatus(next);
    } catch (e) {
        console.warn("LLM reverse caption failed:", next, e);
        if (!llmReverse.status.has(next)) return;
        llmReverse.status.set(next, "failed");
        updateRowStatus(next);
    } finally {
        llmReverse.running = false;
        if (myRunId === llmReverseRunId) {
            updateProgress();
            pumpLlmReverse(); // 处理下一项
        }
    }
}

// 初始化反推管理窗口
function initLlmReverse() {
    document.getElementById("btn_open_llm_progress").addEventListener("click", () => {
        toggleLlmReversePanel();
    });
    document.getElementById("btn_llm_progress_close").addEventListener("click", () => {
        toggleLlmReversePanel(false);
    });
    // 追加/覆盖选项（默认追加）
    document.getElementById("cb_llm_reverse_append").addEventListener("change", (e) => {
        setSetting("llm_reverse_append", e.target.checked);
    });
    // 固定 / 取消固定（点击外部时保持显示）
    document.getElementById("llm_progress_pin").addEventListener("click", (e) => {
        e.stopPropagation();
        llmPinned = !llmPinned;
        updateLlmPinState();
    });
    // 全部移除：清空反推列表（已应用的标注保留在数据集中）
    document.getElementById("btn_llm_progress_cancel_all").addEventListener("click", () => {
        for (const path of [...llmReverse.paths]) removeLlmReverseImage(path);
    });
    // 移除已完成：从列表中删除所有"已完成"项
    document.getElementById("btn_llm_progress_remove_done").addEventListener("click", () => {
        for (const path of [...llmReverse.paths]) {
            if (llmReverse.status.get(path) === "done") removeLlmReverseImage(path);
        }
    });
    // 支持从画廊拖入图像：拖拽悬停高亮 + 放下后加入队列
    const panel = document.getElementById("llm_progress_panel");
    let dropCounter = 0;
    panel.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dropCounter++;
        panel.classList.add("drag-over");
    });
    panel.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!panel.classList.contains("drag-over")) panel.classList.add("drag-over");
    });
    panel.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dropCounter = Math.max(0, dropCounter - 1);
        if (dropCounter === 0) panel.classList.remove("drag-over");
    });
    panel.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropCounter = 0;
        panel.classList.remove("drag-over");
        const path = e.dataTransfer && e.dataTransfer.getData("text/plain");
        if (path && addLlmReverseImage(path)) {
            showToast(`${t("gallery.added_to_reverse")}: ${getBasename(path)}`, "success");
        }
    });

    // 点击窗口外部关闭（固定时除外；用 click 而非 pointerdown：拖拽图像不会产生 click，避免误关）
    document.addEventListener("click", (e) => {
        if (panel.classList.contains("hidden")) return;
        if (llmPinned) return;
        if (panel.contains(e.target)) return;
        const openBtn = document.getElementById("btn_open_llm_progress");
        if (openBtn && openBtn.contains(e.target)) return;
        toggleLlmReversePanel(false);
    });

    // 按住标题栏拖动窗口（标题栏上的按钮交给按钮自己处理）
    const header = panel.querySelector(".translate-popup-header");
    let drag = null;
    header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button, label, input, select, a")) return;
        drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop };
        e.preventDefault();
        document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        panel.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - panel.offsetWidth)) + "px";
        panel.style.top = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - panel.offsetHeight)) + "px";
    });
    window.addEventListener("mouseup", () => {
        drag = null;
        document.body.style.userSelect = "";
    });

    // 右下角三角角标：拖动调整浮窗大小（与翻译浮窗一致）
    const resize = document.getElementById("llm_progress_resize");
    let rs = null;
    resize.addEventListener("mousedown", (e) => {
        e.preventDefault();
        rs = { w: panel.offsetWidth, h: panel.offsetHeight, x: e.clientX, y: e.clientY };
        document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
        if (!rs) return;
        const MIN_W = 300, MIN_H = 240;
        const MAX_W = Math.min(720, window.innerWidth - 8);
        const MAX_H = window.innerHeight - 8;
        const w = Math.max(MIN_W, Math.min(rs.w + (e.clientX - rs.x), MAX_W));
        const h = Math.max(MIN_H, Math.min(rs.h + (e.clientY - rs.y), MAX_H));
        panel.style.width = w + "px";
        panel.style.height = h + "px";
    });
    window.addEventListener("mouseup", () => { rs = null; });
}

// ================================================================
// 画廊右键菜单 + Ctrl 多选
// ================================================================

// 右键点击的图像路径（复制图像 / 复制连接 作用于此图）
let galleryContextPath = "";

// 在指定坐标显示画廊右键菜单（自动限制在窗口内）
function showGalleryContextMenu(x, y) {
    const menu = document.getElementById("gallery_context_menu");
    const mw = menu.offsetWidth || 160;
    const mh = menu.offsetHeight || 90;
    const left = Math.max(4, Math.min(x, window.innerWidth - mw - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - mh - 4));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.classList.remove("hidden");
}

function hideGalleryContextMenu() {
    const menu = document.getElementById("gallery_context_menu");
    if (menu) menu.classList.add("hidden");
}

// 复制纯文本到系统剪贴板（优先使用原生 API，失败时回退 navigator.clipboard）
async function copyTextToClipboard(text) {
    try {
        await Neutralino.clipboard.writeText(text);
        return true;
    } catch (e) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e2) {
            return false;
        }
    }
}

// 复制图像到剪贴板（读取原图 → 绘制到 canvas → 以 PNG 写入剪贴板）
async function copyImageToClipboard(path) {
    const url = thumbs.getOriginalImageUrl(path);
    if (!url) return false;
    if (!navigator.clipboard || !window.ClipboardItem) return false;
    try {
        const blob = await fetch(url).then(r => r.blob());
        if (!blob) return false;
        const bitmap = await createImageBitmap(blob).catch(() => null);
        if (!bitmap) return false;
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        bitmap.close();
        const pngBlob = await new Promise(res => canvas.toBlob(res, "image/png"));
        if (!pngBlob) return false;
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
        return true;
    } catch (e) {
        console.warn("copy image failed:", e);
        return false;
    }
}

// 菜单动作：复制图像
async function copyImageAction() {
    const path = galleryContextPath;
    if (!path) return;
    const ok = await copyImageToClipboard(path);
    showToast(ok ? t("gallery.copied_image") : t("gallery.copy_failed"), ok ? "success" : "error");
}

// 菜单动作：复制连接（图像路径）
async function copyLinkAction() {
    const path = galleryContextPath;
    if (!path) return;
    const ok = await copyTextToClipboard(path);
    showToast(ok ? t("gallery.copied_link") : t("gallery.copy_failed"), ok ? "success" : "error");
}

// 菜单动作：将图像加入反推列表。
// 若右键目标属于当前选中集合（当前单选或 Ctrl 多选），则加入全部选中图像；
// 否则只加入右键目标本身
function addSelectedToReverse() {
    const ctxInSelection = galleryContextPath
        && (app.galleryMultiSelected.has(galleryContextPath)
            || galleryContextPath === app.gallerySelectedPath);
    const paths = new Set();
    if (ctxInSelection) {
        for (const p of app.galleryMultiSelected) paths.add(p);
        if (app.gallerySelectedPath) paths.add(app.gallerySelectedPath);
    }
    if (galleryContextPath) paths.add(galleryContextPath);
    const list = [...paths].filter(p => p);
    if (list.length === 0) return;
    // 打开反推管理窗口，便于查看队列
    toggleLlmReversePanel(true);
    for (const p of list) addLlmReverseImage(p);
    showToast(`${t("gallery.added_to_reverse")}: ${list.length}`, "success");
}

// 菜单动作：将右键目标加入选择筛选。
// 若右键目标属于当前选中集合（当前单选或 Ctrl 多选），则加入全部选中图像；
// 否则只加入右键目标本身
function addContextToSelection() {
    const ctxInSelection = galleryContextPath
        && (app.galleryMultiSelected.has(galleryContextPath)
            || galleryContextPath === app.gallerySelectedPath);
    const paths = new Set();
    if (ctxInSelection) {
        for (const p of app.galleryMultiSelected) paths.add(p);
        if (app.gallerySelectedPath) paths.add(app.gallerySelectedPath);
    }
    if (galleryContextPath) paths.add(galleryContextPath);
    if (paths.size === 0) return;
    let added = 0;
    for (const p of paths) {
        if (!app.tmpSelection.has(p)) {
            app.tmpSelection.add(p);
            added++;
        }
    }
    if (added > 0) updateSelectionGallery();
    showToast(`${t("gallery.added_to_selection")}: ${paths.size}`, "success");
}

// 菜单动作：将当前所有显示（经筛选后）的图像加入选择筛选
function addAllDisplayedToSelection() {
    const imgs = app.dte.getFilteredImgpaths(app.getFilters());
    let added = 0;
    for (const p of imgs) {
        if (!app.tmpSelection.has(p)) {
            app.tmpSelection.add(p);
            added++;
        }
    }
    if (added > 0) updateSelectionGallery();
    showToast(`${t("gallery.added_to_selection")}: ${imgs.length}`, "success");
}

// 初始化画廊右键菜单
function initGalleryContextMenu() {
    const galleryEl = document.getElementById("dataset_gallery");
    const menu = document.getElementById("gallery_context_menu");
    if (!galleryEl || !menu) return;

    // 右键缩略图：仅记录菜单操作目标，不改变编辑焦点与选中状态，
    // 避免"将更改应用于选中图像"等操作错误作用到未显示的图像上
    galleryEl.addEventListener("contextmenu", (e) => {
        const item = e.target.closest(".thumb-item");
        if (!item) return;
        e.preventDefault();
        galleryContextPath = item.dataset.path;
        // 仅在选择筛选选项卡激活时显示"加入选择筛选"菜单项
        const selTabActive = document.getElementById("tab_filter_selection")
            ? document.getElementById("tab_filter_selection").classList.contains("active")
            : false;
        menu.querySelectorAll('[data-action="add_selection"], [data-action="add_selection_all"]').forEach(b => {
            b.hidden = !selTabActive;
        });
        showGalleryContextMenu(e.clientX, e.clientY);
    });

    // 点击菜单项执行对应动作
    menu.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === "copy_image") copyImageAction();
        else if (action === "copy_link") copyLinkAction();
        else if (action === "reverse") addSelectedToReverse();
        else if (action === "add_selection") addContextToSelection();
        else if (action === "add_selection_all") addAllDisplayedToSelection();
        hideGalleryContextMenu();
    });

    // 点击菜单外 / Esc / 窗口失焦时关闭菜单
    document.addEventListener("click", (e) => {
        if (!menu.classList.contains("hidden") && !menu.contains(e.target)) {
            hideGalleryContextMenu();
        }
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideGalleryContextMenu();
    });
    window.addEventListener("blur", hideGalleryContextMenu);
}

// ================================================================
// 4. 编辑选中图像面板
// ================================================================

function initEditSelected() {
    document.getElementById("btn_copy_caption").addEventListener("click", () => {
        const cap = document.getElementById("html_caption_display").textContent;
        document.getElementById("dte_edit_caption").value = cap;
        triggerEditInput();
    });
    document.getElementById("btn_prepend_caption").addEventListener("click", () => {
        const ta = document.getElementById("dte_edit_caption");
        const cap = document.getElementById("html_caption_display").textContent;
        ta.value = [cap, ta.value].filter(Boolean).join(", ");
        triggerEditInput();
    });
    document.getElementById("btn_append_caption").addEventListener("click", () => {
        const ta = document.getElementById("dte_edit_caption");
        const cap = document.getElementById("html_caption_display").textContent;
        ta.value = [ta.value, cap].filter(Boolean).join(", ");
        triggerEditInput();
    });

    // 动态构建编辑选中图像页面的操作按钮（替换标点 + LLM 功能）
    buildLlmFunctionButtons();

    // 高亮帮助
    document.getElementById("btn_highlight_help").addEventListener("click", () => {
        showHighlightHelp();
    });

    // 编辑输入框变化 -> 更新高亮 overlay
    const editTa = document.getElementById("dte_edit_caption");
    editTa.addEventListener("input", () => {
        app.changeIsSaved = false;
        updateHighlightOverlay();
        updateBboxes();
        // 内容变化后之前的选中范围失效，避免点击"译"翻译到旧文本
        translateSel = null;
    });
    editTa.addEventListener("scroll", syncOverlayScroll);
    // 选中文本翻译：鼠标松开且存在选中文本时，在松开处显示 "译" 按钮
    // 注意：不要在 textarea 失焦时隐藏按钮——点击"译"会先触发失焦，
    // 若此时把按钮 display:none，后续 click 事件不会触发，且选中范围会塌缩。
    editTa.addEventListener("mouseup", onEditSelectionMouseUp);
    initTranslatePopup();
    initHighlightHelpPopup();

    // 侧栏宽度变化、窗口缩放、滚动条出现/消失都会改变 textarea 的客户区宽度，
    // 用 ResizeObserver 实时重测高亮内层宽度，保证始终与 textarea 文本区等宽
    if (window.ResizeObserver) {
        new ResizeObserver(() => syncOverlayLayout()).observe(editTa);
    }

    // 高亮规则变化
    document.getElementById("tb_highlight_rules").addEventListener("input", () => {
        updateHighlightOverlay();
    });

    // 应用更改到选中图像
    document.getElementById("btn_apply_changes").addEventListener("click", () => {
        applyEditToSelected();
        // 只刷新标签相关面板，不重绘画廊（保存标注时画廊无需刷新）
        refreshTagPanels();
        // 设置开启时，应用后自动切换至下一个图像
        if (getSetting("auto_switch_next")) {
            selectNextImage();
        }
    });

    // 将 LLM 结果追加到标注编辑框
    document.getElementById("btn_append_result_to_caption").addEventListener("click", () => {
        const body = document.getElementById("tool-result");
        const text = body.textContent.trim();
        if (!text) return;
        const ta = document.getElementById("dte_edit_caption");
        ta.value = [ta.value, text].filter(Boolean).join(", ");
        triggerEditInput();
        updateBboxes();
    });

    // 自动补全：主标注编辑框 + 其他标签输入处
    initAutocomplete(editTa);
    bindAutocomplete(document.getElementById("tb_edit_tags"));           // 批量编辑标签
    bindAutocomplete(document.getElementById("tb_sr_search_tags"));     // 查找替换-查找
    bindAutocomplete(document.getElementById("tb_sr_replace_tags"));    // 查找替换-替换
    bindAutocomplete(document.getElementById("hr_tags"));               // 高亮规则-匹配标签
    loadAutocompleteData("/data/autocomplete.txt");

    // 胶囊式标签编辑（默认关闭，使用文本编辑）
    initCapsule();
    setCapsuleOnChange(() => {
        app.changeIsSaved = false;
        updateHighlightOverlay();
        updateBboxes();
    });
}

// 依据设置中的规则替换标注中的标点（规则在设置中以表格配置，原字符与替换字符两列）
function replacePunctuation() {
    const ta = document.getElementById("dte_edit_caption");
    let text = ta.value;
    const froms = getSetting("replace_punct_from") || [];
    const tos = getSetting("replace_punct_to") || [];
    // 长规则优先，避免短规则先替换破坏长规则
    const rules = froms.map((f, i) => ({ from: f, to: tos[i] }))
        .filter(r => r.from && r.to !== undefined && r.from !== r.to)
        .sort((a, b) => b.from.length - a.from.length);
    for (const r of rules) {
        text = text.split(r.from).join(r.to);
    }
    ta.value = text;
    triggerEditInput();
}

// 动态构建编辑选中图像页面的操作按钮（替换标点 + LLM 功能），均使用紧凑样式
function buildLlmFunctionButtons() {
    const box = document.getElementById("llm-fn-buttons");
    if (!box) return;
    box.innerHTML = "";

    // 替换标点按钮（可在设置中关闭，置于最前，随语言切换重建）
    if (getSetting("replace_punct_enabled")) {
        const punctBtn = document.createElement("button");
        punctBtn.type = "button";
        punctBtn.className = "btn compact";
        punctBtn.textContent = t("edit_caption.replace_punct");
        punctBtn.addEventListener("click", replacePunctuation);
        box.appendChild(punctBtn);
    }

    // LLM 功能按钮
    const fns = getSetting("llm_functions") || [];
    for (const fn of fns) {
        if (!fn || !fn.name) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn compact";
        btn.textContent = fn.name;
        btn.addEventListener("click", () => runLlmFunctionButton(fn));
        box.appendChild(btn);
    }
}

// 执行自定义 LLM 功能按钮
async function runLlmFunctionButton(fn) {
    const body = document.getElementById("tool-result");
    const appendBtn = document.getElementById("btn_append_result_to_caption");
    body.textContent = "";
    appendBtn.disabled = true;
    try {
        // 需要图片时读取并压缩选中图像
        let imageDataUrl = null;
        if (fn.send_image) {
            const selPath = app.gallerySelectedPath;
            if (!selPath) { body.textContent = "请选择图像"; return; }
            const cfg = llm.resolveLlmConfig(fn.config);
            const maxRes = cfg ? (cfg.max_image_resolution || 0) : 0;
            imageDataUrl = await llm.prepareImage(selPath, maxRes);
            if (!imageDataUrl) { body.textContent = "图片加载失败"; return; }
        }
        // 需要文本时读取编辑框内容
        let captionText = "";
        if (fn.send_caption) {
            captionText = document.getElementById("dte_edit_caption").value;
        }
        if (!imageDataUrl && !captionText.trim()) {
            body.textContent = "请选择图像或输入文本";
            return;
        }
        await llm.runLlmFunction(fn, { imageDataUrl, captionText }, acc => {
            body.textContent = acc;
            appendBtn.disabled = !acc.trim();
        });
    } catch (e) {
        body.textContent = "异常: " + (e.message || e);
    }
}

// 解析标注文本（按配置的分隔符拆分标签）
function parseCaption(text) {
    return splitCaption(text);
}

// ================================================================
// 选中文本翻译（译按钮 + 可拖动固定浮窗）
// 在编辑框中选中文本并松开鼠标时，在松开处显示 "译" 按钮；
// 点击后调用 LLM 翻译，在可拖动浮窗中显示译文。
// 浮窗固定（pin）后：点击外部不关闭，翻译新文本时保持当前位置不变。
// ================================================================

let translatePinned = false;
// 鼠标松开时记录的选中范围（点击"译"按钮会使 textarea 失焦、选中塌缩，故不能实时读取）
let translateSel = null;
// 上次翻译缓存：规范化文本 -> 译文，相同文本不重复请求 LLM
let lastTranslate = { text: "", result: "" };

// 粗略规范化：去除首尾空格、换行与标点（含中英文），用于判定是否为同一段文本
function normalizeTranslateText(text) {
    return String(text).trim().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
}

// 编辑框内鼠标松开：有选中文本则在松开处显示 "译" 按钮
function onEditSelectionMouseUp(e) {
    const ta = document.getElementById("dte_edit_caption");
    const btn = document.getElementById("translate_trigger");
    if (!ta || !btn) return;
    const hasSel = ta.selectionStart != null && ta.selectionEnd != null && ta.selectionStart !== ta.selectionEnd;
    if (!hasSel) { translateSel = null; hideTranslateTrigger(); return; }
    // 记录选中范围，供点击"译"按钮时使用
    translateSel = { start: ta.selectionStart, end: ta.selectionEnd };
    // 定位在鼠标松开处（右侧下方），并限制在视口内
    const bw = btn.offsetWidth || 28;
    const bh = btn.offsetHeight || 28;
    btn.style.left = Math.max(4, Math.min(e.clientX + 8, window.innerWidth - bw - 4)) + "px";
    btn.style.top = Math.max(4, Math.min(e.clientY + 8, window.innerHeight - bh - 4)) + "px";
    btn.classList.remove("hidden");
}

// 隐藏 "译" 按钮
function hideTranslateTrigger() {
    const btn = document.getElementById("translate_trigger");
    if (btn) btn.classList.add("hidden");
}

// 显示翻译浮窗；anchorRect 为 "译" 按钮的矩形（固定模式下忽略，保持当前位置）
function showTranslatePopup(anchorRect) {
    const popup = document.getElementById("translate_popup");
    if (!popup) return;
    popup.classList.remove("hidden");
    if (anchorRect && !translatePinned) {
        // 与"译"按钮位置保持一致（按钮在选中文本右下角，浮窗也出现在同一位置）
        let left = anchorRect.left;
        let top = anchorRect.top;
        left = Math.max(4, Math.min(left, window.innerWidth - popup.offsetWidth - 4));
        top = Math.max(4, Math.min(top, window.innerHeight - popup.offsetHeight - 4));
        popup.style.left = left + "px";
        popup.style.top = top + "px";
    }
    updatePinState();
}

// 翻译指定文本并在浮窗中展示（流式）；force 为 true 时绕过重复检查，强制重新翻译
async function runTranslate(text, force = false) {
    const out = document.getElementById("translate_output");
    if (!out) return;
    // 粗略检查：去除首尾标点、空格、换行；与上次相同则不重复翻译，直接显示已有译文
    const norm = normalizeTranslateText(text);
    if (!force && norm === lastTranslate.text && lastTranslate.result) {
        out.textContent = lastTranslate.result;
        return;
    }
    out.textContent = "翻译中...";
    try {
        const result = await llm.translateText(norm, acc => {
            out.textContent = acc;
        });
        lastTranslate = { text: norm, result };
    } catch (e) {
        out.textContent = "异常: " + (e.message || e);
    }
}

// 翻译选中文本：打开浮窗、填入原文并自动翻译
async function translateSelection() {
    const ta = document.getElementById("dte_edit_caption");
    if (!ta) return;
    // 优先使用鼠标松开时记录的选中范围（点击"译"按钮时 textarea 已失焦）
    const liveSel = (ta.selectionStart != null && ta.selectionStart !== ta.selectionEnd)
        ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
    const range = translateSel || liveSel;
    if (!range) return;
    const sel = ta.value.substring(range.start, range.end).trim();
    translateSel = null;
    if (!sel) return;
    const btn = document.getElementById("translate_trigger");
    // 未固定时记录按钮位置用于浮窗定位（随后隐藏按钮）
    const anchorRect = (!translatePinned && btn && !btn.classList.contains("hidden")) ? btn.getBoundingClientRect() : null;
    hideTranslateTrigger();
    showTranslatePopup(anchorRect);
    // 原文填入编辑框并自动翻译
    const src = document.getElementById("translate_source");
    if (src) {
        src.value = sel;
        src.focus();
        src.setSelectionRange(src.value.length, src.value.length);
    }
    runTranslate(sel);
}

// 更新浮窗固定状态样式
function updatePinState() {
    const popup = document.getElementById("translate_popup");
    if (popup) popup.classList.toggle("pinned", translatePinned);
}

// 初始化浮窗：固定 / 关闭 / 拖动 / 点击外部关闭
function initTranslatePopup() {
    const popup = document.getElementById("translate_popup");
    const trigger = document.getElementById("translate_trigger");
    if (!popup || !trigger) return;

    // 点击外部关闭（固定时除外；点击译按钮 / 浮窗内部不关闭）
    document.addEventListener("pointerdown", (e) => {
        if (translatePinned) return;
        if (popup.contains(e.target)) return;
        if (trigger.contains(e.target)) return;
        popup.classList.add("hidden");
        hideTranslateTrigger();
    });

    // 译按钮点击 -> 翻译选中文本
    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        translateSelection();
    });

    // 固定 / 取消固定
    const pinBtn = document.getElementById("translate_pin");
    if (pinBtn) pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        translatePinned = !translatePinned;
        updatePinState();
    });

    // 关闭
    const closeBtn = document.getElementById("translate_close");
    if (closeBtn) closeBtn.addEventListener("click", () => {
        popup.classList.add("hidden");
        hideTranslateTrigger();
    });

    // 原文编辑框：按回车（不含 Shift）翻译当前文本
    const src = document.getElementById("translate_source");
    if (src) {
        src.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const text = src.value.trim();
                if (text) runTranslate(text);
            }
        });
    }

    // 刷新按钮：对翻译不满意时重新翻译（绕过重复检查）
    const refreshBtn = document.getElementById("translate_refresh");
    if (refreshBtn) {
        refreshBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const text = (src ? src.value : "").trim();
            if (text) runTranslate(text, true);
        });
    }

    // 右下角三角角标：拖动调整浮窗大小
    const resize = document.getElementById("translate_resize");
    let rs = null;
    resize.addEventListener("mousedown", (e) => {
        e.preventDefault();
        rs = { w: popup.offsetWidth, h: popup.offsetHeight, x: e.clientX, y: e.clientY };
        document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
        if (!rs) return;
        const MIN_W = 220, MIN_H = 120;
        const MAX_W = Math.min(600, window.innerWidth - 8);
        const MAX_H = window.innerHeight - 8;
        const w = Math.max(MIN_W, Math.min(rs.w + (e.clientX - rs.x), MAX_W));
        const h = Math.max(MIN_H, Math.min(rs.h + (e.clientY - rs.y), MAX_H));
        popup.style.width = w + "px";
        popup.style.height = h + "px";
    });
    window.addEventListener("mouseup", () => { rs = null; });

    // 按住标题栏拖动浮窗
    const header = popup.querySelector(".translate-popup-header");
    let drag = null;
    header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return; // 标题栏上的按钮交给按钮处理
        drag = { dx: e.clientX - popup.offsetLeft, dy: e.clientY - popup.offsetTop };
        e.preventDefault();
        document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        popup.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - popup.offsetWidth)) + "px";
        popup.style.top = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - popup.offsetHeight)) + "px";
    });
    window.addEventListener("mouseup", () => {
        drag = null;
        document.body.style.userSelect = "";
    });

    // 键盘操作/滚动等导致选中变化时隐藏译按钮
    document.addEventListener("keyup", hideTranslateTrigger);
}

// 同步高亮层排版：内层宽度设为与 textarea 文本区等宽，滚动位移用像素级平移（与内容高度无关，可精确对齐）
function syncOverlayLayout() {
    const ta = document.getElementById("dte_edit_caption");
    const inner = document.getElementById("dte_caption_overlay_inner");
    // 内层 border-box 宽 = textarea 客户区宽（两者 padding 均为 4px，文本可用宽一致）
    inner.style.width = ta.clientWidth + "px";
    inner.style.transform = "translateY(" + (-ta.scrollTop) + "px)";
}

// 滚动时仅需做像素级平移即可精确对齐
function syncOverlayScrollPos() {
    const ta = document.getElementById("dte_edit_caption");
    const inner = document.getElementById("dte_caption_overlay_inner");
    inner.style.transform = "translateY(" + (-ta.scrollTop) + "px)";
}

// 更新高亮 overlay
function updateHighlightOverlay() {
    const ta = document.getElementById("dte_edit_caption");
    const inner = document.getElementById("dte_caption_overlay_inner");
    const rulesText = document.getElementById("tb_highlight_rules").value;
    const rules = parseRules(rulesText);
    // 末尾换行符补一个 <br>：pre-wrap 中结尾的单个换行不产生空行，与 textarea 保持一致
    const html = applyHighlight(ta.value, rules);
    inner.innerHTML = html + (ta.value.endsWith("\n") ? "<br>" : "");
    syncOverlayLayout();
}

function syncOverlayScroll() {
    syncOverlayScrollPos();
}

// 更新编辑面板（读取选中图像标注）
function updateEditCaptionPanel() {
    // 与画廊显示保持一致，使用排序后的路径列表
    const imgs = app.galleryPaths.length > 0 ? app.galleryPaths : app.dte.getFilteredImgpaths(app.getFilters());
    const idx = app.gallerySelectedIndex;
    const captionEl = document.getElementById("html_caption_display");
    const editTa = document.getElementById("dte_edit_caption");
    const autoCopy = document.getElementById("cb_copy_caption_automatically").checked;

    if (idx >= 0 && idx < imgs.length) {
        // 直接使用存储的原始间隔文本重建显示文本（仅裁剪首尾空白，不补空格），
        // 与画廊列表显示保持一致，避免将句号等标点替换为英文逗号或添加空格
        const data = app.dte.dataset.getData(imgs[idx]);
        const txt = data ? joinTagsWithSepts(data.tags, data.septs) : "";
        const rulesText = document.getElementById("tb_highlight_rules").value;
        const rules = parseRules(rulesText);
        captionEl.innerHTML = applyHighlight(txt, rules);
        if (autoCopy) {
            editTa.value = txt;
            app.changeIsSaved = true;
            updateHighlightOverlay();
        }
    } else {
        captionEl.innerHTML = "";
    }
    // 编辑框内容变化后同步边界框与胶囊标签
    updateBboxes();
    capsuleRefresh();
}

function triggerEditInput() {
    const ta = document.getElementById("dte_edit_caption");
    app.changeIsSaved = false;
    updateHighlightOverlay();
    // 胶囊编辑模式下同步刷新胶囊标签
    capsuleRefresh();
}

function showHighlightHelp() {
    const popup = document.getElementById("highlight_help_popup");
    const content = document.getElementById("highlight_help_content");
    if (!popup || !content) return;
    content.textContent = t("edit_caption.highlight_help_content");
    popup.classList.remove("hidden");
    // 首次打开时设置默认尺寸与居中位置（之后可拖动/缩放并保持位置）
    if (!popup.style.width || !popup.style.left) {
        const w = Math.min(480, window.innerWidth - 16);
        const h = Math.min(380, window.innerHeight - 16);
        popup.style.width = w + "px";
        popup.style.height = h + "px";
        popup.style.left = Math.max(0, Math.round((window.innerWidth - w) / 2)) + "px";
        popup.style.top = Math.max(0, Math.round((window.innerHeight - h) / 2 - 40)) + "px";
    }
}

// 高亮规则帮助浮窗：与翻译浮窗一致的交互（按住标题栏拖动、右下角缩放，
// 点击外部或 ✕ 按钮关闭，不会自动消失）
function initHighlightHelpPopup() {
    const popup = document.getElementById("highlight_help_popup");
    if (!popup) return;

    // 点击外部关闭
    document.addEventListener("pointerdown", (e) => {
        if (popup.classList.contains("hidden")) return;
        if (popup.contains(e.target)) return;
        popup.classList.add("hidden");
    });

    // ✕ 关闭
    const closeBtn = document.getElementById("highlight_help_close");
    if (closeBtn) closeBtn.addEventListener("click", () => popup.classList.add("hidden"));

    // 右下角三角角标：拖动调整浮窗大小
    const resize = document.getElementById("highlight_help_resize");
    let rs = null;
    resize.addEventListener("mousedown", (e) => {
        e.preventDefault();
        rs = { w: popup.offsetWidth, h: popup.offsetHeight, x: e.clientX, y: e.clientY };
        document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
        if (!rs) return;
        const MIN_W = 260, MIN_H = 160;
        const MAX_W = Math.min(640, window.innerWidth - 8);
        const MAX_H = window.innerHeight - 8;
        const w = Math.max(MIN_W, Math.min(rs.w + (e.clientX - rs.x), MAX_W));
        const h = Math.max(MIN_H, Math.min(rs.h + (e.clientY - rs.y), MAX_H));
        popup.style.width = w + "px";
        popup.style.height = h + "px";
    });
    window.addEventListener("mouseup", () => { rs = null; });

    // 按住标题栏拖动浮窗
    const header = popup.querySelector(".translate-popup-header");
    let drag = null;
    header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return; // 标题栏上的按钮交给按钮处理
        drag = { dx: e.clientX - popup.offsetLeft, dy: e.clientY - popup.offsetTop };
        e.preventDefault();
        document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        popup.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - popup.offsetWidth)) + "px";
        popup.style.top = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - popup.offsetHeight)) + "px";
    });
    window.addEventListener("mouseup", () => {
        drag = null;
        document.body.style.userSelect = "";
    });
}

// ================================================================
// 高亮规则右键编辑：读取点击行内容，用对话框对当前行规则进行设置
// ================================================================

// 当前正在编辑的行范围 { start, end, text }
let highlightEditLine = null;

// 计算文本框内鼠标位置对应的字符偏移
function getOffsetAtPoint(ta, clientX, clientY) {
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(clientX, clientY);
        if (range && range.startContainer === ta) {
            return range.startOffset;
        }
    } else if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(clientX, clientY);
        if (pos && pos.offsetNode === ta) {
            return pos.offset;
        }
    }
    return ta.selectionStart;
}

// 根据偏移量获取所在行的起止范围
function getLineRange(ta, offset) {
    const text = ta.value;
    const before = text.substring(0, offset);
    const start = before.lastIndexOf("\n") + 1;
    const endRel = text.indexOf("\n", offset);
    const end = endRel === -1 ? text.length : endRel;
    return { start, end, text: text.substring(start, end) };
}

// 高亮规则编辑窗口是否固定（固定后点击窗口外不关闭）
let hrPinned = false;

// 更新高亮规则编辑窗口固定状态样式
function updateHrPinState() {
    const popup = document.getElementById("highlight_rule_modal");
    if (popup) popup.classList.toggle("pinned", hrPinned);
}

// 打开高亮规则编辑窗口
function openHighlightRuleEditor(ta, clientX, clientY) {
    const offset = getOffsetAtPoint(ta, clientX, clientY);
    highlightEditLine = getLineRange(ta, offset);

    // 解析当前行规则（parseRules 返回数组，取第一个）
    const lineRules = parseRules(highlightEditLine.text);
    const rule = lineRules.length > 0 ? lineRules[0] : { tags: [], style: {} };
    const style = rule.style || {};

    document.getElementById("hr_tags").value = rule.tags.join(", ");
    document.getElementById("hr_enable_bg").checked = !!style.bg;
    document.getElementById("hr_bg").value = style.bg || "#777700";
    document.getElementById("hr_bg").disabled = !style.bg;
    document.getElementById("hr_enable_fg").checked = !!style.fg;
    document.getElementById("hr_fg").value = style.fg || "#ffffff";
    document.getElementById("hr_fg").disabled = !style.fg;
    document.getElementById("hr_bold").checked = style.b === "1";
    document.getElementById("hr_partial").checked = !!style.partial;
    document.getElementById("hr_cs").checked = !!style.cs;

    const popup = document.getElementById("highlight_rule_modal");
    popup.classList.remove("hidden");
    // 首次打开：设置初始尺寸与居中位置（之后拖动/缩放会记住位置）
    if (!popup.style.width || !popup.style.left) {
        const w = Math.min(440, window.innerWidth - 16);
        const h = Math.min(430, Math.max(300, window.innerHeight - 16));
        popup.style.width = w + "px";
        popup.style.height = h + "px";
        popup.style.left = Math.max(0, Math.round((window.innerWidth - w) / 2)) + "px";
        popup.style.top = Math.max(0, Math.round((window.innerHeight - h) / 2)) + "px";
    }
    document.getElementById("hr_tags").focus();
    updateHighlightPreview();
}

// 关闭高亮规则编辑窗口
function closeHighlightRuleEditor() {
    document.getElementById("highlight_rule_modal").classList.add("hidden");
    highlightEditLine = null;
}

// 更新示例预览：将当前表单设置作为一条规则，应用到示例文本上，
// 直观体现颜色 / 加粗 / 子串匹配 / 大小写区分的效果
function updateHighlightPreview() {
    const previewEl = document.getElementById("hr_preview");
    const tags = document.getElementById("hr_tags").value
        .split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    if (tags.length === 0) {
        previewEl.textContent = t("highlight.preview_empty");
        return;
    }
    const style = {};
    if (document.getElementById("hr_enable_bg").checked) style.bg = document.getElementById("hr_bg").value;
    if (document.getElementById("hr_enable_fg").checked) style.fg = document.getElementById("hr_fg").value;
    if (document.getElementById("hr_bold").checked) style.b = "1";
    if (document.getElementById("hr_partial").checked) style.partial = true;
    if (document.getElementById("hr_cs").checked) style.cs = true;

    // 示例文本：独立标签、前缀子串、后缀子串、大写变体（分别体现词边界/子串/大小写）
    const tag = tags[0];
    const sample = `${tag}, ${tag}. abc${tag}s\n${tag.toUpperCase()}.abc${tag.toUpperCase()}ABC`;
    previewEl.innerHTML = applyHighlight(sample, [{ tags: [tag], style }]);
}

// 保存高亮规则并写回当前行
function saveHighlightRule() {
    if (!highlightEditLine) return;
    const tags = document.getElementById("hr_tags").value
        .split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    const parts = tags.slice();
    if (document.getElementById("hr_enable_bg").checked) {
        parts.push("bg:" + document.getElementById("hr_bg").value);
    }
    if (document.getElementById("hr_enable_fg").checked) {
        parts.push("fg:" + document.getElementById("hr_fg").value);
    }
    if (document.getElementById("hr_bold").checked) parts.push("b:1");
    if (document.getElementById("hr_partial").checked) parts.push("partial:1");
    if (document.getElementById("hr_cs").checked) parts.push("cs:1");

    const newLine = parts.join(",");
    const ta = document.getElementById("tb_highlight_rules");
    const { start, end } = highlightEditLine;
    ta.value = ta.value.substring(0, start) + newLine + ta.value.substring(end);
    closeHighlightRuleEditor();
    updateHighlightOverlay();
}

// 初始化高亮规则右键编辑
function initHighlightRuleEditor() {
    const ta = document.getElementById("tb_highlight_rules");

    // 右键点击：读取点击行并打开编辑窗口
    ta.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openHighlightRuleEditor(ta, e.clientX, e.clientY);
    });

    // 启用/禁用颜色选择器
    document.getElementById("hr_enable_bg").addEventListener("change", (e) => {
        document.getElementById("hr_bg").disabled = !e.target.checked;
    });
    document.getElementById("hr_enable_fg").addEventListener("change", (e) => {
        document.getElementById("hr_fg").disabled = !e.target.checked;
    });

    document.getElementById("hr_save").addEventListener("click", saveHighlightRule);
    document.getElementById("hr_cancel").addEventListener("click", closeHighlightRuleEditor);

    // 固定 / 取消固定（点击外部时保持显示）
    document.getElementById("hr_pin").addEventListener("click", (e) => {
        e.stopPropagation();
        hrPinned = !hrPinned;
        updateHrPinState();
    });
    // ✕ 关闭
    document.getElementById("hr_close").addEventListener("click", closeHighlightRuleEditor);

    // 点击窗口外部关闭（固定时除外）
    document.addEventListener("click", (e) => {
        if (hrPinned) return;
        if (e.target.closest("#highlight_rule_modal")) return;
        closeHighlightRuleEditor();
    });

    // 按 Esc 关闭
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !document.getElementById("highlight_rule_modal").classList.contains("hidden")) {
            closeHighlightRuleEditor();
        }
    });

    // 表单变化实时刷新示例预览
    document.getElementById("hr_tags").addEventListener("input", updateHighlightPreview);
    document.getElementById("hr_enable_bg").addEventListener("change", updateHighlightPreview);
    document.getElementById("hr_bg").addEventListener("input", updateHighlightPreview);
    document.getElementById("hr_enable_fg").addEventListener("change", updateHighlightPreview);
    document.getElementById("hr_fg").addEventListener("input", updateHighlightPreview);
    document.getElementById("hr_bold").addEventListener("change", updateHighlightPreview);
    document.getElementById("hr_partial").addEventListener("change", updateHighlightPreview);
    document.getElementById("hr_cs").addEventListener("change", updateHighlightPreview);

    // 按住标题栏拖动窗口（标题栏上的按钮交给按钮自己处理）
    const popup = document.getElementById("highlight_rule_modal");
    const header = popup.querySelector(".translate-popup-header");
    let drag = null;
    header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button, label, input, select, a")) return;
        drag = { dx: e.clientX - popup.offsetLeft, dy: e.clientY - popup.offsetTop };
        e.preventDefault();
        document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        popup.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - popup.offsetWidth)) + "px";
        popup.style.top = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - popup.offsetHeight)) + "px";
    });
    window.addEventListener("mouseup", () => {
        drag = null;
        document.body.style.userSelect = "";
    });

    // 右下角三角角标：拖动调整浮窗大小（与翻译浮窗一致）
    const resize = document.getElementById("hr_resize");
    let rs = null;
    resize.addEventListener("mousedown", (e) => {
        e.preventDefault();
        rs = { w: popup.offsetWidth, h: popup.offsetHeight, x: e.clientX, y: e.clientY };
        document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
        if (!rs) return;
        const MIN_W = 380, MIN_H = 300;
        const MAX_W = Math.min(720, window.innerWidth - 8);
        const MAX_H = window.innerHeight - 8;
        const w = Math.max(MIN_W, Math.min(rs.w + (e.clientX - rs.x), MAX_W));
        const h = Math.max(MIN_H, Math.min(rs.h + (e.clientY - rs.y), MAX_H));
        popup.style.width = w + "px";
        popup.style.height = h + "px";
    });
    window.addEventListener("mouseup", () => { rs = null; });
}

// ================================================================
// 5. 批量编辑
// ================================================================

function initBatchEdit() {
    // 显示公共标签
    updateCommonTags();

    document.getElementById("cb_show_only_tags_selected").addEventListener("change", () => {
        updateCommonTags();
    });

    document.getElementById("btn_apply_edit_tags").addEventListener("click", () => {
        const searchTags = parseCaption(document.getElementById("tb_common_tags").value);
        const replaceTags = parseCaption(document.getElementById("tb_edit_tags").value);
        const prepend = document.getElementById("cb_prepend_tags").checked;

        app.dte.replaceTags(searchTags, replaceTags, app.getFilters(), prepend);

        // 更新筛选器中的标签
        app.filterP.filter.tags = app.dte.getReplacedTagset(app.filterP.filter.tags, searchTags, replaceTags);
        app.filterN.filter.tags = app.dte.getReplacedTagset(app.filterN.filter.tags, searchTags, replaceTags);
        app.filterP.selectedTags = app.filterP.filter.tags;
        app.filterN.selectedTags = app.filterN.filter.tags;

        app.datasetDirty = true;
        refreshAll();
    });

    document.getElementById("btn_apply_sr_tags").addEventListener("click", () => {
        const searchText = document.getElementById("tb_sr_search_tags").value;
        const replaceText = document.getElementById("tb_sr_replace_tags").value;
        const target = document.querySelector('input[name="sr_target"]:checked')?.value || "Only Selected Tags";
        const useRegex = document.getElementById("cb_use_regex").checked;

        const filters = app.getFilters();

        if (target === "Only Selected Tags") {
            const selectedTags = new Set(app.filterP.selectedTags);
            app.dte.searchAndReplaceSelectedTags(searchText, replaceText, selectedTags, filters, useRegex);
            app.filterP.filter.tags = app.dte.searchAndReplaceTagSet(searchText, replaceText, app.filterP.filter.tags, selectedTags, useRegex);
            app.filterN.filter.tags = app.dte.searchAndReplaceTagSet(searchText, replaceText, app.filterN.filter.tags, selectedTags, useRegex);
        } else if (target === "Each Tags") {
            app.dte.searchAndReplaceSelectedTags(searchText, replaceText, null, filters, useRegex);
            app.filterP.filter.tags = app.dte.searchAndReplaceTagSet(searchText, replaceText, app.filterP.filter.tags, null, useRegex);
            app.filterN.filter.tags = app.dte.searchAndReplaceTagSet(searchText, replaceText, app.filterN.filter.tags, null, useRegex);
        } else {
            app.dte.searchAndReplaceCaption(searchText, replaceText, filters, useRegex);
            app.filterP.filter.tags = app.dte.searchAndReplaceTagSet(searchText, replaceText, app.filterP.filter.tags, null, useRegex);
            app.filterN.filter.tags = app.dte.searchAndReplaceTagSet(searchText, replaceText, app.filterN.filter.tags, null, useRegex);
        }

        app.datasetDirty = true;
        refreshAll();
    });

    document.getElementById("btn_remove_duplicate").addEventListener("click", () => {
        app.dte.removeDuplicatedTags(app.getFilters());
        app.datasetDirty = true;
        refreshAll();
    });

    document.getElementById("btn_remove_selected").addEventListener("click", () => {
        app.dte.removeTags(app.removeTagSelect.selectedTags, app.getFilters());
        app.datasetDirty = true;
        refreshAll();
    });
}

// 更新公共标签
function updateCommonTags() {
    const showOnlySelected = document.getElementById("cb_show_only_tags_selected").checked;
    const common = app.dte.getCommonTags(app.getFilters());
    let txt;
    if (showOnlySelected && app.filterP) {
        txt = common.filter(tag => app.filterP.filter.tags.has(tag)).join(", ");
    } else {
        txt = common.join(", ");
    }
    document.getElementById("tb_common_tags").value = txt;
    document.getElementById("tb_edit_tags").value = txt;
}

// 更新 Search and Replace 的选中标签显示
function updateSrSelectedTags() {
    const el = document.getElementById("tb_sr_selected_tags");
    if (!el) return;
    if (app.filterP) {
        el.value = [...app.filterP.filter.tags].join(", ");
    }
}

// ================================================================
// 6. 重命名 / 删除文件（文件操作）
// ================================================================

let renamePaths = [];
let renameDeleteSet = new Set();

function initRename() {
    document.getElementById("btn_apply_rename").addEventListener("click", () => {
        applyRename();
    });
}

// 为文件操作表格的预览列加载缩略图：
// 优先使用缩略图缓存；未生成时先用原图占位，后台生成完成后替换为缩略图
async function loadRenameThumb(img, path) {
    const maxRes = getSetting("max_resolution") || 0;
    if (maxRes <= 0) { img.src = thumbs.getOriginalImageUrl(path); return; }
    try {
        let mtime = 0;
        const st = await api.getStats(path);
        if (st && st.mtime) mtime = st.mtime;
        const key = thumbs.md5Key(path, maxRes, mtime);
        if (await thumbs.thumbCacheExists(key)) {
            img.src = thumbs.getThumbCacheUrl(key);
            return;
        }
        img.src = thumbs.getOriginalImageUrl(path);
        thumbs.generateThumbnail(path, maxRes, mtime).then(k => {
            if (k && img.isConnected) img.src = thumbs.getThumbCacheUrl(k);
        }).catch(() => {});
    } catch (e) { /* 忽略加载失败 */ }
}

function populateRename() {
    const tbody = document.querySelector("#df_rename tbody");
    renamePaths = app.dte.getImgPathList().sort();
    renameDeleteSet = new Set();
    if (renamePaths.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="small-note">(empty)</td></tr>`;
        return;
    }
    tbody.innerHTML = "";
    renamePaths.forEach((path, i) => {
        const tr = document.createElement("tr");
        const tdThumb = document.createElement("td");
        const img = document.createElement("img");
        img.className = "rename-thumb";
        loadRenameThumb(img, path);
        tdThumb.appendChild(img);

        const tdName = document.createElement("td");
        tdName.className = "rename-col-name";
        const input = document.createElement("input");
        input.type = "text";
        input.value = getStem(path);
        input.dataset.index = i;
        input.dataset.path = path;
        bindAutocomplete(input, { appendComma: false });
        tdName.appendChild(input);

        const tdDel = document.createElement("td");
        tdDel.className = "rename-col-del";
        const delCb = document.createElement("input");
        delCb.type = "checkbox";
        delCb.className = "rename-del-cb";
        delCb.dataset.path = path;
        delCb.title = t("file_ops.mark_delete");
        delCb.addEventListener("change", () => {
            const p = delCb.dataset.path;
            if (delCb.checked) {
                renameDeleteSet.add(p);
                tr.classList.add("marked-delete");
            } else {
                renameDeleteSet.delete(p);
                tr.classList.remove("marked-delete");
            }
        });
        tdDel.appendChild(delCb);

        tr.appendChild(tdThumb);
        tr.appendChild(tdName);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
    });
}

async function applyRename() {
    if (renamePaths.length === 0) return;
    const captionExt = document.getElementById("tb_caption_file_ext").value.trim() || ".txt";

    // 先处理标记删除的文件（移到回收站）
    if (renameDeleteSet.size > 0) {
        const key = await showConfirmDialog(
            t("common.delete"),
            t("dialog.delete_files_msg"),
            [
                { key: "ok", label: t("common.delete"), cls: "danger" },
                { key: "cancel", label: t("common.cancel") },
            ]
        );
        if (key !== "ok") return;
        for (const path of renameDeleteSet) {
            try {
                // 标注文件路径需按同名 stem 分组解析（与保存/加载一致）
                const txtPath = app.dte.resolveCaptionPath(path, captionExt);
                if (await api.pathExists(path)) await api.trashItem(path);
                if (await api.pathExists(txtPath)) await api.trashItem(txtPath);
                // 备份文件
                for (let extnum = 0; extnum < 1000; extnum++) {
                    const bakPath = withSuffix(txtPath, `.${String(extnum).padStart(3, "0")}`);
                    if (await api.pathExists(bakPath)) await api.trashItem(bakPath);
                    else break;
                }
            } catch (e) {
                console.warn("delete failed:", path, e);
            }
            app.dte.dataset.removeByPath(path);
        }
        app.dte.constructTagInfos();
    }

    // 剩余未删除的文件执行重命名
    const remainingPaths = renamePaths.filter(p => !renameDeleteSet.has(p));
    if (remainingPaths.length === 0) {
        refreshAll();
        populateRename();
        return;
    }

    const inputs = [...document.querySelectorAll("#df_rename tbody input[type='text']")]
        .filter(inp => !renameDeleteSet.has(inp.dataset.path));
    const newStems = inputs.map(inp => inp.value.trim());
    const usedStems = new Set(remainingPaths.map(p => getStem(p)));

    const renamePairs = [];
    for (let i = 0; i < remainingPaths.length; i++) {
        const origStem = getStem(remainingPaths[i]);
        const newStem = newStems[i] || origStem;
        if (newStem !== origStem) renamePairs.push({ origStem, newStem });
    }

    // 处理重名
    const stemCount = {};
    for (const p of renamePairs) stemCount[p.newStem] = (stemCount[p.newStem] || 0) + 1;

    const finalMap = {};
    for (const { origStem, newStem } of renamePairs) {
        if (stemCount[newStem] > 1) {
            let c = 1;
            let candidate = `${newStem}_${c}`;
            while (usedStems.has(candidate)) { c++; candidate = `${newStem}_${c}`; }
            finalMap[origStem] = candidate;
            usedStems.add(candidate);
        } else {
            if (usedStems.has(newStem)) {
                let c = 1;
                let candidate = `${newStem}_${c}`;
                while (usedStems.has(candidate)) { c++; candidate = `${newStem}_${c}`; }
                finalMap[origStem] = candidate;
                usedStems.add(candidate);
            } else {
                finalMap[origStem] = newStem;
                usedStems.add(newStem);
            }
        }
    }

    const pathMap = {};
    for (const p of remainingPaths) pathMap[getStem(p)] = p;

    for (const [origStem, newStem] of Object.entries(finalMap)) {
        if (newStem === origStem) continue;
        const oldPath = pathMap[origStem];
        const ext = getExtension(oldPath);
        const dir = getDirname(oldPath);
        const newPath = `${dir}/${newStem}${ext}`;

        try {
            const tags = app.dte.dataset.getDataTags(oldPath) || [];
            if (await api.pathExists(oldPath)) {
                await api.moveFile(oldPath, newPath);
            }
            // 重命名标注文件（旧路径需按同名 stem 分组解析，与加载/保存一致）
            const oldTxt = app.dte.resolveCaptionPath(oldPath, captionExt);
            const newTxt = withSuffix(newPath, captionExt);
            if (await api.pathExists(oldTxt)) {
                await api.moveFile(oldTxt, newTxt);
            }
            app.dte.dataset.removeByPath(oldPath);
            app.dte.setTagsByImagePath(newPath, tags);
        } catch (e) {
            console.warn("rename failed:", oldPath, e);
        }
    }

    app.dte.img_idx.clear();
    const keys = [...app.dte.dataset.datas.keys()].sort();
    for (let i = 0; i < keys.length; i++) app.dte.img_idx.set(keys[i], i);
    app.dte.constructTagInfos();

    invalidateThumbUrlCache();
    refreshAll();
    populateRename();
}

// ================================================================
// 8. 顶栏（保存/加载配置）
// ================================================================

function initTopbar() {
    // 保存所有更改
    document.getElementById("btn_save_all_changes").addEventListener("click", async () => {
        const backup = document.getElementById("cb_backup").checked;
        const captionExt = document.getElementById("tb_caption_file_ext").value.trim() || ".txt";
        const result = await app.dte.saveDataset(backup, captionExt, document.getElementById("cb_remove_newlines").checked);
        const el = document.getElementById("tool-result");
        if (el) {
            el.textContent = `Saved: ${result.saved}/${result.total} captions`;
            document.getElementById("btn_append_result_to_caption").disabled = true;
        }
        app.changeIsSaved = true;
        app.datasetDirty = false;
    });

    // 加载 config.json 到界面
    document.getElementById("btn_reload_config_file").addEventListener("click", async () => {
        await config.load();
        applyConfigToUI();
    });

    // 保存当前设置到 config.json
    document.getElementById("btn_save_setting_as_default").addEventListener("click", async () => {
        config.write(readGeneralConfig(), "general");
        config.write(readFilterConfig(), "filter");
        config.write(readBatchEditConfig(), "batch_edit");
        config.write(readEditSelectedConfig(), "edit_selected");
        await config.save();
        showToast(t("settings.saved_to_config"), "success");
    });

    // 恢复默认设置
    document.getElementById("btn_restore_default").addEventListener("click", async () => {
        config.config = {};
        await config.save();
        location.reload();
    });
}

// 应用 config.json 中保存的设置到界面
export function applyConfigToUI() {
    // 应用 general
    const general = config.read("general");
    if (general) {
        document.getElementById("cb_backup").checked = general.backup;
        document.getElementById("cb_remove_newlines").checked = general.remove_newlines;
        document.getElementById("tb_img_directory").value = general.dataset_dir || "";
        document.getElementById("tb_caption_file_ext").value = general.caption_ext || ".txt";
        document.getElementById("cb_load_recursive").checked = general.load_recursive;
        document.getElementById("cb_load_caption_from_filename").checked = general.load_caption_from_filename;
        document.getElementById("cb_load_caption_llm_reverse").checked = general.load_caption_llm_reverse;
        // 两个选项互斥：配置中若同时为真，则文件名加载优先，取消 LLM 反推
        if (general.load_caption_from_filename && general.load_caption_llm_reverse) {
            document.getElementById("cb_load_caption_llm_reverse").checked = false;
        }
        document.getElementById("cb_replace_new_line_with_comma").checked = general.replace_new_line;
    }
    const filter = config.read("filter");
    if (filter) {
        if (app.filterP) app.filterP.applyConfig(filter.positive);
        if (app.filterN) app.filterN.applyConfig(filter.negative);
    }
    const batchEdit = config.read("batch_edit");
    if (batchEdit) {
        document.getElementById("cb_show_only_tags_selected").checked = batchEdit.show_only_selected;
        document.getElementById("cb_prepend_tags").checked = batchEdit.prepend;
        document.getElementById("cb_use_regex").checked = batchEdit.use_regex;
        const srRadio = document.querySelector(`input[name="sr_target"][value="${batchEdit.target || "Only Selected Tags"}"]`);
        if (srRadio) srRadio.checked = true;
        if (app.removeTagSelect && batchEdit.list_display !== undefined) {
            app.removeTagSelect.setListDisplay(!!batchEdit.list_display);
        }
    }
    const editSelected = config.read("edit_selected");
    if (editSelected) {
        document.getElementById("cb_copy_caption_automatically").checked = editSelected.auto_copy;
        document.getElementById("cb_ask_save_when_caption_changed").checked = editSelected.warn_change_not_saved;
        document.getElementById("tb_highlight_rules").value = editSelected.highlight_rules || "";
        setCapsuleEnabled(!!editSelected.use_capsule);
    }
    refreshAll();
}

function readGeneralConfig() {
    return {
        backup: document.getElementById("cb_backup").checked,
        remove_newlines: document.getElementById("cb_remove_newlines").checked,
        dataset_dir: document.getElementById("tb_img_directory").value.trim(),
        caption_ext: document.getElementById("tb_caption_file_ext").value.trim() || ".txt",
        load_recursive: document.getElementById("cb_load_recursive").checked,
        load_caption_from_filename: document.getElementById("cb_load_caption_from_filename").checked,
        load_caption_llm_reverse: document.getElementById("cb_load_caption_llm_reverse").checked,
        replace_new_line: document.getElementById("cb_replace_new_line_with_comma").checked,
    };
}

function readFilterConfig() {
    return {
        positive: {
            sw_prefix: app.filterP.prefix,
            sw_suffix: app.filterP.suffix,
            sw_regex: app.filterP.regex,
            sort_by: app.filterP.sortBy,
            sort_order: app.filterP.sortOrder,
            list_display: app.filterP.listDisplay,
            logic: app.filterP.logic === FilterLogic.AND ? "AND" : app.filterP.logic === FilterLogic.OR ? "OR" : "NONE",
        },
        negative: {
            sw_prefix: app.filterN.prefix,
            sw_suffix: app.filterN.suffix,
            sw_regex: app.filterN.regex,
            sort_by: app.filterN.sortBy,
            sort_order: app.filterN.sortOrder,
            list_display: app.filterN.listDisplay,
            logic: app.filterN.logic === FilterLogic.AND ? "AND" : app.filterN.logic === FilterLogic.OR ? "OR" : "NONE",
        },
    };
}

function readBatchEditConfig() {
    return {
        show_only_selected: document.getElementById("cb_show_only_tags_selected").checked,
        prepend: document.getElementById("cb_prepend_tags").checked,
        use_regex: document.getElementById("cb_use_regex").checked,
        target: document.querySelector('input[name="sr_target"]:checked')?.value || "Only Selected Tags",
        sw_prefix: app.removeTagSelect ? app.removeTagSelect.prefix : false,
        sw_suffix: app.removeTagSelect ? app.removeTagSelect.suffix : false,
        sw_regex: app.removeTagSelect ? app.removeTagSelect.regex : false,
        sort_by: app.removeTagSelect ? app.removeTagSelect.sortBy : SortBy.ALPHA,
        sort_order: app.removeTagSelect ? app.removeTagSelect.sortOrder : SortOrder.ASC,
        list_display: app.removeTagSelect ? app.removeTagSelect.listDisplay : false,
    };
}

function readEditSelectedConfig() {
    return {
        auto_copy: document.getElementById("cb_copy_caption_automatically").checked,
        warn_change_not_saved: document.getElementById("cb_ask_save_when_caption_changed").checked,
        highlight_rules: document.getElementById("tb_highlight_rules").value,
        use_capsule: document.getElementById("cb_use_capsule_editor").checked,
    };
}

// ================================================================
// 9. 选择筛选
// ================================================================

// 当前左侧画廊选中的图像集合（单选 + Ctrl 多选）
function getGallerySelectedPaths() {
    const paths = new Set();
    for (const p of app.galleryMultiSelected) paths.add(p);
    if (app.gallerySelectedPath) paths.add(app.gallerySelectedPath);
    return paths;
}

// 将左侧画廊当前选中的全部图像加入选择筛选（有新增才重绘）
function addSelectedToTmpSelection() {
    let added = 0;
    for (const p of getGallerySelectedPaths()) {
        if (!app.tmpSelection.has(p)) {
            app.tmpSelection.add(p);
            added++;
        }
    }
    if (added > 0) updateSelectionGallery();
}

function initFilterSelection() {
    document.getElementById("btn_add_image_selection").addEventListener("click", () => {
        addSelectedToTmpSelection();
    });

    document.getElementById("btn_add_all_displayed_image_selection").addEventListener("click", () => {
        const imgs = app.dte.getFilteredImgpaths(app.getFilters());
        for (const p of imgs) app.tmpSelection.add(p);
        updateSelectionGallery();
    });

    document.getElementById("btn_remove_image_selection").addEventListener("click", () => {
        const path = app.tmpSelectionSelectedPath;
        if (path) app.tmpSelection.delete(path);
        app.tmpSelectionSelectedPath = "";
        updateSelectionGallery();
        updateSelectionTxt();
    });

    document.getElementById("btn_invert_image_selection").addEventListener("click", () => {
        const all = app.dte.getImgPathSet();
        const inverted = new Set([...all].filter(p => !app.tmpSelection.has(p)));
        app.tmpSelection = inverted;
        updateSelectionGallery();
    });

    document.getElementById("btn_clear_image_selection").addEventListener("click", () => {
        app.tmpSelection.clear();
        app.tmpSelectionSelectedPath = "";
        updateSelectionGallery();
        updateSelectionTxt();
    });

    document.getElementById("btn_apply_image_selection_filter").addEventListener("click", () => {
        if (app.tmpSelection.size > 0) {
            app.pathFilter = new PathFilter(new Set(app.tmpSelection), FilterMode.INCLUSIVE);
        } else {
            app.pathFilter = new PathFilter();
        }
        refreshAll();
    });

    // 键盘快捷键
    document.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.target !== document.getElementById("dte_edit_caption")) {
            addSelectedToTmpSelection();
        } else if (e.key === "Delete") {
            const path = app.tmpSelectionSelectedPath;
            if (path) app.tmpSelection.delete(path);
            app.tmpSelectionSelectedPath = "";
            updateSelectionGallery();
            updateSelectionTxt();
        }
    });
}

// ================================================================
// 10. 设置浮动窗口
// ================================================================

function initSettings() {
    buildSettingsGrid();
    buildLlmConfigs();
    buildLlmFunctions();

    // 打开 / 关闭设置窗口
    document.getElementById("btn_open_settings").addEventListener("click", async () => {
        // 刷新语言包列表（新增语言文件后自动出现在下拉框中）
        await discoverLanguages().catch(() => {});
        // 同步档案单选框为当前档案
        const rb = document.querySelector(`input[name="settings_profile"][value="${getActiveProfile()}"]`);
        if (rb) rb.checked = true;
        buildSettingsGrid();
        buildLlmConfigs();
        buildLlmFunctions();
        document.getElementById("settings_modal").classList.remove("hidden");
    });
    document.getElementById("btn_close_settings").addEventListener("click", () => {
        document.getElementById("settings_modal").classList.add("hidden");
    });
    const overlay = document.getElementById("settings_modal");
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.classList.add("hidden");
    });
    overlay.addEventListener("keydown", (e) => {
        if (e.key === "Escape") overlay.classList.add("hidden");
    });

    // 点击档案单选框（本地/示例）时立即切换配置档案文件
    document.querySelectorAll('input[name="settings_profile"]').forEach(rb => {
        rb.addEventListener("change", async () => {
            if (rb.value === getActiveProfile()) return;
            setActiveProfile(rb.value);
            await saveProfile();
            // 重新加载新档案的 config / settings 并刷新界面
            await config.load();
            await settings.load();
            setTagSeparators(getSetting("tag_separators"));
            applyConfigToUI();
            buildSettingsGrid();
            buildLlmConfigs();
            buildLlmFunctions();
            buildLlmFunctionButtons();
            setLang(getSetting("language"));
            await applyI18n();
            showToast(t("settings.saved"), "success");
        });
    });

    document.getElementById("btn_save_settings").addEventListener("click", async () => {
        // 依据档案单选框确定保存到本地（*.local.json）还是示例（*.json）
        const rb = document.querySelector('input[name="settings_profile"]:checked');
        if (rb) {
            setActiveProfile(rb.value);
            await saveProfile();
        }
        readSettingsFromGrid();
        readLlmConfigs();
        readLlmFunctions();
        await settings.save();
        // 立即应用标签分隔符设置
        setTagSeparators(getSetting("tag_separators"));
        const lang = getSetting("language");
        setLang(lang);
        await applyI18n();
        applyColumns();
        buildSettingsGrid();
        buildLlmConfigs();
        buildLlmFunctions();
        // 保存后重建编辑区的 LLM 功能按钮
        buildLlmFunctionButtons();
        showToast(t("settings.saved"), "success");
    });

    document.getElementById("btn_restore_default_settings").addEventListener("click", async () => {
        settings.restoreDefaults();
        buildSettingsGrid();
        buildLlmConfigs();
        buildLlmFunctions();
        buildLlmFunctionButtons();
    });

    document.getElementById("btn_clear_cache").addEventListener("click", async () => {
        const count = await thumbs.clearThumbCache();
        const el = document.getElementById("lbl_cache_status");
        el.hidden = false;
        el.textContent = count > 0 ? `Cleared ${count} thumbnail cache files` : "Thumbnail cache is already empty";
    });

    // 添加 / 删除 LLM 配置
    document.getElementById("btn_add_llm_config").addEventListener("click", () => {
        const configs = getSetting("llm_configs") || [];
        configs.push({ ...LLM_CONFIG_DEFAULT, name: `配置${configs.length + 1}` });
        setSetting("llm_configs", configs);
        buildLlmConfigs();
    });

    // 添加 / 删除 LLM 功能
    document.getElementById("btn_add_llm_function").addEventListener("click", () => {
        const fns = getSetting("llm_functions") || [];
        fns.push({ ...LLM_FN_DEFAULT, name: `功能${fns.length + 1}` });
        setSetting("llm_functions", fns);
        buildLlmFunctions();
    });
}

// 构建设置中的标点替换规则表格（每行：原字符 / 替换字符，可编辑、删除、添加行）
function createPunctRulesTable() {
    const wrap = document.createElement("div");
    wrap.className = "punct-rules-editor";
    const grid = document.createElement("div");
    grid.id = "setting_replace_punct_from";
    grid.className = "punct-rules-table";

    const addRow = (from, to) => {
        const row = document.createElement("div");
        row.className = "punct-rule-row";
        const fromInput = document.createElement("input");
        fromInput.type = "text";
        fromInput.className = "punct-from";
        fromInput.value = from;
        const arrow = document.createElement("span");
        arrow.className = "punct-arrow";
        arrow.textContent = "→";
        const toInput = document.createElement("input");
        toInput.type = "text";
        toInput.className = "punct-to";
        toInput.value = to;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn compact punct-del";
        del.textContent = "✕";
        del.title = t("settings.delete_rule");
        del.addEventListener("click", () => row.remove());
        row.append(fromInput, arrow, toInput, del);
        grid.appendChild(row);
    };

    const froms = getSetting("replace_punct_from") || [];
    const tos = getSetting("replace_punct_to") || [];
    const count = Math.max(froms.length, tos.length);
    for (let i = 0; i < count; i++) addRow(froms[i] || "", tos[i] || "");

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn compact";
    addBtn.textContent = t("settings.add_rule");
    addBtn.addEventListener("click", () => addRow("", ""));
    wrap.append(grid, addBtn);
    return wrap;
}

// 构建设置表单（通用设置项）
// 分组布局：语言置顶；画廊与缩略图分组；通用设置区；标点替换分组，各分组间以分割线分隔
function buildSettingsGrid() {
    const grid = document.getElementById("settings-grid");
    // 摘除清除缓存按钮容器（避免被 innerHTML 清空），画廊分组内再放回
    const clearBox = document.getElementById("clear-cache-box");
    if (clearBox) clearBox.remove();
    grid.innerHTML = "";

    const seen = new Set();
    const markSeen = (name) => { seen.add(name); };
    // 分组之间的分割线
    const divider = () => {
        const hr = document.createElement("hr");
        hr.className = "section-divider";
        grid.appendChild(hr);
    };

    // 语言设置置顶
    grid.appendChild(renderSettingsField("language"));
    markSeen("language");

    // 画廊与缩略图分组（含清除缓存按钮）
    for (const n of ["cleanup_tmpdir", "max_resolution", "gallery_image_width"]) markSeen(n);
    divider();
    grid.appendChild(buildGallerySection(clearBox));

    // 通用设置区
    divider();
    for (const name of ["filename_word_regex", "filename_join_string", "num_cpu_worker", "tag_separators", "auto_switch_next"]) {
        if (seen.has(name)) continue;
        markSeen(name);
        if (SETTINGS_HIDDEN.has(name)) continue;
        grid.appendChild(renderSettingsControl(name));
    }

    // 标点替换分组（默认折叠，折叠时只显示启用开关）
    for (const n of ["replace_punct_enabled", "replace_punct_from"]) markSeen(n);
    divider();
    grid.appendChild(buildPunctGroup());

    // 兜底：SETTINGS_DEFAULT 中其余未显式分组的键
    for (const name of Object.keys(SETTINGS_DEFAULT)) {
        if (seen.has(name)) continue;
        markSeen(name);
        if (SETTINGS_HIDDEN.has(name)) continue;
        if (name === "replace_punct_to") continue;
        grid.appendChild(renderSettingsControl(name));
    }

    // 兜底：画廊分组未放入时仍显示清除缓存按钮
    if (clearBox && !clearBox.parentNode) grid.appendChild(clearBox);
}

// 生成单个设置控件：布尔设置为 label+复选框同行，其余为 label 在上、控件在下
function renderSettingsControl(name) {
    return typeof settings.current[name] === "boolean"
        ? renderSettingsRow(name)
        : renderSettingsField(name);
}

// 构建设置输入控件（含语言下拉与标点规则表格等特殊分支）
function createSettingsInput(name, value) {
    let input;
    if (name === "language") {
        // 动态列出 locales 目录下可用的语言包（发现失败时回退 zh/en）
        input = document.createElement("select");
        input.id = "setting_" + name;
        const langs = getAvailableLanguages().length > 0
            ? getAvailableLanguages()
            : [{ code: "zh", name: t("settings.chinese") }, { code: "en", name: t("settings.english") }];
        const opts = [`<option value="auto">${escapeHtml(t("settings.auto"))}</option>`];
        for (const l of langs) {
            // zh / en 使用当前界面语言的名称，其它语言使用语言包 meta.name（或代码本身）
            const display = l.code === "zh" ? t("settings.chinese")
                : l.code === "en" ? t("settings.english")
                : l.name;
            opts.push(`<option value="${escapeHtml(l.code)}">${escapeHtml(display)}</option>`);
        }
        input.innerHTML = opts.join("");
        input.value = value;
    } else if (name === "replace_punct_from") {
        // 标点替换规则：表格显示，每行两列（原字符 / 替换字符），可编辑、删除、添加
        input = createPunctRulesTable();
    } else if (typeof value === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.id = "setting_" + name;
        input.checked = value;
    } else if (typeof value === "number") {
        input = document.createElement("input");
        input.type = "number";
        input.id = "setting_" + name;
        input.value = value;
    } else {
        input = document.createElement("input");
        input.type = "text";
        input.id = "setting_" + name;
        input.value = value;
    }
    return input;
}

// 普通字段：label 在上，控件在下
function renderSettingsField(name) {
    const value = settings.current[name];
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = t(SETTINGS_DESCRIPTIONS[name]);
    field.appendChild(label);
    field.appendChild(createSettingsInput(name, value));
    return field;
}

// 布尔设置行：复选框在前，label 在后
function renderSettingsRow(name) {
    const value = settings.current[name];
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("label");
    label.className = "settings-row-label";
    label.textContent = t(SETTINGS_DESCRIPTIONS[name]);
    label.htmlFor = "setting_" + name;
    const input = createSettingsInput(name, value);
    row.append(input, label);
    return row;
}

// 画廊与缩略图设置分组（分割线分隔，非卡片）：启动清缓存+清除按钮同行，下方为画廊分辨率设置
function buildGallerySection(clearBox) {
    const group = document.createElement("div");
    group.className = "settings-group";
    const title = document.createElement("div");
    title.className = "settings-group-title";
    title.textContent = t("settings.gallery_group");
    group.appendChild(title);

    const row = renderSettingsRow("cleanup_tmpdir");
    if (clearBox) row.appendChild(clearBox);
    group.appendChild(row);
    group.appendChild(renderSettingsField("max_resolution"));
    group.appendChild(renderSettingsField("gallery_image_width"));
    return group;
}

// 标点替换分组：使用 details/summary 折叠（折叠三角与 common.settings、dataset.load_settings 一致），
// 启用开关（复选框在前）作为折叠标题，默认折叠
function buildPunctGroup() {
    const details = document.createElement("details");
    details.className = "accordion";

    const summary = document.createElement("summary");
    const row = renderSettingsRow("replace_punct_enabled");
    summary.appendChild(row);
    details.appendChild(summary);

    // 点击启用开关（复选框/标签）时不触发折叠
    row.querySelectorAll("input,label").forEach(el => {
        el.addEventListener("click", (e) => e.stopPropagation());
    });

    const body = document.createElement("div");
    body.className = "col";
    body.appendChild(renderSettingsField("replace_punct_from"));
    details.appendChild(body);
    return details;
}

// 从设置表单读取
function readSettingsFromGrid() {
    for (const name of Object.keys(SETTINGS_DEFAULT)) {
        if (SETTINGS_HIDDEN.has(name)) continue;
        const el = document.getElementById("setting_" + name);
        if (!el) continue;
        const cur = settings.current[name];
        if (name === "language") {
            settings.current[name] = el.value;
        } else if (name === "replace_punct_from") {
            // 从表格读取标点替换规则，写入两个等长数组
            const from = [], to = [];
            el.querySelectorAll(".punct-rule-row").forEach(row => {
                const f = row.querySelector(".punct-from").value.trim();
                const t = row.querySelector(".punct-to").value;
                if (f) { from.push(f); to.push(t); }
            });
            settings.current.replace_punct_from = from;
            settings.current.replace_punct_to = to;
        } else if (typeof cur === "boolean") {
            settings.current[name] = el.checked;
        } else if (typeof cur === "number") {
            const v = parseFloat(el.value);
            settings.current[name] = isNaN(v) ? cur : v;
        } else {
            settings.current[name] = el.value;
        }
    }
}

// 填充"使用的配置"下拉框选项（值为配置名，空为默认/激活配置）
function fillConfigSelect(sel, value) {
    if (!sel) return;
    sel.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "默认（激活配置）";
    sel.appendChild(opt0);
    const configs = getSetting("llm_configs") || [];
    for (const c of configs) {
        if (!c.name) continue;
        const o = document.createElement("option");
        o.value = c.name;
        o.textContent = c.name;
        sel.appendChild(o);
    }
    sel.value = value || "";
}

// 构建 LLM 多配置管理界面
function buildLlmConfigs() {
    const box = document.getElementById("llm-configs-box");
    if (!box) return;
    box.innerHTML = "";
    // 同步独立的反推标注提示词
    const rp = document.getElementById("tb_llm_reverse_prompt");
    if (rp) rp.value = getSetting("llm_reverse_prompt") || "";
    // 同步独立的翻译提示词
    const tp = document.getElementById("tb_llm_translate_prompt");
    if (tp) tp.value = getSetting("llm_translate_prompt") || "";
    // 填充反推 / 翻译使用的配置下拉框
    fillConfigSelect(document.getElementById("tb_llm_reverse_config"), getSetting("llm_reverse_config"));
    fillConfigSelect(document.getElementById("tb_llm_translate_config"), getSetting("llm_translate_config"));
    const configs = getSetting("llm_configs") || [];
    const active = getSetting("llm_active_config");

    configs.forEach((cfg, idx) => {
        const card = document.createElement("div");
        card.className = "llm-card";

        // 卡片头部：名称 + 激活 + 删除
        const header = document.createElement("div");
        header.className = "llm-card-header";
        const nameLabel = document.createElement("label");
        nameLabel.className = "field-label llm-name-label";
        nameLabel.textContent = "配置名称";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "lc-name";
        nameInput.value = cfg.name || "";
        nameInput.dataset.idx = idx;
        header.appendChild(nameLabel);
        header.appendChild(nameInput);

        const activeLabel = document.createElement("label");
        activeLabel.className = "checkbox llm-active";
        const activeRadio = document.createElement("input");
        activeRadio.type = "radio";
        activeRadio.name = "llm_active";
        activeRadio.checked = cfg.name === active;
        activeRadio.dataset.idx = idx;
        const activeSpan = document.createElement("span");
        activeSpan.textContent = "使用";
        activeLabel.appendChild(activeRadio);
        activeLabel.appendChild(activeSpan);
        header.appendChild(activeLabel);

        // 复制配置按钮：基于当前配置创建副本
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "btn llm-copy-btn";
        copyBtn.textContent = "复制";
        copyBtn.addEventListener("click", () => {
            const cur = getSetting("llm_configs") || [];
            const copy = { ...cur[idx], name: (cfg.name || "未命名") + " 副本" };
            cur.splice(idx + 1, 0, copy);
            setSetting("llm_configs", cur);
            buildLlmConfigs();
        });
        header.appendChild(copyBtn);

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn btn-danger llm-del-btn";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", () => {
            const cur = getSetting("llm_configs") || [];
            if (cur.length <= 1) { showToast("至少保留一个 LLM 配置", "error"); return; }
            cur.splice(idx, 1);
            if (getSetting("llm_active_config") === cfg.name) {
                setSetting("llm_active_config", cur[0].name);
            }
            setSetting("llm_configs", cur);
            buildLlmConfigs();
        });
        header.appendChild(delBtn);
        card.appendChild(header);

        // 连接信息
        const row1 = document.createElement("div");
        row1.className = "llm-card-row";
        row1.appendChild(makeField("API 地址", "text", "lc-api-url", cfg.api_url, idx));
        row1.appendChild(makeField("API Key", "password", "lc-api-key", cfg.api_key, idx));
        card.appendChild(row1);

        // 模型与图像参数
        const row2 = document.createElement("div");
        row2.className = "llm-card-row";
        row2.appendChild(makeField("模型名", "text", "lc-model", cfg.model, idx));
        row2.appendChild(makeNumField("最大图像分辨率", "lc-max-res", cfg.max_image_resolution, idx, 1));
        card.appendChild(row2);

        // 自定义请求参数（文本框，每行一个 key: value）
        const paramsField = document.createElement("div");
        paramsField.className = "field";
        const paramsLabel = document.createElement("label");
        paramsLabel.className = "field-label";
        paramsLabel.textContent = "自定义请求参数（每行一个 key: value）";
        const paramsArea = document.createElement("textarea");
        paramsArea.className = "lc-extra-params";
        paramsArea.rows = 3;
        paramsArea.value = cfg.extra_params || "";
        paramsArea.placeholder = "temperature: 0.5\nmax_tokens: 512";
        paramsArea.dataset.idx = idx;
        paramsField.appendChild(paramsLabel);
        paramsField.appendChild(paramsArea);
        card.appendChild(paramsField);

        box.appendChild(card);
    });
}

// 读取 LLM 多配置（从表单回填到 settings）
function readLlmConfigs() {
    const cards = document.querySelectorAll("#llm-configs-box .llm-card");
    const configs = [];
    let active = getSetting("llm_active_config");
    cards.forEach(card => {
        const idx = card.querySelector(".lc-name").dataset.idx;
        const cfg = { ...LLM_CONFIG_DEFAULT };
        cfg.name = card.querySelector(".lc-name").value.trim();
        cfg.api_url = card.querySelector(".lc-api-url").value.trim();
        cfg.api_key = card.querySelector(".lc-api-key").value;
        cfg.model = card.querySelector(".lc-model").value.trim();
        cfg.extra_params = card.querySelector(".lc-extra-params").value;
        cfg.max_image_resolution = parseInt(card.querySelector(".lc-max-res").value, 10) || 0;
        if (card.querySelector(".llm-active input").checked) active = cfg.name;
        configs.push(cfg);
    });
    if (!active || !configs.some(c => c.name === active)) {
        active = configs[0] ? configs[0].name : "";
    }
    setSetting("llm_configs", configs);
    setSetting("llm_active_config", active);
    // 读取独立的反推标注提示词
    const rp = document.getElementById("tb_llm_reverse_prompt");
    if (rp) setSetting("llm_reverse_prompt", rp.value);
    // 读取反推标注使用的配置
    const rc = document.getElementById("tb_llm_reverse_config");
    if (rc) setSetting("llm_reverse_config", rc.value);
    // 读取独立的翻译提示词
    const tp = document.getElementById("tb_llm_translate_prompt");
    if (tp) setSetting("llm_translate_prompt", tp.value);
    // 读取翻译使用的配置
    const tc = document.getElementById("tb_llm_translate_config");
    if (tc) setSetting("llm_translate_config", tc.value);
}

// 构建 LLM 自定义功能管理界面
function buildLlmFunctions() {
    const box = document.getElementById("llm-functions-box");
    if (!box) return;
    box.innerHTML = "";
    const fns = getSetting("llm_functions") || [];

    fns.forEach((fn, idx) => {
        const card = document.createElement("div");
        card.className = "llm-card";

        // 头部：功能名称 + 删除
        const header = document.createElement("div");
        header.className = "llm-card-header";
        const nameLabel = document.createElement("label");
        nameLabel.className = "field-label llm-name-label";
        nameLabel.textContent = "功能名称";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "lf-name";
        nameInput.value = fn.name || "";
        nameInput.dataset.idx = idx;
        header.appendChild(nameLabel);
        header.appendChild(nameInput);
        // 使用的配置下拉框
        const cfgLabel = document.createElement("label");
        cfgLabel.className = "field-label llm-name-label";
        cfgLabel.textContent = "使用的配置";
        const cfgSelect = document.createElement("select");
        cfgSelect.className = "llm-fn-config";
        cfgSelect.dataset.idx = idx;
        fillConfigSelect(cfgSelect, fn.config);
        header.appendChild(cfgLabel);
        header.appendChild(cfgSelect);
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn btn-danger llm-del-btn";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", () => {
            const cur = getSetting("llm_functions") || [];
            cur.splice(idx, 1);
            setSetting("llm_functions", cur);
            buildLlmFunctions();
        });
        header.appendChild(delBtn);
        card.appendChild(header);

        // 系统提示
        const sysField = document.createElement("div");
        sysField.className = "field";
        const sysLabel = document.createElement("label");
        sysLabel.className = "field-label";
        sysLabel.textContent = "系统提示";
        const sysArea = document.createElement("textarea");
        sysArea.className = "lf-system-prompt";
        sysArea.rows = 3;
        sysArea.value = fn.system_prompt || "";
        sysArea.dataset.idx = idx;
        sysField.appendChild(sysLabel);
        sysField.appendChild(sysArea);
        card.appendChild(sysField);

        // 用户提示
        const usrField = document.createElement("div");
        usrField.className = "field";
        const usrLabel = document.createElement("label");
        usrLabel.className = "field-label";
        usrLabel.textContent = "用户提示";
        const usrArea = document.createElement("textarea");
        usrArea.className = "lf-user-prompt";
        usrArea.rows = 3;
        usrArea.value = fn.user_prompt || "";
        usrArea.dataset.idx = idx;
        usrField.appendChild(usrLabel);
        usrField.appendChild(usrArea);
        card.appendChild(usrField);

        // 复选框：发送图像 / 发送编辑框内容
        const checks = document.createElement("div");
        checks.className = "row";
        checks.appendChild(makeCheckbox("向 LLM 发送图像", "lf-send-image", fn.send_image, idx));
        checks.appendChild(makeCheckbox("向 LLM 发送编辑框内容", "lf-send-caption", fn.send_caption, idx));
        card.appendChild(checks);

        box.appendChild(card);
    });
}

// 读取 LLM 自定义功能
function readLlmFunctions() {
    const cards = document.querySelectorAll("#llm-functions-box .llm-card");
    const fns = [];
    cards.forEach(card => {
        const fn = { ...LLM_FN_DEFAULT };
        fn.name = card.querySelector(".lf-name").value.trim();
        fn.system_prompt = card.querySelector(".lf-system-prompt").value;
        fn.user_prompt = card.querySelector(".lf-user-prompt").value;
        fn.send_image = card.querySelector(".lf-send-image").checked;
        fn.send_caption = card.querySelector(".lf-send-caption").checked;
        fn.config = card.querySelector(".llm-fn-config").value;
        if (!fn.name) return;
        fns.push(fn);
    });
    setSetting("llm_functions", fns);
}

// 生成一个输入字段（label + input），用于 LLM 卡片
function makeField(labelText, type, cls, value, idx) {
    const wrap = document.createElement("div");
    wrap.className = "field llm-field";
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = type;
    input.className = cls;
    input.value = value ?? "";
    input.dataset.idx = idx;
    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
}

// 生成一个数字输入字段
function makeNumField(labelText, cls, value, idx, step) {
    const wrap = makeField(labelText, "number", cls, value, idx);
    const input = wrap.querySelector("input");
    input.step = step;
    input.min = 0;
    return wrap;
}

// 生成一个复选框
function makeCheckbox(labelText, cls, checked, idx) {
    const label = document.createElement("label");
    label.className = "checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = cls;
    input.checked = !!checked;
    input.dataset.idx = idx;
    const span = document.createElement("span");
    span.textContent = labelText;
    label.appendChild(input);
    label.appendChild(span);
    return label;
}

// ================================================================
// 11. 标签页切换
// ================================================================

function initTabs() {
    const tabs = document.querySelectorAll(".tab-btn");
    tabs.forEach(btn => {
        btn.addEventListener("click", () => {
            tabs.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            const target = document.getElementById(btn.dataset.tab);
            if (target) target.classList.add("active");

            // 重命名页进入时填充
            if (btn.dataset.tab === "tab_rename") {
                populateRename();
            }
            // 重新计算画廊列数（切换到包含画廊的标签页时）
            applyColumns();
        });
    });
}

// 页内子标签页切换（正向/负向筛选、批量编辑等）
function initSubTabs() {
    document.querySelectorAll(".sub-tabs").forEach(nav => {
        nav.querySelectorAll(".sub-tab-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                nav.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                nav.parentElement.querySelectorAll(".sub-tab-content").forEach(c => c.classList.remove("active"));
                const target = nav.parentElement.querySelector("#" + btn.dataset.subtab);
                if (target) target.classList.add("active");
            });
        });
    });
}

// ================================================================
// 12. 左中右分隔条拖动调整
// ================================================================

function initSplitters() {
    const left = document.getElementById("left_panel");
    const center = document.getElementById("center_panel");
    const right = document.getElementById("right_panel");

    // 依据设置或窗口宽度设置初始列宽
    const w = document.querySelector(".main").clientWidth || 1400;
    const savedLeft = getSetting("splitter_left_width");
    const savedRight = getSetting("splitter_right_width");
    left.style.width = (savedLeft > 0 ? savedLeft : Math.max(220, Math.round(w * 0.28))) + "px";
    right.style.width = (savedRight > 0 ? savedRight : Math.max(320, Math.round(w * 0.35))) + "px";
    applyColumns();

    // 保存当前左右栏宽度到设置
    function saveWidths() {
        setSetting("splitter_left_width", Math.round(left.getBoundingClientRect().width));
        setSetting("splitter_right_width", Math.round(right.getBoundingClientRect().width));
        settings.save();
    }

    // 为分隔条绑定拖动：target 为被调整宽度的面板，other 为对侧面板（弹性自适应）
    // reverse 表示 target 位于分隔条右侧，拖动方向相反
    function attach(splitter, target, other, minW, reverse) {
        splitter.addEventListener("mousedown", (e) => {
            e.preventDefault();
            splitter.classList.add("dragging");
            const startX = e.clientX;
            const targetW = target.getBoundingClientRect().width;
            const otherW = other.getBoundingClientRect().width;
            const total = targetW + otherW;
            const onMove = (ev) => {
                const dx = ev.clientX - startX;
                const dw = reverse ? -dx : dx;
                const pw = Math.min(Math.max(targetW + dw, minW), total - 260);
                target.style.width = pw + "px";
                applyColumns();
            };
            const onUp = () => {
                splitter.classList.remove("dragging");
                document.body.style.userSelect = "";
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                applyColumns();
                saveWidths();
            };
            document.body.style.userSelect = "none";
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    }

    // 左分隔条调整左栏宽度（左栏在分隔条左侧）
    attach(document.getElementById("splitter_lm"), left, center, 180, false);
    // 右分隔条调整右栏宽度（右栏在分隔条右侧，方向相反）
    attach(document.getElementById("splitter_mr"), right, center, 320, true);
}

// ================================================================
// 入口
// ================================================================

// 剪贴板历史修复：拦截复制事件，用原生宿主重新写入剪贴板
// WebView2 内部复制使用 Chromium 内部窗口句柄且为延迟渲染，Windows 剪贴板历史(Win+V)不会记录；
// 这里在默认复制完成后，经 Neutralino.clipboard 由原生进程立即写入，使复制内容进入系统剪贴板历史。
function setupClipboardRewrite() {
    document.addEventListener("copy", () => {
        // 先放行 WebView2 默认复制（保证粘贴正常），随后读取并重写剪贴板
        setTimeout(async () => {
            try {
                const text = await Neutralino.clipboard.readText();
                // 仅文本内容才重写；图片等无文本内容不处理，避免清空剪贴板
                if (text) await Neutralino.clipboard.writeText(text);
            } catch (e) {
                // 原生 API 不可用（如未重启应用）时静默失败，保留 WebView2 默认结果
            }
        }, 100);
    });
}

export async function setupUI() {
    // 剪贴板历史修复：让默认复制的内容进入系统剪贴板历史(Win+V)
    setupClipboardRewrite();
    initTabs();
    initSubTabs();
    initTagFilters();
    initLoadDataset();
    initLlmReverse();
    initFilterSelection();
    initBatchEdit();
    initEditSelected();
    initRename();
    initTopbar();
    initSettings();
    initSplitters();
    initHighlightRuleEditor();
    initGallerySort();
    initPreviewNav();
    initPreviewBgToggle();
    initPreviewZoom();
    initGalleryContextMenu();
    // 边界框：初始化画布并注入写回回调（拖拽结束后更新编辑框文本）
    initBbox();
    setOnBboxChange((text) => {
        const ta = document.getElementById("dte_edit_caption");
        ta.value = text;
        app.changeIsSaved = false;
        updateHighlightOverlay();
        updateBboxes();
        capsuleRefresh();
    });

    // 窗口大小变化时重新计算画廊列数并同步高亮 overlay 排版
    window.addEventListener("resize", () => {
        applyColumns();
        syncOverlayLayout();
    });

    refreshAll();
    // 自动加载 config.json 中保存的设置
    applyConfigToUI();
}
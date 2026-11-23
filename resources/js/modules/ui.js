// ui.js - UI 事件绑定与各功能模块初始化

import { app, renderGallery, openFolderDialog, applyColumns, updateGalleryStateDisplay, sortGalleryPaths, invalidateThumbUrlCache, updateThumbBadge, updateThumbCaption } from "./app.js";
import { config, settings, getSetting, setSetting, SETTINGS_DEFAULT, SETTINGS_DESCRIPTIONS, SETTINGS_HIDDEN, LLM_CONFIG_DEFAULT, LLM_FN_DEFAULT, LLM_PROMPT_DEFAULT, PROMPT_KINDS, getActivePrompt, getPromptByName, getActiveProfile, setActiveProfile, saveProfile } from "./config.js";
import { t, getLang, setLang, applyI18n, discoverLanguages, getAvailableLanguages } from "./i18n.js";
import { PathFilter, FilterMode, FilterLogic, SortBy, SortOrder, joinTagsWithSepts } from "./dataset.js";
import { TagFilterState } from "./tagfilter_state.js";
import * as api from "./api.js";
import * as thumbs from "./thumbnails.js";
import { normalizePath, getStem, getExtension, getImageMime, withSuffix, getBasename, getDirname, formatAspectRatio, floorToMultiple, splitCaption, splitCaptionWithSepts, setTagSeparators, normalizeSepSpaces, expandJsonInText, compressJsonInText } from "./utils.js";
import { parseRules, applyHighlight, escapeHtml } from "./highlight.js";
import { initAutocomplete, loadAutocompleteData, bindAutocomplete } from "./autocomplete.js";
import * as llm from "./llm.js";
import * as llmHistory from "./llmHistory.js";
import { initBbox, updateBboxes, setOnBboxChange, getCoordRange, serializeBboxes, findBalancedObject, coordsToXY } from "./bbox.js";
import { initCropPreview, updateCropPreview, setOnCropPreviewChange, getBucketForSize } from "./cropPreview.js";
import { init as initCapsule, setOnChange as setCapsuleOnChange, refresh as capsuleRefresh, setEnabled as setCapsuleEnabled } from "./capsule.js";
import { setupPopup, showPopup, hidePopup, focusPopup } from "./popup.js";
import { initPopups } from "./popups.js";

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
        syncRenameSelectionHighlight();
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
    // 排序与选中索引更新后再刷新状态区，保证"选中第几个"与排序一致
    updateGalleryStateDisplay(sorted);
}

// 画廊排序控件（在 gallery-label 同一行）
function initGallerySort() {
    const keySel = document.getElementById("gallery_sort_key");
    const dirBtn = document.getElementById("gallery_sort_dir");

    keySel.addEventListener("change", () => {
        app.gallerySort.key = keySel.value;
        refreshAll();
        // 文件操作列表跟随画廊排序，当前正在查看时立即刷新
        refreshRenameIfVisible();
    });

    dirBtn.addEventListener("click", () => {
        app.gallerySort.dir *= -1;
        dirBtn.textContent = app.gallerySort.dir === 1 ? "▲" : "▼";
        dirBtn.title = app.gallerySort.dir === 1 ? t("common.ascending") : t("common.descending");
        refreshAll();
        // 排序方向变化时同样刷新文件操作列表
        refreshRenameIfVisible();
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
        img.onerror = () => { img.removeAttribute("src"); updateBboxes(); updateCropPreview(); };
    } else {
        img.removeAttribute("src");
    }
    // 依据编辑框文本同步边界框（图像加载完成后会自动重绘）
    updateBboxes();
    // 同步分桶裁剪预览（图像加载完成后也会自动重绘）
    updateCropPreview();
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

// 通用信息浮窗：设置标题与内容后显示（与翻译/高亮帮助共用同一个浮窗）
// html 为 true 时以 innerHTML 渲染内容（用于支持 readme 中的链接等标记）
function showInfoPopup(title, text, html = false) {
    const popup = document.getElementById("info_popup");
    const titleEl = document.getElementById("info_popup_title");
    const content = document.getElementById("info_popup_content");
    if (!popup || !content) return;
    if (titleEl) titleEl.textContent = title;
    if (html) content.innerHTML = text;
    else content.textContent = text;
    showPopup(popup, 480, 380);
}

// 清洗 readme 原始文本为可安全渲染的 HTML：移除脚本/样式等危险标签，
// 以及 on* 事件属性、javascript:/data: 等危险协议，其余普通标记（如 <a href>）保留
function sanitizeReadmeHtml(text) {
    const template = document.createElement("template");
    template.innerHTML = String(text)
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        //.replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
        .replace(/<object[\s\S]*?<\/object>/gi, "")
        .replace(/<embed[\s\S]*?<\/embed>/gi, "")
        .replace(/<\/?(base|meta|link)[^>]*>/gi, "");
    for (const el of template.content.querySelectorAll("*")) {
        for (const attr of [...el.attributes]) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on")) { el.removeAttribute(attr.name); continue; }
            if (name === "href" || name === "src" || name === "xlink:href") {
                if (/^(javascript|vbscript|data):/.test(attr.value.trim().toLowerCase())) {
                    el.removeAttribute(attr.name);
                }
            }
        }
    }
    return template.innerHTML;
}

// 预览标题行"数据集说明"按钮：读取数据集目录下 readme.md 并显示（支持 HTML 标记、保留换行）
function initPreviewReadme() {
    const btn = document.getElementById("btn_dataset_readme");
    if (!btn) return;

    btn.addEventListener("click", async () => {
        let text = "";
        try {
            const dir = window.__app?.dte?.dataset_dir;
            const readmePath = dir ? normalizePath(`${dir}/readme.md`) : "";
            if (readmePath && await api.pathExists(readmePath)) {
                text = (await api.readTextFile(readmePath)) || "";
            }
        } catch (e) {
            text = "";
        }
        const html = sanitizeReadmeHtml(text);
        showInfoPopup(t("gallery.dataset_readme_title"), html || escapeHtml(t("gallery.dataset_readme_missing")), true);
    });
}

// 数据集目录下存在 readme.md 时显示"数据集说明"按钮，否则隐藏
async function updateReadmeBtnVisibility() {
    const btn = document.getElementById("btn_dataset_readme");
    if (!btn) return;
    let visible = false;
    try {
        const dir = window.__app?.dte?.dataset_dir;
        const readmePath = dir ? normalizePath(`${dir}/readme.md`) : "";
        visible = !!(readmePath && await api.pathExists(readmePath));
    } catch (e) {
        visible = false;
    }
    btn.hidden = !visible;
}

// 预览图像缩放：滚轮向上放大、向下缩小，范围为 1 ~ 20 倍，缩放以鼠标位置为锚点；支持左键拖动平移
let previewZoom = 1;
let previewPan = { x: 0, y: 0 };   // 图像中心的像素偏移（平移量）
let previewDragging = false;
let previewDragStart = { x: 0, y: 0, panX: 0, panY: 0 };

function applyPreviewTransform() {
    const img = document.getElementById("preview_img");
    if (img) img.style.transform = `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`;
    // 防止中键拖拽后 preview 容器产生滚动偏移（overflow:hidden 时 scrollTop 仍可被浏览器自动设置），导致画布与图像错位
    const box = document.getElementById("image_preview");
    if (box) { box.scrollTop = 0; box.scrollLeft = 0; }
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
    if (box) {
        box.classList.remove("dragging-image");
        box.scrollTop = 0;
        box.scrollLeft = 0;
    }
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
        updateCropPreview();
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
        updateCropPreview();
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
    app.registerGalleryState("gallery.selected_image", path);
    // 即时刷新"显示的图像"中的选中序号
    updateGalleryStateDisplay(app.galleryPaths || []);

    // 异步显示选中图像分辨率、宽高比与 64 倍数分辨率（启用分桶预览时显示分桶比例/尺寸）
    refreshSelectedImageResolution();

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
    syncRenameSelectionHighlight();
}

// 同步重命名区高亮：与画廊当前选中图像保持一致
function syncRenameSelectionHighlight() {
    document.querySelectorAll("#df_rename tbody tr").forEach(tr => {
        tr.classList.toggle("selected", !!app.gallerySelectedPath && tr.dataset.path === app.gallerySelectedPath);
    });
}

// 异步刷新状态栏"分辨率"行：原图尺寸、宽高比与 [] 中的 64 倍数分辨率；
// 启用分桶裁剪预览时，比例与 [] 中改用命中的分桶（随开关/分辨率输入变化）
function refreshSelectedImageResolution() {
    const path = app.gallerySelectedPath;
    if (!path) return;
    api.getImageSize(path).then(size => {
        if (app.gallerySelectedPath !== path) return; // 期间已切换图像
        let bw = 0, bh = 0;
        if (size) {
            const bucket = getBucketForSize(size.w, size.h);
            bw = bucket ? bucket.w : floorToMultiple(size.w);
            bh = bucket ? bucket.h : floorToMultiple(size.h);
        }
        const text = size
            ? `${size.w}×${size.h} (${formatAspectRatio(bw, bh)}) [${bw}×${bh}]`
            : t("gallery.unknown");
        app.registerGalleryState("gallery.resolution", text);
    }).catch(() => {});
}

// 将当前编辑框内容应用到当前选中图像（内存中）
function applyEditToSelected() {
    const ta = document.getElementById("dte_edit_caption");
    let text = ta.value;
    // 启用自动压缩 json 时，将编辑框中的 json 块压缩为单行（部分 lora 训练器只支持单行文本）
    if (getSetting("auto_compress_json")) {
        text = compressJsonInText(text);
    }
    // 规范化分隔符后的空格：无则补一个，多个则合并为一个，并写回编辑框；
    // 最后用 trim 清除标注首尾多余的空白（空格/换行）
    text = normalizeSepSpaces(text).trim();
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
// html 为 true 时以 innerHTML 渲染 message（支持格式化内容）
function showConfirmDialog(title, message, buttons, html = false) {
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
        if (html) msgEl.innerHTML = message;
        else msgEl.textContent = message;
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
        syncRenameSelectionHighlight();
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
        updateReadmeBtnVisibility();
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
                mtimes[p] = st ? st.modifiedAt : 0;
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
    // 依据数据集目录下是否存在 readme.md 决定是否显示"数据集说明"按钮
    await updateReadmeBtnVisibility();

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
    prompts: new Map(),  // path -> 使用的反推提示词名称（空表示当前启用的提示词）
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
    llmReverse.prompts = new Map();
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
        showPopup(panel, 480, 360);
        // 同步追加/覆盖选项
        document.getElementById("cb_llm_reverse_append").checked = getSetting("llm_reverse_append") !== false;
        renderAllRows();
        updateProgress();
    } else {
        hidePopup(panel);
        hideLlmPreview();
    }
}

// 加载完成后启动反推：打开窗口并加入缺失文本文件的图像
function startLlmReverseProcess(missingPaths) {
    toggleLlmReversePanel(true);
    for (const p of missingPaths) addLlmReverseImage(p);
}

// 将图像加入待反推队列（画廊拖入 / 加载缺失文件）；成功加入返回 true
// promptName 指定该图像使用的反推提示词（画廊右键菜单选择），为空时使用当前启用的一份
function addLlmReverseImage(path, promptName) {
    if (llmReverse.status.has(path)) {
        // 已在队列中：允许为尚未开始处理的任务改选反推提示词
        if (promptName && llmReverse.status.get(path) === "pending") {
            llmReverse.prompts.set(path, promptName);
        }
        return false;
    }
    if (!app.dte.dataset.getData(path)) return false;
    llmReverse.paths.push(path);
    llmReverse.status.set(path, "pending");
    if (promptName) llmReverse.prompts.set(path, promptName);
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
    llmReverse.prompts.delete(path);
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
    // 悬停显示图像预览，点击行（取消按钮除外）跳转到画廊中对应的图像
    bindRowPreview(row, path);
    row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        jumpToGalleryImage(path);
    });
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

// 列表行/缩略图悬停预览：复用 body 级预览图（层级高于浮窗，不会被遮挡）
function bindRowPreview(el, path) {
    el.addEventListener("mouseenter", (e) => showLlmPreview(path, e.clientX, e.clientY));
    el.addEventListener("mousemove", (e) => moveLlmPreview(e.clientX, e.clientY));
    el.addEventListener("mouseleave", hideLlmPreview);
}

// 点击跳转到画廊中对应的图像（筛选后不可见时不跳转；已选中但滚出可视区时滚回可视区）
async function jumpToGalleryImage(path) {
    const idx = app.galleryPaths.indexOf(path);
    if (idx < 0) return;
    await onGallerySelect(idx, path);
    if (app.gallerySelectedPath !== path) return; // 用户取消了未保存切换
    scrollGalleryToPath(path);
}

// 将画廊滚动到指定图像位置（已在可视区内则不滚动）
function scrollGalleryToPath(path) {
    const galleryEl = document.getElementById("dataset_gallery");
    if (!galleryEl) return;
    const item = [...galleryEl.querySelectorAll(".thumb-item")].find(el => el.dataset.path === path);
    if (item) item.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ================================================================
// 额外工具：JSON 坐标合规检查（结果在独立浮窗中显示，默认固定）
// ================================================================

// 浮窗是否固定（固定后点击窗口外不关闭；默认固定）
let jsonCheckPinned = true;

// 从 start（指向 '{'）扫描到配对的 '}'，返回结束下标；找不到返回 -1
function scanJsonObjectEnd(s, start) {
    if (s[start] !== "{") return -1;
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
            if (depth === 0) return i;
        }
    }
    return -1;
}

// 从文本中提取 object/objects 格式的边界框坐标。
// 返回 { boxes: [{label,x1,y1,x2,y2}], emptyIssues: [{kind,label?,key?}] }
// emptyIssues.kind: container(容器为空) / empty_label(空标签) / empty_coords(坐标为[]或null) / invalid_coords(坐标无效) / invalid_item(数组元素无效)
function extractJsonCoordinates(text) {
    const boxes = [];
    const emptyIssues = [];
    const s = String(text || "");
    const re = /\{\s*"(object|objects)"\s*:/g;
    let m;
    while ((m = re.exec(s))) {
        const start = m.index;
        const end = scanJsonObjectEnd(s, start);
        if (end < 0) continue;
        let json;
        try { json = JSON.parse(s.slice(start, end + 1)); } catch (e) { continue; }
        const key = m[1];
        const raw = json[key];
        const pushCoords = (label, coords) => {
            if (!label) { emptyIssues.push({ kind: "empty_label" }); return; }
            if (coords == null) { emptyIssues.push({ kind: "empty_coords", label: String(label) }); return; }
            if (Array.isArray(coords)) {
                if (coords.length === 0) { emptyIssues.push({ kind: "empty_coords", label: String(label) }); return; }
                const nums = coords.slice(0, 4).map(Number);
                if (nums.length < 4 || !nums.every(n => Number.isFinite(n))) {
                    emptyIssues.push({ kind: "invalid_coords", label: String(label) });
                    return;
                }
                // 数值顺序由坐标类型设置决定，统一转换为内部 x/y 后再校验
                boxes.push({ label: String(label), ...coordsToXY(nums) });
            } else {
                emptyIssues.push({ kind: "invalid_coords", label: String(label) });
            }
        };
        if (Array.isArray(raw)) {
            if (raw.length === 0) emptyIssues.push({ kind: "container", key });
            for (const item of raw) {
                if (item && typeof item === "object") {
                    for (const [label, coords] of Object.entries(item)) pushCoords(label, coords);
                } else {
                    emptyIssues.push({ kind: "invalid_item" });
                }
            }
        } else if (raw && typeof raw === "object") {
            if (Object.keys(raw).length === 0) emptyIssues.push({ kind: "container", key });
            for (const [label, coords] of Object.entries(raw)) pushCoords(label, coords);
        } else {
            emptyIssues.push({ kind: "container", key });
        }
        re.lastIndex = end + 1;
    }
    return { boxes, emptyIssues };
}

// 生成具体的不合规描述（含标签名与具体坐标值），返回字符串数组。
// 合法范围由坐标范围设置决定：0~1 或 0~1000。
function boxIssueDetails(box) {
    const { label, x1, y1, x2, y2 } = box;
    const max = getCoordRange();
    const d = [];
    // x1/y1 大于等于上限（含大于上限）
    if (x1 >= max) d.push(`${label}.x1=${x1} ${t("extra_tools.reason_x1y1_ge1").replace("{max}", String(max))}`);
    if (y1 >= max) d.push(`${label}.y1=${y1} ${t("extra_tools.reason_x1y1_ge1").replace("{max}", String(max))}`);
    // 其它坐标大于上限（x2/y2）
    if (x2 > max) d.push(`${label}.x2=${x2} ${t("extra_tools.reason_over").replace("{max}", String(max))}`);
    if (y2 > max) d.push(`${label}.y2=${y2} ${t("extra_tools.reason_over").replace("{max}", String(max))}`);
    // 顺序错误
    if (x1 > x2) d.push(`${label}: x1(${x1})>x2(${x2}) ${t("extra_tools.reason_order")}`);
    if (y1 > y2) d.push(`${label}: y1(${y1})>y2(${y2}) ${t("extra_tools.reason_order")}`);
    return d;
}

// 将空值问题转为本地化文本（含具体的键/标签）
function emptyIssueText(issue) {
    switch (issue.kind) {
        case "container":
            return t("extra_tools.detail_empty_container").replace("{key}", issue.key);
        case "empty_label":
            return t("extra_tools.detail_empty_label");
        case "empty_coords":
            return t("extra_tools.detail_empty_coords").replace("{label}", issue.label);
        case "invalid_coords":
            return t("extra_tools.detail_invalid_coords").replace("{label}", issue.label);
        case "invalid_item":
            return t("extra_tools.detail_invalid_item");
        default:
            return t("extra_tools.reason_empty");
    }
}

// 打开 / 关闭 JSON 检查结果浮窗
function toggleJsonCheckPanel(force) {
    const panel = document.getElementById("json_check_panel");
    if (!panel) return;
    const show = force !== undefined ? force : panel.classList.contains("hidden");
    if (show) {
        showPopup(panel, 480, 360);
        updateJsonCheckPinState();
    } else {
        hidePopup(panel);
        hideLlmPreview();
    }
}

// 更新浮窗固定状态样式
function updateJsonCheckPinState() {
    const panel = document.getElementById("json_check_panel");
    if (panel) panel.classList.toggle("pinned", jsonCheckPinned);
}

// 遍历数据集执行 JSON 检查，渲染统计与不合规列表到浮窗
function runJsonCheck() {
    const listEl = document.getElementById("extra_tools_json_list");
    const summaryEl = document.getElementById("extra_tools_summary");
    if (!listEl || !summaryEl) return;
    let total = 0;
    let withJson = 0;
    const badPaths = [];
    for (const [path, data] of app.dte.dataset.datas) {
        total++;
        let hasJson = false;
        const details = [];
        for (const tag of data.tags) {
            const res = extractJsonCoordinates(tag);
            if (res.boxes.length === 0 && res.emptyIssues.length === 0) continue;
            hasJson = true;
            for (const issue of res.emptyIssues) details.push(emptyIssueText(issue));
            for (const box of res.boxes) details.push(...boxIssueDetails(box));
        }
        if (hasJson) withJson++;
        if (details.length > 0) badPaths.push({ path, details });
    }
    // 统计
    summaryEl.innerHTML =
        t("extra_tools.summary_total").replace("{n}", String(total)) + "<br>" +
        t("extra_tools.summary_with_json").replace("{n}", String(withJson)) + "<br>" +
        t("extra_tools.summary_bad").replace("{n}", String(badPaths.length));
    // 列表（重建前先隐藏悬浮预览，避免旧行被移除后预览残留）
    hideLlmPreview();
    listEl.innerHTML = "";
    if (badPaths.length === 0) {
        const empty = document.createElement("div");
        empty.className = "extra-tools-empty";
        empty.textContent = t("extra_tools.empty");
        listEl.appendChild(empty);
    } else {
        for (const item of badPaths) {
            const row = document.createElement("div");
            row.className = "llm-progress-row extra-tools-row";
            const name = document.createElement("span");
            name.className = "llm-progress-name";
            name.textContent = getBasename(item.path);
            name.title = item.path;
            const reason = document.createElement("span");
            reason.className = "extra-tools-reason";
            reason.textContent = item.details.join("; ");
            reason.title = reason.textContent;
            row.appendChild(name);
            row.appendChild(reason);
            // 悬停显示图像预览，点击跳转到画廊中对应的图像
            bindRowPreview(row, item.path);
            row.addEventListener("click", () => {
                jumpToGalleryImage(item.path);
            });
            listEl.appendChild(row);
        }
    }
    toggleJsonCheckPanel(true);
}

let newlineCheckPinned = true;

function toggleNewlineCheckPanel(force) {
    const panel = document.getElementById("newline_check_panel");
    if (!panel) return;
    const show = force !== undefined ? force : panel.classList.contains("hidden");
    if (show) {
        showPopup(panel, 480, 360);
        updateNewlineCheckPinState();
    } else {
        hidePopup(panel);
        hideLlmPreview();
    }
}

function updateNewlineCheckPinState() {
    const panel = document.getElementById("newline_check_panel");
    if (panel) panel.classList.toggle("pinned", newlineCheckPinned);
}

function runNewlineCheck() {
    const listEl = document.getElementById("newline_tools_list");
    const summaryEl = document.getElementById("newline_tools_summary");
    if (!listEl || !summaryEl) return;
    let total = 0;
    const badPaths = [];
    for (const [path, data] of app.dte.dataset.datas) {
        total++;
        let caption = "";
        try { caption = joinTagsWithSepts(data.tags, data.septs); } catch(e) { caption = (data.tags||[]).join(", "); }
        let hasNewline = caption.includes("\n") || caption.includes("\r");
        if (!hasNewline) {
            for (const t of data.tags) if (t.includes("\n") || t.includes("\r")) { hasNewline = true; break; }
        }
        if (!hasNewline && data.septs) {
            for (const s of data.septs) if (s && (s.includes("\n") || s.includes("\r"))) { hasNewline = true; break; }
        }
        if (hasNewline) badPaths.push({ path, details: t("extra_tools.newline_reason") });
    }
    summaryEl.innerHTML =
        t("extra_tools.summary_total").replace("{n}", String(total)) + "<br>" +
        t("extra_tools.summary_newline_bad").replace("{n}", String(badPaths.length));
    hideLlmPreview();
    listEl.innerHTML = "";
    if (badPaths.length === 0) {
        const empty = document.createElement("div");
        empty.className = "extra-tools-empty";
        empty.textContent = t("extra_tools.newline_empty");
        listEl.appendChild(empty);
    } else {
        for (const item of badPaths) {
            const row = document.createElement("div");
            row.className = "llm-progress-row extra-tools-row";
            const name = document.createElement("span");
            name.className = "llm-progress-name";
            name.textContent = getBasename(item.path);
            name.title = item.path;
            const reason = document.createElement("span");
            reason.className = "extra-tools-reason";
            reason.textContent = item.details;
            reason.title = reason.textContent;
            row.appendChild(name);
            row.appendChild(reason);
            bindRowPreview(row, item.path);
            row.addEventListener("click", () => {
                jumpToGalleryImage(item.path);
            });
            listEl.appendChild(row);
        }
    }
    toggleNewlineCheckPanel(true);
}

// 将文本中的边界框 JSON 块坐标批量转换为目标范围格式（"0~1"/"0~1000"）。
// 每块自动识别现有格式：存在绝对值大于 1 的坐标视为 0~1000，否则视为 0~1；
// 已是目标格式的块保持原样。返回 { text, converted }（converted 为实际转换的块数）。
function convertBboxRangeInText(text, target) {
    const s = String(text || "");
    const re = /\{\s*"(object|objects)"\s*:/g;
    let m;
    let out = "";
    let last = 0;
    let converted = 0;
    while ((m = re.exec(s))) {
        const start = m.index;
        const bal = findBalancedObject(s, start);
        if (!bal) continue;
        const end = bal.end;
        let json;
        try { json = JSON.parse(s.slice(start, end + 1)); } catch (e) { continue; }
        const key = m[1];
        const raw = json[key];
        // 收集原始坐标数值（不 clamp，保留真实范围用于格式识别与换算）
        const items = [];
        let isMap = false;
        let ok = true;
        const collect = (label, coords) => {
            if (!Array.isArray(coords) || coords.length !== 4) { ok = false; return; }
            const nums = coords.map(Number);
            if (!nums.every(n => Number.isFinite(n))) { ok = false; return; }
            // 按坐标类型设置把原始数值还原为内部 x/y，避免转换时打乱顺序
            items.push({ label: String(label), ...coordsToXY(nums) });
        };
        if (Array.isArray(raw)) {
            if (raw.length === 0) ok = false;
            for (const item of raw) {
                if (!item || typeof item !== "object" || Object.entries(item).length !== 1) { ok = false; continue; }
                const [label, coords] = Object.entries(item)[0];
                collect(label, coords);
            }
        } else if (raw && typeof raw === "object") {
            isMap = true;
            if (Object.keys(raw).length === 0) ok = false;
            for (const [label, coords] of Object.entries(raw)) collect(label, coords);
        } else {
            ok = false;
        }
        re.lastIndex = end + 1;
        // 结构不合规的块不处理
        if (!ok || items.length === 0) continue;
        // 识别源格式并跳过已符合目标的块
        const maxV = Math.max(...items.flatMap(b => [Math.abs(b.x1), Math.abs(b.y1), Math.abs(b.x2), Math.abs(b.y2)]));
        const src = maxV > 1 ? "0~1000" : "0~1";
        if (src === target) continue;
        // 换算为内部 0~1 后按目标范围序列化（复用统一的格式化逻辑）
        const k = src === "0~1000" ? 1000 : 1;
        const internal = items.map(b => ({ label: b.label, x1: b.x1 / k, y1: b.y1 / k, x2: b.x2 / k, y2: b.y2 / k }));
        out += s.slice(last, start) + serializeBboxes(internal, key, isMap, target);
        last = end + 1;
        converted++;
    }
    if (converted === 0) return { text: s, converted };
    return { text: out + s.slice(last), converted };
}

// 将文本中边界框 JSON 块的坐标类型互换：
// [x_min, y_min, x_max, y_max] ↔ [y_min, x_min, y_max, x_max]。
// 仅调整块内四数字数组的排列顺序，数值本身原样保留（不重新格式化/换算），
// 避免精度变化。返回 { text, converted }（converted 为实际互换的坐标数组数）。
function convertBboxOrderInText(text) {
    const s = String(text || "");
    const re = /\{\s*"(object|objects)"\s*:/g;
    const reCoords = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
    let m;
    let out = "";
    let last = 0;
    let converted = 0;
    while ((m = re.exec(s))) {
        const start = m.index;
        const bal = findBalancedObject(s, start);
        if (!bal || bal.end < start) continue;
        const end = bal.end;
        // 只处理当前 JSON 块内部的坐标数组
        const block = s.slice(start, end + 1);
        let changed = 0;
        const swapped = block.replace(reCoords, (all, a, b, c, d) => {
            changed++;
            return `[${b},${a},${d},${c}]`;
        });
        if (changed > 0) {
            out += s.slice(last, start) + swapped;
            last = end + 1;
            converted += changed;
        }
        re.lastIndex = end + 1;
    }
    if (converted === 0) return { text: s, converted };
    return { text: out + s.slice(last), converted };
}

// 批量互换边界框坐标类型（两种类型互为目标）；
// 修改仅作用于内存中的标注，需点击"保存所有更改"写入文件
async function runConvertBboxOrder() {
    if (!app.dte || !app.dte.dataset || app.dte.dataset.length === 0) {
        showToast(t("extra_tools.convert_none"), "info");
        return;
    }
    const ok = await showConfirmDialog(
        t("extra_tools.convert_order_title"),
        t("extra_tools.convert_order_confirm"),
        [
            { key: "ok", label: t("common.apply"), cls: "primary" },
            { key: "cancel", label: t("common.cancel") },
        ]
    );
    if (ok !== "ok") return;
    let blocks = 0;
    let images = 0;
    // 与范围转换保持一致：启用自动压缩 json 时结果压缩为单行
    const compress = getSetting("auto_compress_json");
    for (const [, data] of app.dte.dataset.datas) {
        let imgChanged = 0;
        data.tags = data.tags.map(tag => {
            const r = convertBboxOrderInText(tag);
            if (r.converted > 0) { imgChanged += r.converted; return compress ? compressJsonInText(r.text) : r.text; }
            return tag;
        });
        if (imgChanged > 0) { blocks += imgChanged; images++; }
    }
    if (blocks === 0) {
        showToast(t("extra_tools.convert_none"), "info");
        return;
    }
    app.datasetDirty = true;
    refreshAll();
    showToast(t("extra_tools.convert_done").replace("{img}", String(images)).replace("{n}", String(blocks)), "success");
}

// 批量转换边界框坐标：目标格式取自设置 bbox_coordinate_range，
// 修改仅作用于内存中的标注，需点击"保存所有更改"写入文件
async function runConvertBboxRange() {
    if (!app.dte || !app.dte.dataset || app.dte.dataset.length === 0) {
        showToast(t("extra_tools.convert_none"), "info");
        return;
    }
    const target = getCoordRange() === 1000 ? "0~1000" : "0~1";
    const ok = await showConfirmDialog(
        t("extra_tools.convert_bbox_title"),
        t("extra_tools.convert_bbox_confirm").replace("{target}", target),
        [
            { key: "ok", label: t("common.apply"), cls: "primary" },
            { key: "cancel", label: t("common.cancel") },
        ]
    );
    if (ok !== "ok") return;
    let blocks = 0;
    let images = 0;
    // 启用自动压缩 json 时，转换后的 json 块同样压缩为单行（与"将更改应用于选中图像"行为一致）
    const compress = getSetting("auto_compress_json");
    for (const [, data] of app.dte.dataset.datas) {
        let imgChanged = 0;
        data.tags = data.tags.map(tag => {
            const r = convertBboxRangeInText(tag, target);
            if (r.converted > 0) { imgChanged += r.converted; return compress ? compressJsonInText(r.text) : r.text; }
            return tag;
        });
        if (imgChanged > 0) { blocks += imgChanged; images++; }
    }
    if (blocks === 0) {
        showToast(t("extra_tools.convert_none"), "info");
        return;
    }
    app.datasetDirty = true;
    refreshAll();
    showToast(t("extra_tools.convert_done").replace("{img}", String(images)).replace("{n}", String(blocks)), "success");
}

// 初始化额外工具面板（按钮 + 结果浮窗交互）
function initExtraTools() {
    const btn = document.getElementById("btn_check_json");
    if (btn) btn.addEventListener("click", runJsonCheck);
    // 批量转换边界框坐标范围（0~1 <-> 0~1000）
    const convertBtn = document.getElementById("btn_convert_bbox_range");
    if (convertBtn) convertBtn.addEventListener("click", runConvertBboxRange);
    // 批量互换边界框坐标类型（x/y 与 y/x 两种排列）
    const convertOrderBtn = document.getElementById("btn_convert_bbox_order");
    if (convertOrderBtn) convertOrderBtn.addEventListener("click", runConvertBboxOrder);
    // 边界框画板：启动新的应用程序级窗口（独立 HTML）
    const studioBtn = document.getElementById("btn_open_bbox_studio");
    if (studioBtn) studioBtn.addEventListener("click", async () => {
        // 将当前图像路径与标注文本写入 storage（仅打开画板时写1次）
        try {
            const curText = document.getElementById("dte_edit_caption")?.value || "";
            const curImg = app.gallerySelectedPath || "";
            const payload = JSON.stringify({ image: curImg, text: curText });
            try { await Neutralino.storage.setData("bbox_studio_init_data", payload); } catch (e) {}
        } catch (e) {}
        try {
            await Neutralino.window.create("/bbox_studio.html", {
                title: t("extra_tools.bbox_studio_title") || "边界框画板",
                width: 1280,
                height: 800,
                minWidth: 560,
                minHeight: 360,
                enableInspector: true,
                borderless: true,
                resizable: false,
                maximizable: false,
                hidden: true,
                exitProcessOnClose: true,
                processArgs: "--window=bbox_studio_" + Date.now()
            });
        } catch (e) {
            console.warn("window.create failed, fallback to window.open", e);
            window.open("bbox_studio.html", "_blank", "width=1280,height=800");
        }
    });

    const panel = document.getElementById("json_check_panel");
    if (panel) {
        // 刷新：重新执行 JSON 检查并刷新列表
        const refreshBtn = document.getElementById("json_check_refresh");
        if (refreshBtn) refreshBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            runJsonCheck();
        });
        // 通用浮窗行为：拖动 / 缩放 / 外部关闭 / 焦点置顶（固定状态由 jsonCheckPinned 控制）
        setupPopup(panel, {
            closeBtn: document.getElementById("btn_json_check_close"),
            pinBtn: document.getElementById("json_check_pin"),
            isPinned: () => jsonCheckPinned,
            onPinToggle: () => { jsonCheckPinned = !jsonCheckPinned; updateJsonCheckPinState(); },
            outsideClose: "click",
            ignoreOutside: [document.getElementById("btn_check_json")],
            onClose: () => toggleJsonCheckPanel(false),
            dragIgnore: "button, label, input, select, a",
            minW: 320,
            minH: 240,
            maxW: () => Math.min(720, window.innerWidth - 8),
            maxH: () => window.innerHeight - 8,
        });
    }

    // 换行检查按钮及浮窗（复用 JSON 检查样式，默认固定）
    const nlBtn = document.getElementById("btn_check_newline");
    if (nlBtn) nlBtn.addEventListener("click", runNewlineCheck);
    const nlPanel = document.getElementById("newline_check_panel");
    if (nlPanel) {
        const nlRefresh = document.getElementById("newline_check_refresh");
        if (nlRefresh) nlRefresh.addEventListener("click", (e) => { e.stopPropagation(); runNewlineCheck(); });
        setupPopup(nlPanel, {
            closeBtn: document.getElementById("btn_newline_check_close"),
            pinBtn: document.getElementById("newline_check_pin"),
            isPinned: () => newlineCheckPinned,
            onPinToggle: () => { newlineCheckPinned = !newlineCheckPinned; updateNewlineCheckPinState(); },
            outsideClose: "click",
            ignoreOutside: [document.getElementById("btn_check_newline")],
            onClose: () => toggleNewlineCheckPanel(false),
            dragIgnore: "button, label, input, select, a",
            minW: 320,
            minH: 240,
            maxW: () => Math.min(720, window.innerWidth - 8),
            maxH: () => window.innerHeight - 8,
        });
    }
}

// 重建全部行（打开窗口时同步当前状态，按画廊排序方式排序）
async function renderAllRows() {
    const listEl = document.getElementById("llm_progress_list");
    listEl.innerHTML = "";
    llmReverse.rows.clear();
    const sorted = await sortGalleryPaths(llmReverse.paths);
    for (const path of sorted) renderRow(path);
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
        const text = await llm.reverseCaption(next, llmReverse.prompts.get(next));
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
    // 关闭按钮由下方 setupPopup 统一注册（含隐藏预览）
    // 追加/覆盖选项（默认追加）
    document.getElementById("cb_llm_reverse_append").addEventListener("change", (e) => {
        setSetting("llm_reverse_append", e.target.checked);
    });
    // 通用浮窗行为在下方 setupPopup 中统一注册（含固定按钮）
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

    // 通用浮窗行为：拖动 / 缩放 / 外部关闭 / 焦点置顶
    // 用 click 而非 pointerdown 关闭：拖拽图像不会产生 click，避免误关
    setupPopup(panel, {
        closeBtn: document.getElementById("btn_llm_progress_close"),
        pinBtn: document.getElementById("llm_progress_pin"),
        isPinned: () => llmPinned,
        onPinToggle: () => { llmPinned = !llmPinned; updateLlmPinState(); },
        outsideClose: "click",
        ignoreOutside: [document.getElementById("btn_open_llm_progress")],
        onClose: () => { toggleLlmReversePanel(false); hideLlmPreview(); },
        dragIgnore: "button, label, input, select, a",
        minW: 300,
        minH: 240,
        maxW: () => Math.min(720, window.innerWidth - 8),
        maxH: () => window.innerHeight - 8,
    });
}

// ================================================================
// 右键菜单通用工具（画廊缩略图 / 编辑操作区共用）
// ================================================================

// 在指定坐标显示右键菜单（显示后测量尺寸，自动限制在窗口内）
function showContextMenu(menu, x, y) {
    menu.classList.remove("hidden");
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4)) + "px";
}

// 右键菜单通用关闭行为：点击菜单外 / Esc / 窗口失焦
function bindContextMenuDismiss(menu, onHide) {
    document.addEventListener("click", (e) => {
        if (!menu.classList.contains("hidden") && !menu.contains(e.target)) onHide();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") onHide();
    });
    window.addEventListener("blur", onHide);
}

// 菜单项前的勾选标记（功能开关 / 当前默认项）
function checkMark(checked) {
    const span = document.createElement("span");
    span.className = "cm-check";
    span.textContent = checked ? "✓" : "";
    return span;
}

// ================================================================
// 画廊右键菜单 + Ctrl 多选
// ================================================================

// 右键点击的图像路径（复制图像 / 复制连接 作用于此图）
let galleryContextPath = "";

// 关闭画廊右键菜单（同时收起提示词子菜单）
function hideGalleryContextMenu() {
    document.getElementById("gallery_context_menu").classList.add("hidden");
    hideReverseSubmenu();
}

// ---------- "加入反推列表"的右侧提示词子菜单 ----------

// 子菜单隐藏定时器（鼠标从主项移到子菜单的间隙不立即隐藏，避免闪烁）
let reverseSubmenuTimer = null;

// 构建子菜单：列出全部反推提示词，当前启用的那一份标记为默认（✓）
// 只有一份提示词时没有其它可选项，隐藏箭头与子菜单
function buildReverseSubmenu() {
    const item = document.getElementById("gallery_reverse_item");
    const submenu = document.getElementById("gallery_reverse_submenu");
    submenu.innerHTML = "";
    hideReverseSubmenu();
    const list = (getSetting("llm_reverse_prompts") || []).filter(p => p.name);
    if (list.length <= 1) {
        item.classList.remove("has-submenu");
        return;
    }
    item.classList.add("has-submenu");
    const activeName = getActivePrompt("reverse").name;
    for (const p of list) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.append(checkMark(p.name === activeName), p.name);
        btn.title = t("gallery.reverse_with_prompt");
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            addSelectedToReverse(p.name);
            hideGalleryContextMenu();
        });
        submenu.appendChild(btn);
    }
}

// 在菜单右侧显示子菜单；右侧空间不足时翻转到左侧
function showReverseSubmenu() {
    const item = document.getElementById("gallery_reverse_item");
    const submenu = document.getElementById("gallery_reverse_submenu");
    if (!item.classList.contains("has-submenu")) return;
    clearTimeout(reverseSubmenuTimer);
    submenu.classList.remove("hidden");
    const menuRect = document.getElementById("gallery_context_menu").getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const w = submenu.offsetWidth;
    const h = submenu.offsetHeight;
    let left = menuRect.right - 4;
    if (left + w > window.innerWidth - 4) left = Math.max(4, menuRect.left - w + 4);
    let top = itemRect.top - 4;
    if (top + h > window.innerHeight - 4) top = Math.max(4, window.innerHeight - h - 4);
    submenu.style.left = left + "px";
    submenu.style.top = top + "px";
}

// 隐藏子菜单（清除待执行定时器）
function hideReverseSubmenu() {
    clearTimeout(reverseSubmenuTimer);
    document.getElementById("gallery_reverse_submenu").classList.add("hidden");
}

// 延迟隐藏子菜单：留出鼠标从主项移动到子菜单的时间
function scheduleHideReverseSubmenu() {
    clearTimeout(reverseSubmenuTimer);
    reverseSubmenuTimer = setTimeout(hideReverseSubmenu, 160);
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

// 右键菜单作用的目标集合：右键目标属于当前选中集合（单选或 Ctrl 多选）时取全部选中，
// 否则只取右键目标本身
function getContextPaths() {
    const inSelection = galleryContextPath
        && (app.galleryMultiSelected.has(galleryContextPath)
            || galleryContextPath === app.gallerySelectedPath);
    const paths = inSelection ? getGallerySelectedPaths() : new Set();
    if (galleryContextPath) paths.add(galleryContextPath);
    return paths;
}

// 菜单动作：将图像加入反推列表
// promptName 指定使用的反推提示词（为空表示默认：当前启用的那一份）
function addSelectedToReverse(promptName) {
    const list = [...getContextPaths()];
    if (list.length === 0) return;
    // 打开反推管理窗口，便于查看队列
    toggleLlmReversePanel(true);
    for (const p of list) addLlmReverseImage(p, promptName);
    const name = promptName || getActivePrompt("reverse").name;
    showToast(`${t("gallery.added_to_reverse")}: ${list.length}${name ? ` · ${name}` : ""}`, "success");
}

// 菜单动作：将右键目标加入选择筛选
function addContextToSelection() {
    const paths = getContextPaths();
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

// 菜单动作：在系统资源管理器中定位图像（打开所在文件夹并选中）
async function revealImageAction() {
    const path = galleryContextPath || app.gallerySelectedPath;
    if (!path) return;
    const ok = await api.revealInExplorer(path);
    if (!ok) showToast(t("gallery.reveal_failed"), "error");
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
        // 每次打开时按当前提示词列表重建"加入反推列表"子菜单
        buildReverseSubmenu();
        showContextMenu(menu, e.clientX, e.clientY);
    });

    // "加入反推列表"主项悬停时在右侧展开其它反推提示词；
    // 鼠标移出主项后延迟隐藏，进入子菜单时取消隐藏
    const reverseItem = document.getElementById("gallery_reverse_item");
    const reverseSubmenu = document.getElementById("gallery_reverse_submenu");
    reverseItem.addEventListener("mouseenter", showReverseSubmenu);
    reverseItem.addEventListener("mouseleave", scheduleHideReverseSubmenu);
    reverseSubmenu.addEventListener("mouseenter", () => clearTimeout(reverseSubmenuTimer));
    reverseSubmenu.addEventListener("mouseleave", scheduleHideReverseSubmenu);

    // 点击菜单项执行对应动作
    menu.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === "copy_image") copyImageAction();
        else if (action === "copy_link") copyLinkAction();
        else if (action === "reveal") revealImageAction();
        else if (action === "reverse") addSelectedToReverse();
        else if (action === "add_selection") addContextToSelection();
        else if (action === "add_selection_all") addAllDisplayedToSelection();
        hideGalleryContextMenu();
    });

    // 点击菜单外 / Esc / 窗口失焦时关闭菜单
    bindContextMenuDismiss(menu, hideGalleryContextMenu);
}

// ================================================================
// 编辑操作区（.actions-row）右键菜单：快速启用 / 停用该区域的按钮
// ================================================================

// 切换布尔设置（缺省视为开启）
function toggleSetting(key) {
    setSetting(key, getSetting(key) === false);
}

// 应用"编辑操作区"按钮的显示设置（模式切换按钮可在设置或右键菜单中关闭）
function applyActionsRowVisibility() {
    const showMode = getSetting("show_mode_btn") !== false;
    document.getElementById("btn_toggle_mode").classList.toggle("hidden", !showMode);
    // 隐藏模式切换按钮时回到文本编辑模式，避免停留在胶囊模式下无法切回
    if (!showMode && document.getElementById("cb_use_capsule_editor").checked) {
        setCapsuleEnabled(false);
    }
}

// 应用翻译功能开关：关闭时隐藏"译"按钮并关闭翻译浮窗
function applyTranslateEnabled() {
    if (getSetting("translate_enabled") !== false) return;
    hideTranslateTrigger();
    hidePopup(document.getElementById("translate_popup"));
}

// 应用与编辑区按钮相关的设置（LLM 功能按钮 / 模式按钮 / 翻译开关）
function applyEditAreaSettings() {
    buildLlmFunctionButtons();
    applyActionsRowVisibility();
    applyTranslateEnabled();
}

// 构建编辑操作区菜单内容：标题 + 模式切换 / 替换标点 / 各 LLM 功能的启用开关
function buildActionsContextMenu() {
    const menu = document.getElementById("actions_context_menu");
    menu.innerHTML = "";

    const title = document.createElement("div");
    title.className = "context-menu-title";
    title.textContent = t("edit_caption.actions_menu_title");
    menu.appendChild(title);

    // 每个条目：勾选标记 + 文字，点击后切换开关并立即重建按钮区
    const addItem = (labelText, checked, onToggle) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.append(checkMark(checked), labelText);
        btn.title = labelText;
        btn.addEventListener("click", (e) => {
            // 阻止冒泡到 document 的"点击外部关闭"，菜单重建后仍能继续勾选
            e.stopPropagation();
            onToggle();
            applyEditAreaSettings();
            buildActionsContextMenu();
            settings.save().catch(err => console.warn("保存设置失败", err));
        });
        menu.appendChild(btn);
    };

    // 模式切换按钮（标签编辑 / 文本编辑）
    addItem(t("edit_caption.mode_btn"), getSetting("show_mode_btn") !== false,
        () => toggleSetting("show_mode_btn"));
    // 替换标点按钮
    addItem(t("edit_caption.replace_punct"), getSetting("replace_punct_enabled") !== false,
        () => toggleSetting("replace_punct_enabled"));
    // 各 LLM 功能按钮（名称即按钮文字，可单独启用 / 停用）
    const fns = (getSetting("llm_functions") || []).filter(fn => fn.name);
    for (const fn of fns) {
        addItem(fn.name, fn.enabled !== false, () => { fn.enabled = fn.enabled === false; });
    }
    if (fns.length === 0) {
        const empty = document.createElement("div");
        empty.className = "context-menu-note";
        empty.textContent = t("edit_caption.no_llm_functions");
        menu.appendChild(empty);
    }
}

// 初始化编辑操作区右键菜单
function initActionsContextMenu() {
    const row = document.querySelector(".actions-row");
    const menu = document.getElementById("actions_context_menu");
    if (!row || !menu) return;

    row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        buildActionsContextMenu();
        showContextMenu(menu, e.clientX, e.clientY);
    });
    bindContextMenuDismiss(menu, () => menu.classList.add("hidden"));
}

// ================================================================
// 4. 编辑选中图像面板
// ================================================================

function initEditSelected() {
    document.getElementById("btn_copy_caption").addEventListener("click", () => {
        const cap = document.getElementById("html_caption_display").textContent;
        // 复制到编辑框时同样将 json 块展开，便于编辑
        setEditCaptionValue(expandJsonInText(cap));
    });
    document.getElementById("btn_prepend_caption").addEventListener("click", () => {
        const ta = document.getElementById("dte_edit_caption");
        const cap = document.getElementById("html_caption_display").textContent;
        setEditCaptionValue([cap, ta.value].filter(Boolean).join(", "));
    });
    document.getElementById("btn_append_caption").addEventListener("click", () => {
        const ta = document.getElementById("dte_edit_caption");
        const cap = document.getElementById("html_caption_display").textContent;
        setEditCaptionValue([ta.value, cap].filter(Boolean).join(", "));
    });

    // 动态构建编辑选中图像页面的操作按钮，并应用模式按钮 / 翻译开关
    applyEditAreaSettings();

    // 高亮帮助
    document.getElementById("btn_highlight_help").addEventListener("click", () => {
        showHighlightHelp();
    });

    // 编辑输入框变化 -> 更新高亮 overlay
    const editTa = document.getElementById("dte_edit_caption");
    editTa.addEventListener("input", () => {
        app.changeIsSaved = false;
        updateHighlightOverlay();
        updateCaptionCharCount();
        updateBboxes();
        // 内容变化后之前的选中范围失效，避免点击"译"翻译到旧文本
        translateSel = null;
    });
    // 初始化字符数统计（dataset 加载前为 0，切换图像时由 updateEditCaptionPanel 刷新）
    updateCaptionCharCount();
    editTa.addEventListener("scroll", syncOverlayScroll);
    // 选中文本翻译：鼠标松开且存在选中文本时，在松开处显示 "译" 按钮
    // 注意：不要在 textarea 失焦时隐藏按钮——点击"译"会先触发失焦，
    // 若此时把按钮 display:none，后续 click 事件不会触发，且选中范围会塌缩。
    // 选中文本翻译：鼠标松开且存在选中文本时，在松开处显示 "译" 按钮。
    // 通过 document 委托统一覆盖主标注编辑框、胶囊标签/输入框、bbox 标签输入框、
    // 缩略图标题与 HTML 标注显示（普通元素的文本选择在 mouseup 时冒泡到 document）。
    document.addEventListener("mouseup", onSelectionMouseUp);
    initTranslatePopup();
    initInfoPopup();

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

    // 将 LLM 结果追加到标注编辑框（只取正文，不包含思考过程与统计信息）
    document.getElementById("btn_append_result_to_caption").addEventListener("click", () => {
        const body = document.getElementById("tool-result");
        // 先移除首尾空白，再移除首尾的 ```json 与 ``` 代码块标记
        let text = (body.querySelector(".tool-answer")?.textContent || "").trim();
        text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
        if (!text) return;
        const ta = document.getElementById("dte_edit_caption");
        setEditCaptionValue([ta.value, text].filter(Boolean).join(", "));
    });

    // 将 LLM 结果覆盖到标注编辑框（只取正文，不包含思考过程与统计信息）
    document.getElementById("btn_overwrite_result_to_caption").addEventListener("click", () => {
        const body = document.getElementById("tool-result");
        // 先移除首尾空白，再移除首尾的 ```json 与 ``` 代码块标记
        let text = (body.querySelector(".tool-answer")?.textContent || "").trim();
        text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
        if (!text) return;
        setEditCaptionValue(text);
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
        updateCaptionCharCount();
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
    setEditCaptionValue(text);
}

// 动态构建编辑选中图像页面的操作按钮（替换标点 + LLM 功能），均使用紧凑样式
// 按钮直接作为 .actions-row 的子节点参与排列；只清理上次动态生成的按钮，保留静态标签和模式切换按钮
function buildLlmFunctionButtons() {
    const row = document.querySelector(".actions-row");
    if (!row) return;
    row.querySelectorAll("[data-llm-fn-btn]").forEach(btn => btn.remove());

    const addButton = (labelText, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn compact";
        btn.dataset.llmFnBtn = "1";
        btn.textContent = labelText;
        btn.addEventListener("click", onClick);
        row.appendChild(btn);
    };

    // 替换标点按钮（可在设置中关闭，置于最前，随语言切换重建）
    if (getSetting("replace_punct_enabled")) {
        addButton(t("edit_caption.replace_punct"), replacePunctuation);
    }

    // LLM 功能按钮（设置中未启用的功能不显示）
    const fns = getSetting("llm_functions") || [];
    for (const fn of fns) {
        if (!fn || !fn.name) continue;
        if (fn.enabled === false) continue;
        addButton(fn.name, () => runLlmFunctionButton(fn));
    }
}

// 取思考过程的最后一行（忽略末尾空行），用于折叠时在标题行预览
function lastReasoningLine(text) {
    const lines = String(text || "").trimEnd().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line) return line;
    }
    return "";
}

// 初始化 #tool-result 的结构：思考过程（默认折叠且无内容时隐藏）+ 正文 + 统计信息
function resetToolResult(body) {
    body.innerHTML = "";
    const reasoning = document.createElement("details");
    reasoning.className = "tool-reasoning hidden";
    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.className = "tool-reasoning-label";
    label.textContent = t("llm_progress.reasoning");
    const preview = document.createElement("span");
    preview.className = "tool-reasoning-preview";
    summary.appendChild(label);
    summary.appendChild(preview);
    const reasoningBody = document.createElement("div");
    reasoningBody.className = "tool-reasoning-body";
    reasoning.appendChild(summary);
    reasoning.appendChild(reasoningBody);
    // 折叠时在标题行显示最后一行；展开时隐藏预览并自动滚动到底部
    reasoning.addEventListener("toggle", () => {
        preview.classList.toggle("hidden", reasoning.open);
        if (reasoning.open) reasoningBody.scrollTop = reasoningBody.scrollHeight;
    });

    const answer = document.createElement("div");
    answer.className = "tool-answer";

    const stats = document.createElement("div");
    stats.className = "tool-stats";

    body.appendChild(reasoning);
    body.appendChild(answer);
    body.appendChild(stats);
    return { reasoning, reasoningBody, preview, answer, stats };
}

// 格式化用量统计：⏱️耗时 速度 📦️总token ↑上传 ↓下载 ♻缓存命中；获取不到的项省略
function formatToolStats(stats) {
    const toNum = v => (typeof v === "number" && Number.isFinite(v)) ? v : undefined;
    const usage = stats?.usage || {};
    const durationMs = toNum(stats?.durationMs);
    const seconds = durationMs === undefined ? undefined : durationMs / 1000;
    const prompt = toNum(usage.prompt_tokens);
    const completion = toNum(usage.completion_tokens);
    const total = toNum(usage.total_tokens);
    const cached = toNum(usage.prompt_tokens_details?.cached_tokens)
        ?? toNum(usage.prompt_cache_hit_tokens)
        ?? toNum(usage.cached_tokens);

    const head = [];
    if (seconds !== undefined) head.push(`⏱️${seconds.toFixed(2)}s`);
    if (seconds !== undefined && seconds > 0 && completion !== undefined) {
        head.push(`${(completion / seconds).toFixed(1)}t/s`);
    }

    const detail = [];
    if (total !== undefined) detail.push(`📦️${total}`);
    if (prompt !== undefined) detail.push(`↑${prompt}`);
    if (completion !== undefined) detail.push(`↓${completion}`);
    if (cached !== undefined) detail.push(`♻${cached}`);

    return [head.join(" "), detail.join(" ")].filter(Boolean).join("  ");
}

// 执行自定义 LLM 功能按钮
async function runLlmFunctionButton(fn) {
    const body = document.getElementById("tool-result");
    const appendBtn = document.getElementById("btn_append_result_to_caption");
    const overwriteBtn = document.getElementById("btn_overwrite_result_to_caption");
    const view = resetToolResult(body);
    appendBtn.disabled = true;
    if (overwriteBtn) overwriteBtn.disabled = true;
    try {
        // 需要图片时读取并压缩选中图像
        let imageDataUrl = null;
        let imagePath = "";
        if (fn.send_image) {
            const selPath = app.gallerySelectedPath;
            if (!selPath) { body.textContent = t("llm_progress.select_image"); return; }
            const cfg = llm.resolveLlmConfig(fn.config);
            const maxRes = cfg ? (cfg.max_image_resolution || 0) : 0;
            imageDataUrl = await llm.prepareImage(selPath, maxRes);
            if (!imageDataUrl) { body.textContent = t("llm_progress.image_load_failed"); return; }
            // 调用历史只记录图像地址，不记录图片数据
            imagePath = selPath;
        }
        // 需要文本时读取编辑框内容
        let captionText = "";
        if (fn.send_caption) {
            captionText = document.getElementById("dte_edit_caption").value;
        }
        if (!imageDataUrl && !captionText.trim()) {
            body.textContent = t("llm_progress.select_image_or_text");
            return;
        }
        await llm.runLlmFunction(fn, { imageDataUrl, imagePath, captionText }, acc => {
            view.answer.textContent = acc;
            appendBtn.disabled = !acc.trim();
            if (overwriteBtn) overwriteBtn.disabled = !acc.trim();
        }, reasoning => {
            // 有思考过程时才显示可折叠区域，默认保持折叠
            view.reasoning.classList.remove("hidden");
            view.reasoningBody.textContent = reasoning;
            view.preview.textContent = lastReasoningLine(reasoning);
            // 已展开时跟随最新内容滚动到底部
            if (view.reasoning.open) view.reasoningBody.scrollTop = view.reasoningBody.scrollHeight;
        }, stats => {
            view.stats.textContent = formatToolStats(stats);
        });
    } catch (e) {
        body.textContent = t("translate.error_prefix") + (e.message || e);
    }
}

// ================================================================
// LLM 调用历史查看（左侧名称 + 右侧正文）
// ================================================================

// 历史正文分页：每次只渲染一页，滚动到顶部/底部附近时继续加载
const HISTORY_PAGE_SIZE = 10;
const HISTORY_LOAD_THRESHOLD = 80;

// 历史浮窗是否固定（固定后点击窗口外不关闭）
let llmHistoryPinned = false;

// 查看中的历史记录与已渲染的索引范围（新的记录在前）
let historyEntries = [];
let historyFrom = 0;
let historyTo = 0;

// 历史记录中的图像显示：由图像地址读取生成的对象 URL（重新渲染/关闭浮窗时释放）
let historyImageUrls = [];
let historyImageObserver = null;

// 释放历史图像占用的对象 URL 并断开懒加载观察器
function releaseHistoryImages() {
    for (const url of historyImageUrls) URL.revokeObjectURL(url);
    historyImageUrls = [];
    if (historyImageObserver) {
        historyImageObserver.disconnect();
        historyImageObserver = null;
    }
}

// 将本地文件缩放为缩略图对象 URL（用于不在当前数据集挂载目录中的历史图像）
async function fileToThumbUrl(path) {
    const buffer = await api.readBinaryFile(path);
    if (!buffer) return "";
    const blob = api.bufferToBlob(buffer, getImageMime(path));
    const bitmap = await createImageBitmap(blob);
    try {
        const maxRes = getSetting("max_resolution") || 128;
        const scale = Math.min(1, maxRes / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
        const out = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
        return out ? URL.createObjectURL(out) : "";
    } finally {
        bitmap.close();
    }
}

// 从本地文件生成缩略图并显示（不在当前数据集内的历史图像走这里）
async function loadHistoryImageFromFile(img, path) {
    try {
        const url = await fileToThumbUrl(path);
        if (!url) {
            img.remove();
            return;
        }
        if (!img.isConnected) {
            URL.revokeObjectURL(url);
            return;
        }
        historyImageUrls.push(url);
        img.src = url;
    } catch (e) {
        // 读取失败时移除图片元素，仅保留原图地址文本
        img.remove();
        console.warn("读取历史图像失败", path, e);
    }
}

// 显示历史记录中的缩略图：记录中保存的是原图地址，这里优先使用缩略图缓存
async function loadHistoryImage(img, path) {
    if (!path || !img.isConnected) return;
    const maxRes = getSetting("max_resolution") || 128;
    const stats = await api.getStats(path);
    if (!stats) {
        img.remove();
        return;
    }
    const mtime = stats.modifiedAt || 0;
    // 数据集已挂载时生成并缓存缩略图（已有缓存会直接返回）；失败则读取本地文件缩放
    const key = await thumbs.generateThumbnail(path, maxRes, mtime).catch(() => "");
    if (key && img.isConnected) {
        img.src = thumbs.getThumbCacheUrl(key);
        return;
    }
    await loadHistoryImageFromFile(img, path);
}

// 观察图像元素，滚动到可见区域附近时才加载（避免一次读取大量图片）
function observeHistoryImage(img, path) {
    if (!("IntersectionObserver" in window)) {
        loadHistoryImage(img, path);
        return;
    }
    if (!historyImageObserver) {
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                observer.unobserve(entry.target);
                loadHistoryImage(entry.target, entry.target.dataset.path || "");
            }
        }, { root: document.getElementById("llm_history_detail"), rootMargin: "300px" });
        historyImageObserver = observer;
    }
    img.dataset.path = path;
    historyImageObserver.observe(img);
}

// 创建历史记录中的图像区域（图像与地址纵向排列，地址不跟随缩略图宽度）
function createHistoryImages(images) {
    const wrap = document.createElement("div");
    wrap.className = "llm-history-images";
    for (const path of images) {
        if (path) {
            const img = document.createElement("img");
            img.className = "llm-history-image-thumb";
            img.alt = "";
            wrap.appendChild(img);
            observeHistoryImage(img, path);
        }
        const pathEl = document.createElement("div");
        pathEl.className = "llm-history-image-path";
        pathEl.textContent = path || t("llm_history.no_image");
        wrap.appendChild(pathEl);
    }
    return wrap;
}

// 记录的类型名称：自定义功能显示其名称，内置调用按当前语言显示类别
function llmHistoryTypeLabel(entry) {
    if (entry.type === "function") return entry.name || t("llm_history.type_function");
    const key = `llm_history.type_${entry.type}`;
    const label = t(key);
    return label === key ? (entry.name || entry.type || t("llm_history.type_function")) : label;
}

// 格式化记录时间
function formatHistoryTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || "");
    return d.toLocaleString();
}

// 创建正文中的一个消息块（系统/用户/模型/思考过程/错误）
// images 为图像地址字符串数组（不包含 base64 数据）
function createHistoryBlock(kind, title, text, images) {
    const block = document.createElement("div");
    block.className = `llm-history-block ${kind}`;

    const label = document.createElement("span");
    label.className = "llm-history-block-title";
    label.textContent = title;
    block.appendChild(label);

    const body = document.createElement("pre");
    body.className = "llm-history-block-text";
    body.textContent = text || "";
    block.appendChild(body);

    if (images && images.length > 0) {
        block.appendChild(createHistoryImages(images));
    }
    return block;
}

// 创建右侧正文中的一条完整记录
function createHistoryRecord(entry, index) {
    const record = document.createElement("section");
    record.className = "llm-history-record";
    record.dataset.index = String(index);

    const head = document.createElement("div");
    head.className = "llm-history-record-head";

    const title = document.createElement("span");
    title.className = "llm-history-record-title";
    title.textContent = llmHistoryTypeLabel(entry);
    head.appendChild(title);

    const time = document.createElement("span");
    time.textContent = formatHistoryTime(entry.time);
    head.appendChild(time);

    const modelInfo = [entry.config, entry.model].filter(Boolean).join(" / ");
    if (modelInfo) {
        const modelEl = document.createElement("span");
        modelEl.textContent = modelInfo;
        head.appendChild(modelEl);
    }

    const statsText = formatToolStats({ usage: entry.usage, durationMs: entry.durationMs });
    if (statsText) {
        const statsEl = document.createElement("span");
        statsEl.textContent = statsText;
        head.appendChild(statsEl);
    }
    record.appendChild(head);

    // 请求消息：区分系统与用户；用户消息附带图像地址
    const roleLabels = {
        system: t("llm_history.role_system"),
        user: t("llm_history.role_user"),
        assistant: t("llm_history.role_model"),
    };
    for (const msg of entry.messages || []) {
        const kind = msg.role === "system" ? "system" : msg.role === "user" ? "user" : "model";
        const titleText = roleLabels[msg.role] || msg.role || kind;
        // 系统与用户消息即使文本为空也保留，便于查看调用的完整结构
        record.appendChild(createHistoryBlock(kind, titleText, msg.text, msg.images));
    }

    if (entry.reasoning) {
        record.appendChild(createHistoryBlock("reasoning", t("llm_history.reasoning"), entry.reasoning));
    }
    if (entry.answer) {
        record.appendChild(createHistoryBlock("model", t("llm_history.role_model"), entry.answer));
    }
    if (entry.error) {
        record.appendChild(createHistoryBlock("error", t("llm_history.error"), entry.error));
    }
    return record;
}

// 将指定索引范围的记录追加到正文
function appendHistoryRecords(from, to) {
    const detailEl = document.getElementById("llm_history_detail");
    if (!detailEl) return;
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) {
        frag.appendChild(createHistoryRecord(historyEntries[i], i));
    }
    detailEl.appendChild(frag);
}

// 在正文底部加载下一页（更旧的记录）
function loadOlderHistoryPage() {
    if (historyTo >= historyEntries.length) return false;
    const to = Math.min(historyEntries.length, historyTo + HISTORY_PAGE_SIZE);
    appendHistoryRecords(historyTo, to);
    historyTo = to;
    return true;
}

// 在正文顶部加载上一页（更新的记录），并保持当前阅读位置不跳动
function loadNewerHistoryPage() {
    if (historyFrom <= 0) return false;
    const detailEl = document.getElementById("llm_history_detail");
    if (!detailEl) return false;
    const from = Math.max(0, historyFrom - HISTORY_PAGE_SIZE);
    const beforeHeight = detailEl.scrollHeight;
    const frag = document.createDocumentFragment();
    for (let i = from; i < historyFrom; i++) {
        frag.appendChild(createHistoryRecord(historyEntries[i], i));
    }
    detailEl.insertBefore(frag, detailEl.firstChild);
    historyFrom = from;
    detailEl.scrollTop += detailEl.scrollHeight - beforeHeight;
    return true;
}

// 内容不足一屏时继续加载，避免没有滚动条而无法翻页
function fillHistoryViewport() {
    const detailEl = document.getElementById("llm_history_detail");
    // 浮窗隐藏时 clientHeight 为 0，此时不加载，避免一次渲染全部
    if (!detailEl || !detailEl.clientHeight) return;
    while (detailEl.scrollHeight <= detailEl.clientHeight + HISTORY_LOAD_THRESHOLD && loadOlderHistoryPage()) {
        // 继续加载下一页
    }
}

// 滚动到顶部/底部附近时自动加载上一页/下一页
function onHistoryDetailScroll() {
    const detailEl = document.getElementById("llm_history_detail");
    if (!detailEl || !historyEntries.length) return;
    if (detailEl.scrollTop <= HISTORY_LOAD_THRESHOLD) {
        loadNewerHistoryPage();
    }
    if (detailEl.scrollHeight - detailEl.scrollTop - detailEl.clientHeight <= HISTORY_LOAD_THRESHOLD) {
        loadOlderHistoryPage();
    }
}

// 只渲染包含指定索引的一页（用于从左侧列表跳转到未加载的记录）
function renderHistoryPage(index) {
    const detailEl = document.getElementById("llm_history_detail");
    if (!detailEl) return;
    const from = Math.floor(index / HISTORY_PAGE_SIZE) * HISTORY_PAGE_SIZE;
    releaseHistoryImages();
    detailEl.innerHTML = "";
    detailEl.scrollTop = 0;
    historyFrom = from;
    historyTo = Math.min(historyEntries.length, from + HISTORY_PAGE_SIZE);
    appendHistoryRecords(from, historyTo);
    fillHistoryViewport();
}

// 选中左侧名称并把右侧正文滚动到对应记录（记录未渲染时先加载其所在页）
function selectHistoryRecord(item, index) {
    document.querySelectorAll("#llm_history_list .llm-history-item.selected")
        .forEach(el => el.classList.remove("selected"));
    item.classList.add("selected");
    if (index < historyFrom || index >= historyTo) {
        renderHistoryPage(index);
    }
    const record = document.querySelector(`#llm_history_detail .llm-history-record[data-index="${index}"]`);
    if (!record) return;
    record.scrollIntoView({ block: "start", behavior: "auto" });
    record.classList.add("flash");
    clearTimeout(record._flashTimer);
    record._flashTimer = setTimeout(() => record.classList.remove("flash"), 900);
}

// 渲染历史查看界面（左侧全部名称 + 右侧按需分页的正文）
async function renderLlmHistory() {
    const listEl = document.getElementById("llm_history_list");
    const detailEl = document.getElementById("llm_history_detail");
    if (!listEl || !detailEl) return;

    // 复制一份，避免查看期间新产生的记录改变数组索引
    historyEntries = (await llmHistory.loadHistory()).slice();
    // 释放上一次渲染生成的图像 URL 与观察器
    releaseHistoryImages();
    listEl.innerHTML = "";
    detailEl.innerHTML = "";
    historyFrom = 0;
    historyTo = 0;

    if (historyEntries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "llm-history-empty";
        empty.textContent = t("llm_history.empty");
        detailEl.appendChild(empty);
        return;
    }

    historyEntries.forEach((entry, index) => {
        // 左侧名称：点击后右侧跳转到该条记录
        const item = document.createElement("button");
        item.type = "button";
        item.className = "llm-history-item" + (entry.error ? " error" : "");

        const name = document.createElement("span");
        name.className = "llm-history-item-name";
        name.textContent = llmHistoryTypeLabel(entry);
        item.appendChild(name);

        const time = document.createElement("span");
        time.className = "llm-history-item-time";
        time.textContent = formatHistoryTime(entry.time);
        item.appendChild(time);

        item.addEventListener("click", () => selectHistoryRecord(item, index));
        listEl.appendChild(item);
    });

    // 右侧先只渲染最新一页，其余在滚动时加载
    loadOlderHistoryPage();
}

// 初始化历史浮窗：打开/固定/拖动/缩放
function initLlmHistory() {
    const panel = document.getElementById("llm_history_panel");
    const openBtn = document.getElementById("btn_llm_history");
    if (!panel || !openBtn) return;

    // 正文滚动到顶部/底部附近时自动加载更多
    const detailEl = document.getElementById("llm_history_detail");
    if (detailEl) detailEl.addEventListener("scroll", onHistoryDetailScroll, { passive: true });

    openBtn.addEventListener("click", async () => {
        // 已打开时点击按钮关闭（与其它浮窗的开关行为一致）
        if (!panel.classList.contains("hidden")) {
            hidePopup(panel);
            return;
        }
        await renderLlmHistory();
        showPopup(panel, 900, 600);
        // 显示后若一页内容不足一屏，继续加载
        fillHistoryViewport();
    });

    setupPopup(panel, {
        closeBtn: document.getElementById("btn_llm_history_close"),
        pinBtn: document.getElementById("llm_history_pin"),
        isPinned: () => llmHistoryPinned,
        onPinToggle: () => {
            llmHistoryPinned = !llmHistoryPinned;
            panel.classList.toggle("pinned", llmHistoryPinned);
        },
        outsideClose: "pointerdown",
        ignoreOutside: [openBtn],
        onClose: () => releaseHistoryImages(),
        dragIgnore: "button, input, select, a",
        minW: 520,
        minH: 300,
        maxW: () => Math.min(1200, window.innerWidth - 8),
        maxH: () => window.innerHeight - 8,
    });
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

// 鼠标松开：若在支持翻译的文本区域选中了文本，则在松开处显示 "译" 按钮。
// 支持范围：主标注编辑框、bbox 标签输入框、胶囊输入框（均可读 selectionStart/End），
// 以及胶囊标签、缩略图标题、HTML 标注显示、LLM 工具结果（普通元素，读取 window.getSelection()）。
function onSelectionMouseUp(e) {
    const btn = document.getElementById("translate_trigger");
    if (!btn) return;
    // 翻译功能关闭时不显示"译"按钮
    if (getSetting("translate_enabled") === false) {
        hideTranslateTrigger();
        return;
    }
    const target = e.target;
    // 点击"译"按钮/浮窗内部时不重置选中来源（按钮 mouseup 也会冒泡到这里，
    // 若清除 translateSel，后续 click 将因编辑框失焦而无从取到选中文本）
    if (btn.contains(target)) return;
    const popup = document.getElementById("translate_popup");
    if (popup && popup.contains(target)) return;
    const isInput = (el) => !!(el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT"));
    let source = null;
    if (isInput(target)) {
        // 输入框类：直接读取选中范围
        if (target.selectionStart == null || target.selectionStart === target.selectionEnd) {
            translateSel = null;
            hideTranslateTrigger();
            return;
        }
        source = { input: true, el: target, start: target.selectionStart, end: target.selectionEnd };
    } else if (target.closest) {
        // 普通元素：胶囊标签 / 缩略图标题 / HTML 标注显示 / LLM 工具结果
        const inCapsule = target.closest(".capsule-tag");
        const inThumb = target.closest(".thumb-caption");
        const inDisplay = target.closest("#html_caption_display");
        const inResult = target.closest("#tool-result");
        if (inCapsule || inThumb || inDisplay || inResult) {
            const selText = window.getSelection() ? String(window.getSelection()) : "";
            if (!selText.trim()) {
                translateSel = null;
                hideTranslateTrigger();
                return;
            }
            source = { input: false, el: inCapsule || inThumb || inDisplay || inResult, text: selText };
        }
    }
    if (!source) {
        translateSel = null;
        hideTranslateTrigger();
        return;
    }
    // 记录选中来源，供点击"译"按钮时使用
    translateSel = source;
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
    const firstShow = popup.classList.contains("hidden");
    showPopup(popup, 300, 200);
    if (anchorRect && !translatePinned) {
        // 与"译"按钮位置保持一致（按钮在选中文本右下角，浮窗也出现在同一位置）
        // showPopup 首次会自动居中，这里按锚点覆盖为按钮位置
        let left = anchorRect.left;
        let top = anchorRect.top;
        left = Math.max(4, Math.min(left, window.innerWidth - popup.offsetWidth - 4));
        top = Math.max(4, Math.min(top, window.innerHeight - popup.offsetHeight - 4));
        popup.style.left = left + "px";
        popup.style.top = top + "px";
    } else if (!firstShow) {
        focusPopup(popup);
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
    out.textContent = t("translate.translating");
    try {
        const result = await llm.translateText(norm, acc => {
            out.textContent = acc;
        });
        lastTranslate = { text: norm, result };
    } catch (e) {
        out.textContent = t("translate.error_prefix") + (e.message || e);
    }
}

// 翻译选中文本：打开浮窗、填入原文并自动翻译
async function translateSelection() {
    const btn = document.getElementById("translate_trigger");
    let selText = "";
    if (translateSel) {
        // 优先使用鼠标松开时记录的选中来源（点击"译"按钮时原元素可能已失焦、选中塌缩）
        const s = translateSel;
        selText = s.input
            ? String(s.el.value || "").substring(s.start, s.end).trim()
            : (s.text || "").trim();
    } else {
        // 回退：实时读取主编辑框的选中范围
        const ta = document.getElementById("dte_edit_caption");
        if (ta && ta.selectionStart != null && ta.selectionStart !== ta.selectionEnd) {
            selText = ta.value.substring(ta.selectionStart, ta.selectionEnd).trim();
        }
    }
    translateSel = null;
    if (!selText) return;
    // 未固定时记录按钮位置用于浮窗定位（随后隐藏按钮）
    const anchorRect = (!translatePinned && btn && !btn.classList.contains("hidden")) ? btn.getBoundingClientRect() : null;
    hideTranslateTrigger();
    showTranslatePopup(anchorRect);
    // 原文填入编辑框并自动翻译
    const src = document.getElementById("translate_source");
    if (src) {
        src.value = selText;
        src.focus();
        src.setSelectionRange(src.value.length, src.value.length);
    }
    runTranslate(selText);
}

// 更新浮窗固定状态样式
function updatePinState() {
    const popup = document.getElementById("translate_popup");
    if (popup) popup.classList.toggle("pinned", translatePinned);
}

// 初始化浮窗：固定 / 关闭 / 拖动 / 点击外部关闭（复用 popup.js）
function initTranslatePopup() {
    const popup = document.getElementById("translate_popup");
    const trigger = document.getElementById("translate_trigger");
    if (!popup || !trigger) return;

    // 通用浮窗行为：外部 pointerdown 关闭（固定/浮窗内部/译按钮除外）、拖动、缩放、焦点置顶
    setupPopup(popup, {
        closeBtn: document.getElementById("translate_close"),
        pinBtn: document.getElementById("translate_pin"),
        isPinned: () => translatePinned,
        onPinToggle: () => { translatePinned = !translatePinned; updatePinState(); },
        outsideClose: "pointerdown",
        ignoreOutside: [trigger],
        onClose: () => hideTranslateTrigger(),
        dragIgnore: "button",
        minW: 220,
        minH: 120,
        maxW: () => Math.min(600, window.innerWidth - 8),
        maxH: () => window.innerHeight - 8,
    });

    // 译按钮点击 -> 翻译选中文本
    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        translateSelection();
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

// 计算加权字符数：粗略按 ASCII (<128) 划分，分别使用不同倍率
// 默认倍率均为 1 时直接按字符串长度计算（与 length 等价，性能最优）
// 启用忽略空格时先清除空格再计算
function calcCaptionCharCount(text) {
    let s = String(text || "");
    // 忽略空格：移除所有空格后再计算
    if (getSetting("char_count_ignore_spaces")) {
        s = s.replace(/ /g, "");
    }
    const asciiRatio = Number(getSetting("char_count_ascii_ratio"));
    const nonAsciiRatio = Number(getSetting("char_count_non_ascii_ratio"));
    const a = Number.isFinite(asciiRatio) ? asciiRatio : 1;
    const n = Number.isFinite(nonAsciiRatio) ? nonAsciiRatio : 1;
    if (a === 1 && n === 1) return s.length;
    let total = 0;
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        total += code < 128 ? a : n;
    }
    return total;
}

// 更新编辑框字符数统计（仅数字，半透明叠加在 field 右下角）
function updateCaptionCharCount() {
    const ta = document.getElementById("dte_edit_caption");
    const el = document.getElementById("dte_caption_char_count");
    if (!el) return;
    const text = ta ? ta.value : "";
    const count = calcCaptionCharCount(text);
    // 整数直接显示；浮点保留最多 2 位小数并去除尾零
    if (Number.isInteger(count)) {
        el.textContent = String(count);
    } else {
        let str = count.toFixed(2);
        str = str.replace(/\.?0+$/, "");
        el.textContent = str;
    }
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
            // 加载到编辑框时将 json 块展开（格式化）显示，便于查看与编辑
            editTa.value = expandJsonInText(txt);
            app.changeIsSaved = true;
            updateHighlightOverlay();
        }
    } else {
        captionEl.innerHTML = "";
    }
    // 编辑框内容变化后同步边界框与胶囊标签
    updateBboxes();
    capsuleRefresh();
    updateCaptionCharCount();
}

// 通过原生编辑命令替换编辑框内容，使本次修改进入浏览器撤销栈（Ctrl+Z / Ctrl+Y 可用）。
// 直接设置 textarea.value 会清空原生撤销历史，因此按钮触发的文本修改统一走这里。
function setEditCaptionValue(text) {
    const ta = document.getElementById("dte_edit_caption");
    if (!ta) return;
    if (ta.value === text) return;
    ta.focus();
    // 全选后插入新文本：execCommand 会作为一次可撤销的编辑记录
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try {
        ok = document.execCommand("insertText", false, text);
    } catch (e) {
        ok = false;
    }
    if (!ok) {
        // 原生命令不可用时回退（不会保留撤销历史）
        ta.value = text;
        triggerEditInput();
    } else {
        // execCommand 已触发 input 事件，其余刷新由输入监听器完成，这里只同步胶囊标签
        capsuleRefresh();
    }
    // 光标放到末尾，方便继续编辑
    ta.setSelectionRange(text.length, text.length);
}

function triggerEditInput() {
    const ta = document.getElementById("dte_edit_caption");
    app.changeIsSaved = false;
    updateHighlightOverlay();
    updateCaptionCharCount();
    updateBboxes();
    // 胶囊编辑模式下同步刷新胶囊标签
    capsuleRefresh();
}

// 高亮规则帮助：复用通用信息浮窗显示
function showHighlightHelp() {
    showInfoPopup(t("edit_caption.highlight_help_title"), t("edit_caption.highlight_help_content"));
}

// 通用信息浮窗：与翻译浮窗一致的交互（按住标题栏拖动、右下角缩放，点击外部或 ✕ 关闭）
function initInfoPopup() {
    const popup = document.getElementById("info_popup");
    setupPopup(popup, {
        closeBtn: document.getElementById("info_popup_close"),
        outsideClose: "pointerdown",
        dragIgnore: "button",
        minW: 260,
        minH: 160,
        maxW: () => Math.min(640, window.innerWidth - 8),
        maxH: () => window.innerHeight - 8,
    });

    // readme 等 HTML 内容中的链接在系统默认浏览器中打开，不让当前窗口跳转
    const content = document.getElementById("info_popup_content");
    if (!content) return;
    content.addEventListener("click", (e) => {
        const a = e.target.closest("a[href]");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href");
        if (href) Neutralino.os.open(href);
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
    showPopup(popup, 440, 430);
    document.getElementById("hr_tags").focus();
    updateHighlightPreview();
}

// 关闭高亮规则编辑窗口
function closeHighlightRuleEditor() {
    const popup = document.getElementById("highlight_rule_modal");
    if (popup) hidePopup(popup);
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

    // 通用浮窗行为：拖动 / 缩放 / 外部关闭 / 焦点置顶（固定状态由 hrPinned 控制）
    const popup = document.getElementById("highlight_rule_modal");
    setupPopup(popup, {
        closeBtn: document.getElementById("hr_close"),
        pinBtn: document.getElementById("hr_pin"),
        isPinned: () => hrPinned,
        onPinToggle: () => { hrPinned = !hrPinned; updateHrPinState(); },
        outsideClose: "click",
        onClose: () => closeHighlightRuleEditor(),
        dragIgnore: "button, label, input, select, a",
        minW: 380,
        minH: 300,
        maxW: () => Math.min(720, window.innerWidth - 8),
        maxH: () => window.innerHeight - 8,
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
        if (st && st.modifiedAt) mtime = st.modifiedAt;
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

// 文件操作页可见时才刷新重命名列表（切换排序时调用，避免后台无谓排序开销）
function refreshRenameIfVisible() {
    if (document.getElementById("tab_rename")?.classList.contains("active")) {
        populateRename();
    }
}

async function populateRename() {
    const tbody = document.querySelector("#df_rename tbody");
    hideLlmPreview();
    renamePaths = await sortGalleryPaths(app.dte.getImgPathList());
    renameDeleteSet = new Set();
    if (renamePaths.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="small-note">(empty)</td></tr>`;
        return;
    }
    tbody.innerHTML = "";
    renamePaths.forEach((path, i) => {
        const tr = document.createElement("tr");
        tr.dataset.path = path;
        const tdThumb = document.createElement("td");
        const img = document.createElement("img");
        img.className = "rename-thumb";
        loadRenameThumb(img, path);
        // 悬停显示大图预览，点击缩略图跳转到画廊中对应的图像
        bindRowPreview(img, path);
        tdThumb.addEventListener("click", () => jumpToGalleryImage(path));
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
    // 列表重建后同步画廊当前选中图像的高亮
    syncRenameSelectionHighlight();
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
        // 保存结果用 toast 提示，不再写入 tool-result（避免覆盖 LLM 工具输出）
        showToast(t("topbar.save_done").replace("{saved}", String(result.saved)).replace("{total}", String(result.total)), "success");
        document.getElementById("btn_append_result_to_caption").disabled = true;
        const overwriteBtn = document.getElementById("btn_overwrite_result_to_caption");
        if (overwriteBtn) overwriteBtn.disabled = true;
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
        config.write(readCropPreviewConfig(), "crop_preview");
        await config.save();
        showToast(t("settings.saved_to_config"), "success");
    });

    // 恢复默认设置（需二次确认，显示当前配置内容）
    document.getElementById("btn_restore_default").addEventListener("click", async () => {
        // 构建当前配置的摘要信息
        const sections = [];
        const general = config.read("general");
        if (general) {
            const items = [];
            if (general.dataset_dir) items.push(`${t("dialog.cfg_dataset")}: ${general.dataset_dir}`);
            if (general.caption_ext) items.push(`${t("dialog.cfg_caption_ext")}: ${general.caption_ext}`);
            if (general.backup !== undefined) items.push(`${t("dialog.cfg_backup")}: ${general.backup ? t("dialog.cfg_yes") : t("dialog.cfg_no")}`);
            if (general.load_recursive) items.push(`${t("dialog.cfg_load_recursive")}: ${t("dialog.cfg_yes")}`);
            if (items.length > 0) sections.push(`<b>${t("dialog.cfg_general")}:</b> ${items.join(", ")}`);
        }
        const filter = config.read("filter");
        if (filter) {
            const pos = filter.positive;
            const neg = filter.negative;
            if (pos || neg) sections.push(`<b>${t("dialog.cfg_filter")}:</b> ${t("dialog.cfg_configured")}`);
        }
        const batchEdit = config.read("batch_edit");
        if (batchEdit) sections.push(`<b>${t("dialog.cfg_batch_edit")}:</b> ${t("dialog.cfg_configured")}`);
        const editSelected = config.read("edit_selected");
        if (editSelected) {
            const items = [];
            if (editSelected.auto_copy) items.push(t("dialog.cfg_auto_copy"));
            if (editSelected.highlight_rules) items.push(t("dialog.cfg_highlight_rules"));
            if (items.length > 0) sections.push(`<b>${t("dialog.cfg_edit_selected")}:</b> ${items.join(", ")}`);
        }
        const cropPreview = config.read("crop_preview");
        if (cropPreview && cropPreview.enabled) sections.push(`<b>${t("dialog.cfg_crop_preview")}:</b> ${t("dialog.cfg_enabled")}`);

        const msg = sections.length > 0
            ? `${t("dialog.restore_default_msg")}<br><br>${sections.join("<br>")}`
            : t("dialog.restore_default_msg");

        const key = await showConfirmDialog(
            t("dialog.restore_default"),
            msg,
            [
                { key: "ok", label: t("common.apply"), cls: "danger" },
                { key: "cancel", label: t("common.cancel") },
            ],
            true
        );
        if (key !== "ok") return;
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
    // 应用分桶裁剪预览（开关 + 目标分辨率）
    const cropPreview = config.read("crop_preview");
    if (cropPreview) {
        const cbCrop = document.getElementById("cb_crop_preview");
        const resInput = document.getElementById("crop_preview_res");
        if (cbCrop && typeof cropPreview.enabled === "boolean") cbCrop.checked = cropPreview.enabled;
        const res = Number(cropPreview.target_resolution);
        if (resInput && Number.isFinite(res) && res >= 64) resInput.value = Math.round(res);
        // 立即同步：裁剪画布重绘、bbox 重新对齐、状态栏比例/分辨率刷新
        updateCropPreview();
        updateBboxes();
        refreshSelectedImageResolution();
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

// 读取分桶裁剪预览设置（开关 + 目标分辨率）
function readCropPreviewConfig() {
    return {
        enabled: document.getElementById("cb_crop_preview").checked,
        target_resolution: parseInt(document.getElementById("crop_preview_res").value, 10) || 1024,
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
            ignore_json: app.filterP.ignoreJson,
            logic: app.filterP.logic === FilterLogic.AND ? "AND" : app.filterP.logic === FilterLogic.OR ? "OR" : "NONE",
        },
        negative: {
            sw_prefix: app.filterN.prefix,
            sw_suffix: app.filterN.suffix,
            sw_regex: app.filterN.regex,
            sort_by: app.filterN.sortBy,
            sort_order: app.filterN.sortOrder,
            list_display: app.filterN.listDisplay,
            ignore_json: app.filterN.ignoreJson,
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
    // 通用设置左栏导航：内容滚动时同步高亮
    initSettingsNavScrollSpy();

    // 打开 / 关闭设置窗口
    document.getElementById("btn_open_settings").addEventListener("click", async () => {
        // 刷新语言包列表（新增语言文件后自动出现在语言单选框里）
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
            applyEditAreaSettings();
            setLang(getSetting("language"));
            await applyI18n();
            // 状态栏标签按新语言重绘（键名不变，仅翻译变化）
            app.rerenderGalleryState();
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
        // 记录条数上限可能被调小，加载历史后立即裁剪（未加载时会先读取文件）
        await llmHistory.loadHistory();
        llmHistory.trimToLimit();
        // 立即应用标签分隔符设置
        setTagSeparators(getSetting("tag_separators"));
        const lang = getSetting("language");
        setLang(lang);
        await applyI18n();
        // 状态栏标签按新语言重绘（键名不变，仅翻译变化）
        app.rerenderGalleryState();
        applyColumns();
        buildSettingsGrid();
        buildLlmConfigs();
        buildLlmFunctions();
        // 保存后重建编辑区的 LLM 功能按钮，并应用模式按钮 / 翻译开关
        applyEditAreaSettings();
        // 字符统计倍率变化后立即刷新编辑框计数
        updateCaptionCharCount();
        // 坐标范围 / 坐标类型设置可能变化，重绘当前图像的边界框
        updateBboxes();
        showToast(t("settings.saved"), "success");
    });

    document.getElementById("btn_restore_default_settings").addEventListener("click", async () => {
        settings.restoreDefaults();
        buildSettingsGrid();
        buildLlmConfigs();
        buildLlmFunctions();
        applyEditAreaSettings();
        updateCaptionCharCount();
    });

    document.getElementById("btn_clear_cache").addEventListener("click", async () => {
        const count = await thumbs.clearThumbCache();
        const el = document.getElementById("lbl_cache_status");
        el.hidden = false;
        el.textContent = count > 0
            ? t("settings.cache_cleared").replace("{n}", String(count))
            : t("settings.cache_empty");
    });

    // 添加 LLM 配置：先回写所有卡片，再追加新配置并跳转过去
    document.getElementById("btn_add_llm_config").addEventListener("click", () => {
        readAllLlmConfigs();
        readAllLlmFunctions();
        const configs = getSetting("llm_configs") || [];
        configs.push({ ...LLM_CONFIG_DEFAULT, name: `${t("settings.config")}${configs.length + 1}` });
        setSetting("llm_configs", configs);
        buildLlmConfigs();
        // 让功能页与通用页的"使用的配置"下拉框同步出现新配置
        buildLlmFunctions();
        refreshPromptConfigSelects();
        jumpToLlmCard(document.getElementById("llm-configs-list"), document.getElementById("llm-configs-box"), configs.length - 1);
    });

    // 添加 LLM 功能：先回写所有卡片，再追加新功能并跳转过去
    document.getElementById("btn_add_llm_function").addEventListener("click", () => {
        readAllLlmFunctions();
        const fns = getSetting("llm_functions") || [];
        fns.push({ ...LLM_FN_DEFAULT, name: `${t("settings.fn")}${fns.length + 1}` });
        setSetting("llm_functions", fns);
        buildLlmFunctions();
        jumpToLlmCard(document.getElementById("llm-functions-list"), document.getElementById("llm-functions-box"), fns.length - 1);
    });
}

// 构建设置中的标点替换规则表格（每行：原字符 / 替换字符，可编辑、删除、添加行）
function createPunctRulesTable() {
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
    // 返回片段，由外层 .field 直接容纳表格与按钮，省去一层包装 div
    const fragment = document.createDocumentFragment();
    fragment.append(grid, addBtn);
    return fragment;
}

// 构建设置表单（通用设置项）
// 布局：左侧为按功能分组的导航列表（点击跳转），右侧一次性显示全部分组内容。
// 分组顺序：界面 / 数据集加载 / 画廊与缩略图 / 标注编辑与统计 / 边界框 / LLM 提示词 / LLM 调用历史
function buildSettingsGrid() {
    const grid = document.getElementById("settings-grid");
    const nav = document.getElementById("settings-nav-list");
    if (!grid) return;
    // 摘除清除缓存按钮容器（避免被 innerHTML 清空），画廊分组内再放回
    const clearBox = document.getElementById("clear-cache-box");
    if (clearBox) clearBox.remove();
    grid.innerHTML = "";
    if (nav) nav.innerHTML = "";

    // 追加一个分组：自动生成标题、跳转锚点，并在左侧导航中注册同名条目
    const addSection = (id, titleKey, ...nodes) => {
        const sec = document.createElement("section");
        sec.className = "settings-section";
        sec.id = "settings_sec_" + id;
        const title = document.createElement("div");
        title.className = "settings-group-title";
        title.textContent = t(titleKey);
        sec.appendChild(title);
        for (const node of nodes) sec.appendChild(node);
        grid.appendChild(sec);
        if (nav) nav.appendChild(createSettingsNavItem(sec, t(titleKey)));
    };

    // 界面（语言以单选框呈现）
    addSection("interface", "settings.interface_group", renderSettingsField("language"));

    // 数据集加载：文件名解析与预处理线程数，三项都作用于数据集加载阶段
    addSection("filename", "settings.filename_group",
        renderSettingsControl("filename_word_regex"),
        renderSettingsControl("filename_join_string"),
        renderSettingsControl("num_cpu_worker"));

    // 画廊与缩略图分组（含清除缓存按钮）
    addSection("gallery", "settings.gallery_group", ...buildGallerySection(clearBox));

    // 标注编辑与统计：标签分隔符、字符统计、编辑区按钮与保存后行为
    addSection("tag_punct", "settings.tag_punct_group", ...buildTagPunctGroup());

    // 边界框设置（坐标范围、坐标类型在前，0~1000 时小数位数禁用；JSON 压缩放最后）
    addSection("bbox", "settings.bbox_group",
        renderSettingsControl("bbox_coordinate_range"),
        renderSettingsControl("bbox_coordinate_order"),
        renderSettingsControl("bbox_json_decimal_places"),
        renderSettingsControl("auto_compress_json"));
    // 初始联动：0~1000 格式使用整数，禁用小数位数设置
    const precInput = document.getElementById("setting_bbox_json_decimal_places");
    if (precInput) precInput.disabled = settings.current.bbox_coordinate_range === "0~1000";

    // 反推 / 翻译提示词（翻译开关紧邻翻译提示词块）
    addSection("llm_prompt", "settings.llm_prompt_group", ...buildLlmPromptGroup());

    // LLM 调用历史（保留条数 + 清除历史）
    addSection("llm_history", "settings.llm_history_group", ...buildLlmHistoryGroup());

    // 兜底：画廊分组未放入时仍显示清除缓存按钮
    if (clearBox && !clearBox.parentNode) grid.appendChild(clearBox);

    // 默认高亮第一个分组
    if (nav && nav.firstElementChild) nav.firstElementChild.classList.add("selected");
}

// 创建通用设置左侧导航项：点击后滚动到对应分组（不隐藏其它分组）
function createSettingsNavItem(section, text) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "llm-settings-item";
    btn.textContent = text;
    btn.title = text;
    btn.dataset.target = section.id;
    btn.addEventListener("click", () => {
        const list = btn.parentElement;
        if (list) list.querySelectorAll(".llm-settings-item.selected").forEach(el => el.classList.remove("selected"));
        btn.classList.add("selected");
        section.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return btn;
}

// 通用设置内容滚动时同步左侧导航高亮（只绑定一次）
function initSettingsNavScrollSpy() {
    const detail = document.getElementById("settings-detail");
    const nav = document.getElementById("settings-nav-list");
    if (!detail || !nav || detail.dataset.navBound) return;
    detail.dataset.navBound = "1";
    detail.addEventListener("scroll", () => {
        const sections = [...detail.querySelectorAll(".settings-section")];
        if (!sections.length) return;
        // 取最后一个已滚动到内容区顶部的分组作为当前分组
        const top = detail.getBoundingClientRect().top;
        let current = sections[0];
        for (const s of sections) {
            if (s.getBoundingClientRect().top - top <= 12) current = s;
        }
        nav.querySelectorAll(".llm-settings-item").forEach(el => {
            el.classList.toggle("selected", el.dataset.target === current.id);
        });
    }, { passive: true });
}

// ================================================================
// 反推 / 翻译提示词：均可保存多份，并在设置中切换当前使用的一份
// ================================================================

// 确保指定类型的提示词列表至少有一项（为空时由旧版单条提示词生成一份）
function ensurePromptList(kind) {
    const meta = PROMPT_KINDS[kind];
    let list = getSetting(meta.listKey);
    if (!Array.isArray(list)) list = [];
    if (list.length === 0) {
        list = [{
            name: t("settings.prompt_default"),
            prompt: getSetting(meta.legacyPrompt) || "",
            config: getSetting(meta.legacyConfig) || "",
        }];
        setSetting(meta.listKey, list);
    }
    // 当前启用的提示词不存在时回退到第一份
    if (!list.some(p => p.name === getSetting(meta.activeKey))) setSetting(meta.activeKey, list[0].name);
    return list;
}

// 读取界面上的提示词编辑块并写回列表（切换 / 增删 / 保存前调用）
function readPromptBlock(kind) {
    const meta = PROMPT_KINDS[kind];
    const block = document.querySelector(`.llm-prompt-block[data-kind="${kind}"]`);
    if (!block) return;
    const list = getSetting(meta.listKey) || [];
    const item = list.find(p => p.name === getSetting(meta.activeKey)) || list[0];
    if (!item) return;
    const name = block.querySelector(".lp-name").value.trim();
    // 名称为空时保留原名，避免出现无名提示词；与其它提示词重名时自动追加序号
    if (name) {
        item.name = list.some(p => p !== item && p.name === name)
            ? uniquePromptName(list.filter(p => p !== item), name)
            : name;
        setSetting(meta.activeKey, item.name);
    }
    item.prompt = block.querySelector(".lp-text").value;
    item.config = block.querySelector(".lp-config").value;
}

// 读取两种类型的提示词编辑块（保存设置时调用）
function readAllPrompts() {
    readPromptBlock("reverse");
    readPromptBlock("translate");
}

// 生成不重复的提示词名称（重复时追加序号）
function uniquePromptName(list, base) {
    let name = base;
    let i = 2;
    while (list.some(p => p.name === name)) {
        name = `${base} ${i}`;
        i++;
    }
    return name;
}

// 重建指定类型的提示词编辑块（切换 / 增删后调用）
function rerenderPromptBlock(kind) {
    const old = document.querySelector(`.llm-prompt-block[data-kind="${kind}"]`);
    if (old) old.replaceWith(buildPromptBlock(kind));
}

// 构建单个提示词编辑块：切换下拉 + 新建 / 复制 / 删除 + 名称 / 提示词 / 使用的配置
function buildPromptBlock(kind) {
    const meta = PROMPT_KINDS[kind];
    const list = ensurePromptList(kind);
    const cur = list.find(p => p.name === getSetting(meta.activeKey)) || list[0];
    const isReverse = kind === "reverse";

    const block = document.createElement("div");
    block.className = "llm-prompt-block";
    block.dataset.kind = kind;

    // 切换下拉：先保存当前编辑内容，再载入所选提示词
    const select = document.createElement("select");
    select.className = "lp-select";
    for (const p of list) select.add(new Option(p.name, p.name));
    select.value = cur.name;
    select.addEventListener("change", () => {
        readPromptBlock(kind);
        setSetting(meta.activeKey, select.value);
        rerenderPromptBlock(kind);
    });

    // 标题行：左侧「类别 + 提示词选择」字段，右侧新建 / 复制 / 删除，与 LLM 卡片标题行结构一致
    const head = document.createElement("div");
    head.className = "llm-prompt-head";

    select.id = `lp-select-${kind}`;
    const field = makeLabeledField(
        t(isReverse ? "settings.llm_reverse_prompt" : "settings.llm_translate_prompt"),
        select,
        "llm-name-field"
    );
    field.querySelector("label").htmlFor = select.id;
    head.appendChild(field);

    const actions = document.createElement("div");
    actions.className = "llm-card-actions";
    actions.appendChild(makeCardBtn(t("settings.add_prompt"), "btn compact", () => {
        readPromptBlock(kind);
        const l = getSetting(meta.listKey);
        const item = { ...LLM_PROMPT_DEFAULT, name: uniquePromptName(l, t("settings.prompt_new")) };
        l.push(item);
        setSetting(meta.activeKey, item.name);
        rerenderPromptBlock(kind);
    }));

    actions.appendChild(makeCardBtn(t("settings.copy"), "btn compact", () => {
        readPromptBlock(kind);
        const l = getSetting(meta.listKey);
        const idx = l.findIndex(p => p.name === getSetting(meta.activeKey));
        if (idx < 0) return;
        const item = { ...l[idx], name: uniquePromptName(l, (l[idx].name || t("settings.unnamed")) + " " + t("settings.copy_suffix")) };
        l.splice(idx + 1, 0, item);
        setSetting(meta.activeKey, item.name);
        rerenderPromptBlock(kind);
    }));

    actions.appendChild(makeCardBtn(t("common.delete"), "btn danger llm-del-btn", async () => {
        const l = getSetting(meta.listKey) || [];
        if (l.length <= 1) {
            showToast(t("settings.min_one_prompt"), "error");
            return;
        }
        const name = block.querySelector(".lp-name").value.trim() || getSetting(meta.activeKey);
        if (!await confirmDelete("settings.delete_prompt_title", "settings.delete_prompt_msg", name)) return;
        readPromptBlock(kind);
        const idx = l.findIndex(p => p.name === getSetting(meta.activeKey));
        if (idx < 0) return;
        l.splice(idx, 1);
        setSetting(meta.activeKey, l[0].name);
        rerenderPromptBlock(kind);
    }));
    head.appendChild(actions);
    block.appendChild(head);

    // 提示词名称（名称变化时同步切换下拉中的条目，避免切换后定位不到）
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "lp-name";
    nameInput.value = cur.name;
    nameInput.addEventListener("input", () => {
        const text = nameInput.value.trim();
        const opt = select.selectedOptions[0];
        if (opt && text) {
            opt.value = text;
            opt.textContent = text;
        }
    });
    block.appendChild(makeLabeledField(t("settings.prompt_name"), nameInput));

    // 提示词内容
    const hintKey = isReverse ? "settings.llm_reverse_prompt_hint" : "settings.llm_translate_prompt_hint";
    const promptField = makeAreaField(t("settings.prompt_content"), "lp-text", cur.prompt, 4);
    const area = promptField.querySelector("textarea");
    area.placeholder = t(hintKey);
    area.setAttribute("data-i18n-placeholder", hintKey);
    block.appendChild(promptField);

    // 该提示词使用的配置
    const cfgSelect = document.createElement("select");
    cfgSelect.className = "lp-config";
    fillConfigSelect(cfgSelect, cur.config);
    block.appendChild(makeLabeledField(
        t(isReverse ? "settings.llm_reverse_config" : "settings.llm_translate_config"), cfgSelect));
    return block;
}

// LLM 提示词分组（每种类型均可保存多份并切换当前使用的一份）
// 顺序：反推提示词 → 翻译开关 → 翻译提示词，避免翻译开关被误认为控制反推
// 直接返回节点数组，由 .settings-section 自身的 flex/gap 负责间距，不再多包一层容器
function buildLlmPromptGroup() {
    // 翻译功能总开关：关闭后选中文本不再显示"译"按钮，翻译提示词也随之不生效
    const translateRow = renderSettingsRow("translate_enabled");
    const translateBlock = buildPromptBlock("translate");
    const cb = translateRow.querySelector("input");
    const syncDisabled = () => translateBlock.classList.toggle("disabled", !cb.checked);
    cb.addEventListener("change", syncDisabled);
    syncDisabled();
    return [buildPromptBlock("reverse"), translateRow, translateBlock];
}

// LLM 调用历史分组：保留条数设置 + 清除历史按钮
function buildLlmHistoryGroup() {
    // 保留条数（正整数，按 10 递增）
    const maxField = renderSettingsField("llm_history_max_entries");
    const maxInput = maxField.querySelector("input");
    maxInput.min = 1;
    maxInput.step = 10;

    // 清除按钮与结果提示
    const row = document.createElement("div");
    row.className = "row";
    const status = document.createElement("span");
    status.className = "cache-status";
    status.hidden = true;
    const clearBtn = makeCardBtn(t("settings.clear_llm_history"), "btn", async () => {
        const key = await showConfirmDialog(
            t("settings.clear_llm_history"),
            t("settings.clear_llm_history_msg"),
            [
                { key: "clear", label: t("common.clear"), cls: "danger" },
                { key: "cancel", label: t("common.cancel"), cls: "primary" },
            ]
        );
        if (key !== "clear") return;
        await llmHistory.clearHistory();
        status.hidden = false;
        status.textContent = t("settings.llm_history_cleared");
    });
    row.append(clearBtn, status);
    return [maxField, row];
}

// 重新填充"使用的配置"下拉框（配置增删或重命名后调用）
// renameMap 用于把旧配置名映射为新名，保留用户当前的选择；空值表示"默认（激活配置）"
function refreshPromptConfigSelects(renameMap) {
    for (const sel of document.querySelectorAll(".llm-prompt-block .lp-config")) {
        let cur = sel.value;
        if (renameMap && renameMap.has(cur)) cur = renameMap.get(cur);
        fillConfigSelect(sel, cur);
    }
}

// 生成单个设置控件：布尔设置为 label+复选框同行，其余为 label 在上、控件在下
function renderSettingsControl(name) {
    return typeof settings.current[name] === "boolean"
        ? renderSettingsRow(name)
        : renderSettingsField(name);
}

// 生成设置用的单选框组（name 同时作为 id 前缀与 radio 的 name）
// options: [[值, 语言键], ...]；onChange 可选
function createSettingsRadioGroup(name, options, onChange) {
    const wrap = document.createElement("div");
    wrap.id = "setting_" + name;
    wrap.className = "radio-row";
    for (const [val, labelKey] of options) {
        const label = document.createElement("label");
        label.className = "checkbox";
        const r = document.createElement("input");
        r.type = "radio";
        r.name = "setting_" + name;
        r.value = val;
        r.checked = settings.current[name] === val;
        const span = document.createElement("span");
        span.textContent = t(labelKey);
        label.append(r, span);
        wrap.appendChild(label);
    }
    if (onChange) wrap.addEventListener("change", onChange);
    return wrap;
}

// 生成语言单选框组（自动 + locales 目录下发现的各语言包）
// 语言显示名：zh / en 取当前界面语言的名称，其它语言取语言包 meta.name（或代码本身）
function createLanguageRadioGroup(value) {
    const wrap = document.createElement("div");
    wrap.id = "setting_language";
    wrap.className = "radio-row";
    const langs = getAvailableLanguages().length > 0
        ? getAvailableLanguages()
        : [{ code: "zh", name: t("settings.chinese") }, { code: "en", name: t("settings.english") }];
    const options = [{ value: "auto", label: t("settings.auto") }];
    for (const l of langs) {
        const display = l.code === "zh" ? t("settings.chinese")
            : l.code === "en" ? t("settings.english")
            : l.name;
        options.push({ value: l.code, label: display });
    }

    let matched = false;
    for (const o of options) {
        const label = document.createElement("label");
        label.className = "checkbox";
        const r = document.createElement("input");
        r.type = "radio";
        r.name = "setting_language";
        r.value = o.value;
        r.checked = value === o.value;
        if (r.checked) matched = true;
        const span = document.createElement("span");
        span.textContent = o.label;
        label.append(r, span);
        wrap.appendChild(label);
    }
    // 保存的语言不在可用列表时（如语言包已被删除），回退为"自动"
    if (!matched) {
        const first = wrap.querySelector("input");
        if (first) first.checked = true;
    }
    return wrap;
}

// 构建设置输入控件（含语言单选框与标点规则表格等特殊分支）
function createSettingsInput(name, value) {
    let input;
    if (name === "language") {
        // 语言：单选框（自动 + 各语言包）
        input = createLanguageRadioGroup(value);
    } else if (name === "bbox_coordinate_range") {
        // 边界框坐标范围：单选框（0~1 归一化小数 / 0~1000 整数）
        input = createSettingsRadioGroup(name, [
            ["0~1", "settings.coord_range_01"],
            ["0~1000", "settings.coord_range_1000"],
        ], () => {
            // 选中 0~1000 时使用整数，联动禁用小数位数设置
            const prec = document.getElementById("setting_bbox_json_decimal_places");
            if (prec) prec.disabled = input.querySelector("input:checked").value === "0~1000";
        });
    } else if (name === "bbox_coordinate_order") {
        // 边界框坐标类型：JSON 中两组坐标数值的排列顺序
        input = createSettingsRadioGroup(name, [
            ["xyxy", "settings.coord_order_xyxy"],
            ["yxyx", "settings.coord_order_yxyx"],
        ]);
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

// 画廊与缩略图设置项：启动清缓存与清除按钮同行，下方为画廊分辨率设置
// 返回节点数组，由 buildSettingsGrid 放入对应分组（标题由分组统一生成）
function buildGallerySection(clearBox) {
    const row = renderSettingsRow("cleanup_tmpdir");
    if (clearBox) row.appendChild(clearBox);
    return [
        row,
        renderSettingsField("max_resolution"),
        renderSettingsField("gallery_image_width"),
    ];
}

// 字符统计倍率：合并为单个文本框，逗号分隔（ASCII,非ASCII）
function createCharCountField() {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = t(SETTINGS_DESCRIPTIONS["char_count_ratio"]);
    label.htmlFor = "setting_char_count_ratio";
    const input = document.createElement("input");
    input.type = "text";
    input.id = "setting_char_count_ratio";
    const a = getSetting("char_count_ascii_ratio");
    const n = getSetting("char_count_non_ascii_ratio");
    input.value = `${a},${n}`;
    input.placeholder = "1,1";
    field.appendChild(label);
    field.appendChild(input);
    return field;
}

// 标注编辑与统计设置项：从标签分隔符到替换标点（含字符统计）
// JSON 压缩已移入边界框分组；返回节点数组，由 buildSettingsGrid 放入对应分组
function buildTagPunctGroup() {
    return [
        renderSettingsField("tag_separators"),
        renderSettingsRow("auto_switch_next"),
        createCharCountField(),
        renderSettingsRow("char_count_ignore_spaces"),
        renderSettingsRow("show_mode_btn"),
        buildPunctGroup(),
    ];
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
        // 字符统计两项由合并文本框统一读取，跳过单独处理
        if (name === "char_count_ascii_ratio" || name === "char_count_non_ascii_ratio") continue;
        const el = document.getElementById("setting_" + name);
        if (!el) continue;
        const cur = settings.current[name];
        if (name === "language" || name === "bbox_coordinate_range" || name === "bbox_coordinate_order") {
            // 语言与边界框坐标范围 / 坐标类型：从单选框读取选中值
            const checked = el.querySelector("input:checked");
            if (checked) settings.current[name] = checked.value;
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
    // 字符统计倍率：单文本框逗号分隔（ASCII,非ASCII）
    const charEl = document.getElementById("setting_char_count_ratio");
    if (charEl) {
        const parts = charEl.value.split(",").map(s => s.trim()).filter(s => s.length > 0);
        const a = parseFloat(parts[0]);
        const n = parseFloat(parts[1]);
        if (Number.isFinite(a) && a >= 0) settings.current.char_count_ascii_ratio = a;
        if (Number.isFinite(n) && n >= 0) settings.current.char_count_non_ascii_ratio = n;
        // 仅一个值时视为两项相同
        if (parts.length === 1 && Number.isFinite(a)) {
            settings.current.char_count_non_ascii_ratio = a;
        }
    }

    // LLM 反推 / 翻译提示词（可多份，属于隐藏项需单独读取）
    readAllPrompts();
}

// 填充"使用的配置"下拉框选项（值为配置名，空为默认/激活配置）
function fillConfigSelect(sel, value) {
    if (!sel) return;
    sel.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = t("settings.default_active_config");
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

// 同步更新左侧列表项的名称（编辑名称时实时生效）
function updateLlmListItemName(listEl, idx, name) {
    const item = listEl ? listEl.children[idx] : null;
    if (!item) return;
    const text = name.trim() || t("settings.unnamed");
    item.textContent = text;
    item.title = text;
}

// 当前拖拽中的 LLM 设置列表项（记录来源列表，避免跨列表误放）
let llmListDrag = null;

// 清除列表项上的拖拽插入位置提示
function clearLlmListDropHint(listEl) {
    listEl.querySelectorAll(".drop-before, .drop-after")
        .forEach(el => el.classList.remove("drop-before", "drop-after"));
}

// 渲染左侧列表（配置 / 功能共用）：条目用于跳转到右侧卡片，拖动可调整顺序
// onReorder(from, to) 中 to 为插入位置；selectedIdx 指定默认高亮项
function renderLlmSettingsList(listEl, items, onSelect, onReorder, selectedIdx = 0) {
    if (!listEl) return;
    listEl.innerHTML = "";
    items.forEach((item, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "llm-settings-item";
        btn.textContent = (item.name || "").trim() || t("settings.unnamed");
        btn.title = onReorder ? `${btn.textContent}（${t("settings.drag_sort_hint")}）` : btn.textContent;
        btn.addEventListener("click", () => onSelect(idx));

        if (onReorder) {
            btn.draggable = true;
            btn.addEventListener("dragstart", (e) => {
                llmListDrag = { listEl, from: idx };
                btn.classList.add("dragging");
                e.dataTransfer.effectAllowed = "move";
                // Firefox 需要设置数据才会触发拖拽
                e.dataTransfer.setData("text/plain", String(idx));
            });
            btn.addEventListener("dragend", () => {
                btn.classList.remove("dragging");
                clearLlmListDropHint(listEl);
                llmListDrag = null;
            });
            btn.addEventListener("dragover", (e) => {
                if (!llmListDrag || llmListDrag.listEl !== listEl) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = btn.getBoundingClientRect();
                const after = e.clientY >= rect.top + rect.height / 2;
                clearLlmListDropHint(listEl);
                btn.classList.add(after ? "drop-after" : "drop-before");
            });
            btn.addEventListener("dragleave", () => {
                btn.classList.remove("drop-before", "drop-after");
            });
            btn.addEventListener("drop", (e) => {
                if (!llmListDrag || llmListDrag.listEl !== listEl) return;
                e.preventDefault();
                const rect = btn.getBoundingClientRect();
                const after = e.clientY >= rect.top + rect.height / 2;
                clearLlmListDropHint(listEl);
                const from = llmListDrag.from;
                llmListDrag = null;
                onReorder(from, idx + (after ? 1 : 0));
            });
        }

        listEl.appendChild(btn);
    });
    // 默认高亮指定项（跳转或排序后跟随对应卡片）
    const selected = listEl.children[selectedIdx] || listEl.firstElementChild;
    if (selected) selected.classList.add("selected");
}

// 左侧列表点击：滚动到右侧对应卡片并短暂高亮（其余卡片保持显示）
function jumpToLlmCard(listEl, boxEl, idx) {
    if (!boxEl) return;
    if (listEl) {
        listEl.querySelectorAll(".llm-settings-item.selected").forEach(el => el.classList.remove("selected"));
        const item = listEl.children[idx];
        if (item) item.classList.add("selected");
    }
    const card = boxEl.querySelector(`.llm-card[data-idx="${idx}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "start", behavior: "smooth" });
    card.classList.add("flash");
    clearTimeout(card._flashTimer);
    card._flashTimer = setTimeout(() => card.classList.remove("flash"), 900);
}

// 在数组中移动一项：to 为插入位置，返回移动后的下标（未发生移动返回 -1）
function moveArrayItem(arr, from, to) {
    if (from < 0 || from >= arr.length) return -1;
    let target = to;
    if (from < to) target -= 1;
    if (target === from || target < 0 || target >= arr.length) return -1;
    const [moved] = arr.splice(from, 1);
    arr.splice(target, 0, moved);
    return target;
}

// 拖拽调整 LLM 配置顺序：先回写表单，再移动数组并重建配置 / 功能界面
function reorderLlmConfigs(from, to) {
    readAllLlmConfigs();
    readAllLlmFunctions();
    const configs = getSetting("llm_configs") || [];
    const target = moveArrayItem(configs, from, to);
    if (target < 0) return;
    setSetting("llm_configs", configs);
    buildLlmConfigs(target);
    // 配置的顺序会影响"使用的配置"下拉框，功能卡片与提示词下拉同步重建
    buildLlmFunctions();
    refreshPromptConfigSelects();
}

// 拖拽调整 LLM 功能顺序：先回写表单，再移动数组并重建功能界面与编辑区按钮
function reorderLlmFunctions(from, to) {
    readAllLlmFunctions();
    const fns = getSetting("llm_functions") || [];
    const target = moveArrayItem(fns, from, to);
    if (target < 0) return;
    setSetting("llm_functions", fns);
    buildLlmFunctions(target);
    buildLlmFunctionButtons();
}

// 把右侧所有 LLM 配置卡片写回 settings 内存（保存 / 增删前调用）
function readAllLlmConfigs() {
    const box = document.getElementById("llm-configs-box");
    if (!box) return;
    const configs = getSetting("llm_configs") || [];
    const renameMap = new Map();  // 旧名称 -> 新名称
    box.querySelectorAll(".llm-card").forEach(card => {
        const idx = Number(card.dataset.idx);
        const old = configs[idx];
        if (!old) return;
        // 保留配置中未在表单里出现的字段
        const cfg = { ...LLM_CONFIG_DEFAULT, ...old };
        cfg.name = card.querySelector(".lc-name").value.trim();
        cfg.api_url = card.querySelector(".lc-api-url").value.trim();
        cfg.api_key = card.querySelector(".lc-api-key").value;
        cfg.model = card.querySelector(".lc-model").value.trim();
        cfg.extra_params = card.querySelector(".lc-extra-params").value;
        cfg.max_image_resolution = parseInt(card.querySelector(".lc-max-res").value, 10) || 0;
        if (old.name && cfg.name && old.name !== cfg.name) renameMap.set(old.name, cfg.name);
        configs[idx] = cfg;
    });
    setSetting("llm_configs", configs);
    // 名称变更时同步引用该配置的地方，避免下拉框失效
    if (renameMap.size) {
        applyConfigRenames(renameMap);
        refreshPromptConfigSelects(renameMap);
    }
    // 勾选"使用"的卡片即激活配置
    const checked = box.querySelector(".llm-active input:checked");
    if (checked) {
        const card = checked.closest(".llm-card");
        const name = card ? card.querySelector(".lc-name").value.trim() : "";
        if (name) setSetting("llm_active_config", name);
    }
}

// 配置重命名后同步激活配置、提示词以及各 LLM 功能引用的配置名
function applyConfigRenames(renameMap) {
    const remap = (name) => (name && renameMap.has(name)) ? renameMap.get(name) : name;
    setSetting("llm_active_config", remap(getSetting("llm_active_config") || ""));
    // 提示词与功能里的 config 是同一批对象的字段，原地改写即可
    for (const kind of Object.keys(PROMPT_KINDS)) {
        for (const p of getSetting(PROMPT_KINDS[kind].listKey) || []) p.config = remap(p.config || "");
    }
    for (const fn of getSetting("llm_functions") || []) fn.config = remap(fn.config || "");
    // 同步已渲染的功能卡片下拉框，保留各功能的当前选择
    document.querySelectorAll("#llm-functions-box .llm-fn-config").forEach(sel => {
        fillConfigSelect(sel, remap(sel.value));
    });
}

// 清除对某个已删除配置的引用（空值表示使用激活配置）
function clearConfigRefs(name) {
    for (const kind of Object.keys(PROMPT_KINDS)) {
        for (const p of getSetting(PROMPT_KINDS[kind].listKey) || []) {
            if (p.config === name) p.config = "";
        }
    }
    for (const fn of getSetting("llm_functions") || []) {
        if (fn.config === name) fn.config = "";
    }
}

// 把右侧所有 LLM 功能卡片写回 settings 内存（保存 / 增删前调用）
function readAllLlmFunctions() {
    const box = document.getElementById("llm-functions-box");
    if (!box) return;
    const fns = getSetting("llm_functions") || [];
    box.querySelectorAll(".llm-card").forEach(card => {
        const idx = Number(card.dataset.idx);
        const old = fns[idx];
        if (!old) return;
        // 保留功能中未在表单里出现的字段
        const fn = { ...LLM_FN_DEFAULT, ...old };
        fn.name = card.querySelector(".lf-name").value.trim();
        fn.system_prompt = card.querySelector(".lf-system-prompt").value;
        fn.user_prompt = card.querySelector(".lf-user-prompt").value;
        fn.send_image = card.querySelector(".lf-send-image").checked;
        fn.send_caption = card.querySelector(".lf-send-caption").checked;
        fn.enabled = card.querySelector(".lf-enabled").checked;
        fn.config = card.querySelector(".llm-fn-config").value;
        fns[idx] = fn;
    });
    setSetting("llm_functions", fns);
}

// 构建 LLM 配置管理界面：右侧一次性渲染全部配置卡片，左侧列表用于跳转定位 / 拖拽排序
function buildLlmConfigs(selectedIdx = 0) {
    const box = document.getElementById("llm-configs-box");
    const list = document.getElementById("llm-configs-list");
    if (!box) return;
    box.innerHTML = "";
    const configs = getSetting("llm_configs") || [];
    const active = getSetting("llm_active_config");

    // 左侧列表：点击跳转到对应卡片（其余卡片保持显示），拖动调整配置顺序
    renderLlmSettingsList(
        list, configs,
        (idx) => jumpToLlmCard(list, box, idx),
        (from, to) => reorderLlmConfigs(from, to),
        selectedIdx
    );

    configs.forEach((cfg, idx) => box.appendChild(buildLlmConfigCard(cfg, idx, active, list)));
}

// 构建单个 LLM 配置卡片（名称 + 激活 / 复制 / 删除 + 连接信息）
function buildLlmConfigCard(cfg, idx, active, list) {
    const card = document.createElement("div");
    card.className = "llm-card";
    card.dataset.idx = idx;

    const { head, nameInput, actions } = buildCardHead("settings.config_name", "lc-name", cfg.name, idx, list);
    card.appendChild(head);

    // 激活配置：勾选后立即更新（保存时也会再同步一次）
    const activeRadio = document.createElement("input");
    activeRadio.type = "radio";
    activeRadio.name = "llm_active";
    activeRadio.checked = cfg.name === active;
    activeRadio.addEventListener("change", () => {
        const name = nameInput.value.trim();
        if (name) setSetting("llm_active_config", name);
    });
    const activeSpan = document.createElement("span");
    activeSpan.textContent = t("settings.use_this");
    const activeLabel = document.createElement("label");
    activeLabel.className = "checkbox llm-active";
    activeLabel.append(activeRadio, activeSpan);
    actions.appendChild(activeLabel);

    // 复制配置：先把所有卡片写回内存，再以最新内容创建副本
    actions.appendChild(makeCardBtn(t("settings.copy"), "btn llm-copy-btn", () => {
        readAllLlmConfigs();
        readAllLlmFunctions();
        const cur = getSetting("llm_configs") || [];
        const src = cur[idx];
        if (!src) return;
        cur.splice(idx + 1, 0, { ...src, name: (src.name || t("settings.unnamed")) + " " + t("settings.copy_suffix") });
        setSetting("llm_configs", cur);
        buildLlmConfigs();
        // 功能页与提示词的"使用的配置"下拉框同步出现新配置
        buildLlmFunctions();
        refreshPromptConfigSelects();
        jumpToLlmCard(document.getElementById("llm-configs-list"), document.getElementById("llm-configs-box"), idx + 1);
    }));

    // 删除配置：确认后按名称定位（重新渲染后下标可能变化）
    actions.appendChild(makeCardBtn(t("common.delete"), "btn danger llm-del-btn", async () => {
        if ((getSetting("llm_configs") || []).length <= 1) {
            showToast(t("settings.min_one_config"), "error");
            return;
        }
        if (!await confirmDelete("settings.delete_config_title", "settings.delete_config_msg",
            nameInput.value.trim() || cfg.name)) return;
        readAllLlmConfigs();
        readAllLlmFunctions();
        const cur = getSetting("llm_configs") || [];
        const realIdx = cur.findIndex(c => c.name === nameInput.value.trim());
        if (realIdx < 0) return;
        const [removed] = cur.splice(realIdx, 1);
        setSetting("llm_configs", cur);
        if (getSetting("llm_active_config") === removed.name) {
            setSetting("llm_active_config", cur[0] ? cur[0].name : "");
        }
        clearConfigRefs(removed.name);
        buildLlmConfigs();
        // 功能页与通用页的"使用的配置"下拉框同步移除已删除配置
        buildLlmFunctions();
        refreshPromptConfigSelects();
    }));

    // 连接信息
    const row1 = document.createElement("div");
    row1.className = "llm-card-row";
    const apiUrlField = makeField(t("settings.api_url"), "text", "lc-api-url", cfg.api_url);
    // 提示可直接填写 base url，请求时会自动补全 /chat/completions
    apiUrlField.querySelector("input").placeholder = t("settings.api_url_hint");
    row1.appendChild(apiUrlField);
    row1.appendChild(makeSecretField(t("settings.api_key"), "lc-api-key", cfg.api_key));
    card.appendChild(row1);

    // 模型与图像参数
    const row2 = document.createElement("div");
    row2.className = "llm-card-row";
    row2.appendChild(makeModelField(card, cfg));
    row2.appendChild(makeNumField(t("settings.max_image_resolution"), "lc-max-res", cfg.max_image_resolution, 1));
    card.appendChild(row2);

    // 自定义请求参数（每行一个 key: value）
    const paramsField = makeAreaField(t("settings.extra_params"), "lc-extra-params", cfg.extra_params);
    paramsField.querySelector("textarea").placeholder = "temperature: 0.5\nmax_tokens: 512";
    card.appendChild(paramsField);

    return card;
}

// 读取所有 LLM 配置卡片并回写 settings（保存设置时调用）
function readLlmConfigs() {
    readAllLlmConfigs();
    const configs = getSetting("llm_configs") || [];
    let active = getSetting("llm_active_config");
    // 激活配置必须存在，否则回退到第一个
    if (!active || !configs.some(c => c.name === active)) {
        active = configs[0] ? configs[0].name : "";
    }
    setSetting("llm_active_config", active);
}

// 构建 LLM 自定义功能管理界面：右侧一次性渲染全部功能卡片，左侧列表用于跳转定位 / 拖拽排序
function buildLlmFunctions(selectedIdx = 0) {
    const box = document.getElementById("llm-functions-box");
    const list = document.getElementById("llm-functions-list");
    if (!box) return;
    box.innerHTML = "";
    const fns = getSetting("llm_functions") || [];

    // 左侧列表：点击跳转到对应卡片（其余卡片保持显示），拖动调整功能顺序
    renderLlmSettingsList(
        list, fns,
        (idx) => jumpToLlmCard(list, box, idx),
        (from, to) => reorderLlmFunctions(from, to),
        selectedIdx
    );

    fns.forEach((fn, idx) => box.appendChild(buildLlmFunctionCard(fn, idx, list)));
}

// 构建单个 LLM 功能卡片（名称 + 启用 / 复制 / 删除 + 使用的配置 / 提示词 / 发送选项）
function buildLlmFunctionCard(fn, idx, list) {
    const card = document.createElement("div");
    card.className = "llm-card";
    card.dataset.idx = idx;

    const { head, nameInput, actions } = buildCardHead("settings.fn_name", "lf-name", fn.name, idx, list);
    card.appendChild(head);

    // 操作行：启用复选框 + 复制 + 删除
    actions.appendChild(makeCheckbox(t("settings.enabled"), "lf-enabled", fn.enabled !== false));
    actions.appendChild(makeCardBtn(t("settings.copy"), "btn llm-copy-btn", () => {
        readAllLlmFunctions();
        const cur = getSetting("llm_functions") || [];
        const src = cur[idx];
        if (!src) return;
        cur.splice(idx + 1, 0, { ...src, name: (src.name || t("settings.unnamed")) + " " + t("settings.copy_suffix") });
        setSetting("llm_functions", cur);
        buildLlmFunctions();
        jumpToLlmCard(document.getElementById("llm-functions-list"), document.getElementById("llm-functions-box"), idx + 1);
    }));
    actions.appendChild(makeCardBtn(t("common.delete"), "btn danger llm-del-btn", async () => {
        const name = nameInput.value.trim() || t("settings.unnamed");
        if (!await confirmDelete("settings.delete_function_title", "settings.delete_function_msg", name)) return;
        // 先把所有卡片写回内存，再按名称定位删除（避免下标错位）
        readAllLlmFunctions();
        const cur = getSetting("llm_functions") || [];
        const realIdx = cur.findIndex(f => f.name === name);
        if (realIdx < 0) return;
        cur.splice(realIdx, 1);
        setSetting("llm_functions", cur);
        buildLlmFunctions();
    }));

    // 使用的配置
    const cfgRow = document.createElement("div");
    cfgRow.className = "llm-card-row";
    const cfgLabel = document.createElement("label");
    cfgLabel.className = "field-label llm-inline-label";
    cfgLabel.textContent = t("settings.used_config");
    const cfgSelect = document.createElement("select");
    cfgSelect.className = "llm-fn-config";
    fillConfigSelect(cfgSelect, fn.config);
    cfgRow.append(cfgLabel, cfgSelect);
    card.appendChild(cfgRow);

    // 系统提示 / 用户提示
    card.appendChild(makeAreaField(t("settings.system_prompt"), "lf-system-prompt", fn.system_prompt));
    card.appendChild(makeAreaField(t("settings.user_prompt"), "lf-user-prompt", fn.user_prompt));

    // 复选框：发送图像 / 发送编辑框内容
    const checks = document.createElement("div");
    checks.className = "row";
    checks.appendChild(makeCheckbox(t("settings.send_image"), "lf-send-image", fn.send_image));
    checks.appendChild(makeCheckbox(t("settings.send_caption"), "lf-send-caption", fn.send_caption));
    card.appendChild(checks);

    return card;
}

// 读取所有 LLM 功能卡片（保存设置时调用；名称为空的功能会被丢弃）
function readLlmFunctions() {
    readAllLlmFunctions();
    const fns = (getSetting("llm_functions") || []).filter(fn => fn.name);
    setSetting("llm_functions", fns);
}

// ================================================================
// LLM 卡片字段辅助
// ================================================================

// 眼睛图标（SVG），用于 API Key 明文/密文切换
const EYE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/><path class="llm-eye-slash" d="M3 3l18 18"/></svg>`;

// 生成带"显示/隐藏"眼睛按钮的密码字段（用于 API Key）
function makeSecretField(labelText, cls, value) {
    const wrap = makeField(labelText, "password", cls, value);
    const input = wrap.querySelector("input");
    const holder = document.createElement("div");
    holder.className = "llm-input-wrap";

    const eyeBtn = document.createElement("button");
    eyeBtn.type = "button";
    eyeBtn.className = "llm-eye-btn";
    eyeBtn.title = t("settings.show_api_key");
    eyeBtn.innerHTML = EYE_ICON;
    eyeBtn.addEventListener("click", () => {
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        eyeBtn.classList.toggle("active", show);
        eyeBtn.title = t(show ? "settings.hide_api_key" : "settings.show_api_key");
    });

    holder.appendChild(input);
    holder.appendChild(eyeBtn);
    wrap.appendChild(holder);
    return wrap;
}

// 查询到的模型列表缓存：key 为模型接口地址 + Key，重建卡片时仍可保留下拉列表
const llmModelCache = new Map();

// 当前展开的模型列表下拉（全局只保留一个）
let openModelMenuEl = null;

// 关闭模型列表下拉
function closeModelMenu() {
    if (openModelMenuEl) openModelMenuEl.classList.add("hidden");
    openModelMenuEl = null;
}

// 打开模型列表下拉
function openModelMenu(menu) {
    closeModelMenu();
    menu.classList.remove("hidden");
    openModelMenuEl = menu;
}

// 点击其它区域时关闭模型列表下拉（全局只需绑定一次）
document.addEventListener("click", (e) => {
    if (!openModelMenuEl) return;
    if (e.target.closest(".llm-model-input-wrap")) return;
    closeModelMenu();
});

// 模型列表缓存的 key（与实际查询使用的接口地址和 Key 保持一致）
function modelCacheKey(card) {
    const apiUrl = card.querySelector(".lc-api-url")?.value.trim() || "";
    const apiKey = card.querySelector(".lc-api-key")?.value || "";
    return `${llm.toModelsUrl(apiUrl)}\n${apiKey}`;
}

// 渲染模型列表下拉菜单；点击条目回填模型名
function renderModelMenu(menu, input, models) {
    menu.innerHTML = "";
    for (const id of models) {
        const item = document.createElement("div");
        item.className = "dir-history-item";
        const name = document.createElement("span");
        name.className = "dir-history-path";
        name.textContent = id;
        item.appendChild(name);
        item.addEventListener("click", () => {
            input.value = id;
            closeModelMenu();
        });
        menu.appendChild(item);
    }
}

// 生成"模型名"字段：可自定义的文本框 + 查询模型按钮 + 模型列表下拉；
// 下拉样式复用数据集目录历史（#btn_dir_history）的做法。
function makeModelField(card, cfg) {
    const wrap = document.createElement("div");
    wrap.className = "field llm-field";

    const head = document.createElement("div");
    head.className = "llm-model-head";
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = t("settings.model_name");
    const queryBtn = document.createElement("button");
    queryBtn.type = "button";
    queryBtn.className = "btn llm-model-query-btn";
    queryBtn.textContent = t("settings.query_models");
    queryBtn.title = t("settings.query_models_hint");
    head.appendChild(label);
    head.appendChild(queryBtn);

    const inputWrap = document.createElement("div");
    inputWrap.className = "dir-input-wrap llm-model-input-wrap";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "lc-model";
    input.value = cfg.model ?? "";
    input.autocomplete = "off";

    // 下拉按钮 + 模型列表菜单（结构与数据集目录历史一致）
    const dropBtn = document.createElement("button");
    dropBtn.type = "button";
    dropBtn.className = "dir-drop-btn";
    dropBtn.title = t("settings.show_models");
    dropBtn.textContent = "▼";
    const menu = document.createElement("div");
    menu.className = "dir-dropdown hidden";

    // 按当前接口地址与 Key 取缓存中的模型列表
    const getModels = () => llmModelCache.get(modelCacheKey(card)) || [];

    // 只有查询过（缓存中有模型）时才显示下拉箭头
    const updateDropBtnVisibility = () => {
        const hasModels = getModels().length > 0;
        dropBtn.classList.toggle("hidden", !hasModels);
        if (!hasModels) closeModelMenu();
    };
    updateDropBtnVisibility();
    // 接口地址或 Key 变化后，按新的缓存 key 重新判断是否显示
    card.querySelector(".lc-api-url").addEventListener("input", updateDropBtnVisibility);
    card.querySelector(".lc-api-key").addEventListener("input", updateDropBtnVisibility);

    dropBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menu.classList.contains("hidden")) {
            renderModelMenu(menu, input, getModels());
            openModelMenu(menu);
        } else {
            closeModelMenu();
        }
    });

    // 与数据集目录历史一致：点击输入框展开列表，输入时关闭
    input.addEventListener("click", (e) => {
        const models = getModels();
        if (!models.length) return;
        e.stopPropagation();
        renderModelMenu(menu, input, models);
        openModelMenu(menu);
    });
    input.addEventListener("input", closeModelMenu);

    queryBtn.addEventListener("click", () => queryModels(card, queryBtn, input, menu, updateDropBtnVisibility));

    inputWrap.appendChild(input);
    inputWrap.appendChild(dropBtn);
    inputWrap.appendChild(menu);
    wrap.appendChild(head);
    wrap.appendChild(inputWrap);
    return wrap;
}

// 查询服务端模型列表并填充下拉菜单（使用卡片中当前的 API 地址与 Key）
async function queryModels(card, btn, input, menu, updateDropBtnVisibility) {
    const apiUrl = card.querySelector(".lc-api-url")?.value.trim() || "";
    const apiKey = card.querySelector(".lc-api-key")?.value || "";
    if (!apiUrl) {
        showToast(t("settings.api_url_required"), "error");
        return;
    }
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("settings.querying_models");
    try {
        const ids = await llm.fetchModelIds({ api_url: apiUrl, api_key: apiKey });
        if (!ids.length) {
            showToast(t("settings.models_empty"), "error");
            return;
        }
        // 缓存查询结果并渲染下拉菜单，模型名仍可自由编辑
        llmModelCache.set(modelCacheKey(card), ids);
        updateDropBtnVisibility();
        renderModelMenu(menu, input, ids);
        openModelMenu(menu);
    } catch (e) {
        showToast(t("settings.query_models_failed").replace("{msg}", e?.message || String(e)), "error");
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}

// 标签在上、控件在下的字段容器
function makeLabeledField(labelText, control, extraCls = "") {
    const wrap = document.createElement("div");
    wrap.className = extraCls ? `field ${extraCls}` : "field";
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = labelText;
    wrap.append(label, control);
    return wrap;
}

// 生成一个输入字段（label + input），用于 LLM 卡片
function makeField(labelText, type, cls, value) {
    const input = document.createElement("input");
    input.type = type;
    input.className = cls;
    input.value = value ?? "";
    return makeLabeledField(labelText, input, "llm-field");
}

// 生成一个数字输入字段
function makeNumField(labelText, cls, value, step) {
    const wrap = makeField(labelText, "number", cls, value);
    const input = wrap.querySelector("input");
    input.step = step;
    input.min = 0;
    return wrap;
}

// 生成一个文本域字段（label + textarea）
function makeAreaField(labelText, cls, value, rows = 3) {
    const area = document.createElement("textarea");
    area.className = cls;
    area.rows = rows;
    area.value = value ?? "";
    return makeLabeledField(labelText, area);
}

// 生成一个复选框
function makeCheckbox(labelText, cls, checked) {
    const label = document.createElement("label");
    label.className = "checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = cls;
    input.checked = !!checked;
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(input, span);
    return label;
}

// 卡片标题行：名称字段（占满剩余宽度）+ 右侧操作区
// 返回 { head, nameInput, actions }，由调用方补充各自的按钮
function buildCardHead(labelKey, inputCls, value, idx, list) {
    const head = document.createElement("div");
    head.className = "llm-card-head";

    const input = document.createElement("input");
    input.type = "text";
    input.className = inputCls;
    input.value = value || "";
    // 输入名称时同步左侧列表，避免切换后名称不一致
    input.addEventListener("input", () => updateLlmListItemName(list, idx, input.value));
    const nameField = makeLabeledField(t(labelKey), input, "llm-name-field");

    const actions = document.createElement("div");
    actions.className = "llm-card-actions";
    head.append(nameField, actions);
    return { head, nameInput: input, actions };
}

// 卡片上的操作按钮（复制 / 删除等）
function makeCardBtn(labelText, cls, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = labelText;
    btn.addEventListener("click", onClick);
    return btn;
}

// 删除确认对话框：用户确认删除时返回 true
async function confirmDelete(titleKey, msgKey, name) {
    const key = await showConfirmDialog(
        t(titleKey),
        t(msgKey).replace("{name}", name || ""),
        [
            { key: "delete", label: t("common.delete"), cls: "danger" },
            { key: "cancel", label: t("common.cancel"), cls: "primary" },
        ]
    );
    return key === "delete";
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
    // 浮窗模板实例化：先建出 6 个浮窗 DOM，后续各 init 再绑定行为
    initPopups();
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
    initLlmHistory();
    initRename();
    initTopbar();
    initSettings();
    initSplitters();
    initHighlightRuleEditor();
    initGallerySort();
    initPreviewNav();
    initPreviewBgToggle();
    initPreviewReadme();
    initPreviewZoom();
    initGalleryContextMenu();
    initActionsContextMenu();
    initExtraTools();
    // 边界框：初始化画布并注入写回回调（拖拽结束后更新编辑框文本）
    initBbox();
    // 分桶裁剪预览：初始化画布与控件（OneTrainer 等面积分桶策略演示）
    initCropPreview();
    // 裁剪预览开关/分辨率变化时，bbox 画布重新对齐到裁剪区域，并刷新状态栏比例/分辨率
    setOnCropPreviewChange(() => {
        updateBboxes();
        refreshSelectedImageResolution();
    });
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
    // config 中的编辑模式可能重新启用胶囊模式，最后再按设置应用模式按钮的显示状态
    applyActionsRowVisibility();
}
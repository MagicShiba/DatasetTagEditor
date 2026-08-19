// capsule.js - 胶囊式标签编辑（可视化标签编辑方式，替代文本编辑框）
//
// 依据当前分隔符规则将文本拆分为一个个胶囊标签：
//   - 每个胶囊末尾有 ✕ 可删除
//   - 拖动胶囊可重新排序
//   - 两个标签之间（及首尾）有 "+" 插入点，点击后输入新标签
// 编辑结果始终写回编辑框 dte_edit_caption.value，因此"应用更改/保存"等逻辑无需改动。

import { splitCaptionWithSepts, getTagSeparators, isJsonBlock, formatJsonPretty } from "./utils.js";
import { joinTagsWithSepts } from "./dataset.js";
import { t } from "./i18n.js";
import { bindAutocomplete } from "./autocomplete.js";

// 当前是否启用胶囊编辑模式（默认关闭，使用文本编辑）
let active = false;
// 当前标签列表：[{tag, sep}]，sep 为该标签之后的间隔文本（末位为末尾文本，如句号）
let chips = [];
// 内容变化回调（由 ui.js 注入：标记未保存 + 刷新高亮层与边界框）
let onChange = null;
// 正在拖拽的标签下标（-1 表示无）
let dragFrom = -1;

const ta = () => document.getElementById("dte_edit_caption");
const box = () => document.getElementById("dte_capsule_editor");
const cb = () => document.getElementById("cb_use_capsule_editor");
const wrap = () => document.getElementById("dte_caption_textarea_wrap");
const modeBtn = () => document.getElementById("btn_toggle_mode");
const modeCapsuleIcon = () => document.getElementById("mode_icon_capsule");
const modeTextIcon = () => document.getElementById("mode_icon_text");

// 当前是否处于胶囊编辑模式
export function isCapsuleActive() {
    return active;
}

// 注入内容变化回调（编辑后标记未保存并刷新相关视图）
export function setOnChange(cb) {
    onChange = cb;
}

// 初始化：绑定图标切换按钮与隐藏的启用复选框
export function init() {
    const btn = modeBtn();
    if (btn) btn.addEventListener("click", () => setEnabled(!isCapsuleActive()));
    // 兼容旧逻辑：隐藏复选框状态变化同样生效（配置读取仍依赖它）
    cb().addEventListener("change", () => setEnabled(cb().checked));
    // 默认使用文本编辑形式（复选框默认未勾选）
    setEnabled(cb().checked);
}

// 启用/关闭胶囊编辑模式（同时同步复选框与图标切换按钮状态）
export function setEnabled(enabled) {
    active = !!enabled;
    if (cb()) cb().checked = active;
    syncModeButton();
    applyMode();
}

// 同步图标切换按钮：显示当前模式图标、高亮当前模式、更新提示文案
function syncModeButton() {
    const btn = modeBtn();
    const capIcon = modeCapsuleIcon();
    const txtIcon = modeTextIcon();
    if (btn) {
        btn.classList.toggle("active", active);
        btn.title = t(active ? "edit_caption.capsule_mode" : "edit_caption.text_mode");
        btn.dataset.i18nTitle = active ? "edit_caption.capsule_mode" : "edit_caption.text_mode";
    }
    if (capIcon) capIcon.classList.toggle("hidden", !active);
    if (txtIcon) txtIcon.classList.toggle("hidden", active);
}

// 应用当前模式：显示/隐藏文本编辑框与胶囊编辑区
function applyMode() {
    if (!box() || !wrap()) return;
    box().classList.toggle("hidden", !active);
    wrap().classList.toggle("hidden", active);
    if (active) render();
}

// 外部内容变化（切换图像、LLM 追加、替换标点等）时重新从编辑框同步
export function refresh() {
    if (!active) return;
    render();
}

// 从编辑框文本按分隔符规则拆分并渲染
function render() {
    const { tags, septs } = splitCaptionWithSepts(ta().value);
    chips = tags.map((tag, i) => ({ tag, sep: septs[i] || "" }));
    renderChips();
}

// 依据当前 chips 重建胶囊 DOM
function renderChips() {
    box().innerHTML = "";
    if (chips.length === 0) {
        // 空状态：提示 + 提供添加第一个标签的入口
        const empty = document.createElement("span");
        empty.className = "capsule-empty";
        empty.textContent = t("edit_caption.capsule_empty");
        box().appendChild(empty);
        box().appendChild(createInsert(0));
        return;
    }
    chips.forEach((chip, i) => {
        // 标签与其后的 "+" 组成不可分单元：换行时 "+" 不会单独占一行
        const unit = document.createElement("span");
        unit.className = "capsule-unit";
        unit.appendChild(createChip(chip, i));
        unit.appendChild(createInsert(i + 1));
        box().appendChild(unit);
    });
}

// 创建插入点 "+" 按钮（data-pos 为插入位置，同时也是拖放目标）
function createInsert(pos) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "capsule-insert";
    el.dataset.pos = String(pos);
    el.textContent = "✚";
    el.title = t("edit_caption.capsule_add");
    el.addEventListener("click", () => openAddInput(pos));
    // 拖放：将拖动的标签插入到此位置
    el.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        el.classList.add("capsule-drop-hover");
    });
    el.addEventListener("dragleave", () => el.classList.remove("capsule-drop-hover"));
    el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("capsule-drop-hover");
        moveChip(dragFrom, pos);
    });
    return el;
}

// 创建单个胶囊标签（可拖动、带 ✕ 删除）
function createChip(chip, idx) {
    const el = document.createElement("span");
    el.className = "capsule-chip";
    el.draggable = true;
    el.dataset.pos = String(idx);

    const tag = document.createElement("span");
    tag.className = "capsule-tag";
    tag.textContent = chip.tag;
    // 点击标签文本进入编辑状态
    tag.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditChip(idx);
    });
    el.appendChild(tag);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "capsule-x";
    del.textContent = "✕";
    del.title = t("edit_caption.capsule_remove");
    del.addEventListener("click", () => deleteChip(idx));
    el.appendChild(del);

    // 拖拽排序
    el.addEventListener("dragstart", (e) => {
        dragFrom = idx;
        el.classList.add("capsule-dragging");
        e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => {
        el.classList.remove("capsule-dragging");
        clearDropHover();
        dragFrom = -1;
    });
    // 拖放到标签上时插入到该标签之前
    el.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        el.classList.add("capsule-drop-hover");
    });
    el.addEventListener("dragleave", () => el.classList.remove("capsule-drop-hover"));
    el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("capsule-drop-hover");
        moveChip(dragFrom, idx);
    });

    return el;
}

// 让输入框宽度自适应文本长度（canvas 测量，最小 140px，不超过容器宽度）；
// 多行输入框（textarea）高度随内容自动增长
function fitInputWidth(input) {
    const text = input.value || input.placeholder || "";
    const ctx = (fitInputWidth._canvas || (fitInputWidth._canvas = document.createElement("canvas"))).getContext("2d");
    ctx.font = getComputedStyle(input).font || "13px system-ui, sans-serif";
    const textW = ctx.measureText(text).width;
    const maxW = (box().clientWidth || 400) - 30;
    input.style.width = Math.max(140, Math.min(Math.ceil(textW) + 28, maxW)) + "px";
    if (input.tagName === "TEXTAREA") {
        input.style.height = "auto";
        input.style.height = input.scrollHeight + "px";
    }
}

// 在 pos 处打开添加标签输入框
function openAddInput(pos) {
    // 关闭可能存在的其它输入框
    box().querySelectorAll(".capsule-input").forEach(el => el.remove());
    const input = document.createElement("input");
    input.type = "text";
    input.className = "capsule-input";
    input.dataset.pos = String(pos);
    input.placeholder = t("edit_caption.capsule_placeholder");
    // 替换该位置的插入点按钮
    const insert = box().querySelector(`.capsule-insert[data-pos="${pos}"]`);
    if (insert) insert.replaceWith(input);
    // 单值标签输入自动补全（选中候选项不追加逗号）
    bindAutocomplete(input, { appendComma: false });
    input.focus();
    fitInputWidth(input);
    input.addEventListener("input", () => fitInputWidth(input));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            addChip(pos, input.value);
        } else if (e.key === "Escape") {
            renderChips();
        }
    });
    // 失焦时自动保存，避免未回车提交的文本丢失；
    // 元素被 DOM 移除（删除胶囊/拖拽等）触发的 blur 不保存，避免误操作
    input.addEventListener("blur", () => { if (input.isConnected) addChip(pos, input.value); });
}

// 将 JSON 字符串压缩为单行；非 JSON 原样返回
function minifyJson(text) {
    try { return JSON.stringify(JSON.parse(text)); } catch (e) { return text; }
}

// 点击标签文本编辑：将标签替换为输入框，Enter 提交 / Esc 取消 / 失焦提交
function openEditChip(idx) {
    if (idx < 0 || idx >= chips.length) return;
    const chipEl = box().querySelector(`.capsule-chip[data-pos="${idx}"]`);
    if (!chipEl) return;
    const tagEl = chipEl.querySelector(".capsule-tag");
    if (!tagEl || chipEl.querySelector(".capsule-input")) return;
    // 使用多行输入框编辑标签，并禁用标签拖动，避免拖动时误触拖拽标签
    const input = document.createElement("textarea");
    input.className = "capsule-input-multi";
    input.rows = 1;
    // JSON 胶囊整体作为一个标签，编辑时以格式化形式展示便于阅读
    input.value = isJsonBlock(chips[idx].tag) ? formatJsonPretty(chips[idx].tag) : chips[idx].tag;
    input.placeholder = t("edit_caption.capsule_placeholder");
    tagEl.replaceWith(input);
    chipEl.draggable = false;
    // 修改标签时支持自动补全（单值输入，不追加逗号）
    bindAutocomplete(input, { appendComma: false });
    input.focus();
    input.select();
    fitInputWidth(input);
    input.addEventListener("input", () => fitInputWidth(input));
    let done = false;
    // 提交修改：新值为空则视为取消
    const commit = () => {
        if (done) return;
        done = true;
        const val = input.value.trim();
        if (val && val !== chips[idx].tag) {
            // JSON 编辑后保持压缩（单行）状态写回
            chips[idx].tag = isJsonBlock(val) ? minifyJson(val) : val;
            writeChips();
        } else {
            renderChips();
        }
    };
    const cancel = () => {
        if (done) return;
        done = true;
        renderChips();
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            commit();
        } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
        }
    });
    input.addEventListener("blur", () => { if (input.isConnected) commit(); });
}

// 在 pos 处添加新标签
function addChip(pos, raw) {
    const tag = (raw || "").trim();
    if (!tag) { renderChips(); return; }
    const firstSep = getTagSeparators()[0] || ",";
    if (pos >= chips.length) {
        // 追加到末尾：新标签作为末尾无间隔
        chips.push({ tag, sep: "" });
    } else {
        // 中间插入：新标签使用"第一个分隔符 + 空格"作为间隔
        chips.splice(pos, 0, { tag, sep: firstSep + " " });
    }
    normalizeSeps();
    writeChips();
}

// 删除指定位置的标签
function deleteChip(idx) {
    chips.splice(idx, 1);
    normalizeSeps();
    writeChips();
}

// 将 dragFrom 处的标签移动到 to 处（to 为插入位置）
function moveChip(from, to) {
    if (from < 0 || from >= chips.length) return;
    // 未发生实际移动（原位置或紧邻其后的插入点）
    if (to === from || to === from + 1) return;
    const moved = chips[from];
    chips.splice(from, 1);
    let target = to;
    if (from < to) target = to - 1;
    chips.splice(target, 0, moved);
    normalizeSeps();
    writeChips();
}

// 修正标签间隔：非末尾标签必须有分隔符（为空则补"分隔符+空格"）；
// 末尾标签若间隔不是句号则清除（避免出现结尾逗号等多余间隔）。
function normalizeSeps() {
    if (chips.length === 0) return;
    const firstSep = getTagSeparators()[0] || ",";
    chips.forEach((c, i) => {
        if (i < chips.length - 1 && !c.sep) c.sep = firstSep + " ";
        if (i === chips.length - 1 && c.sep && !c.sep.includes(".") && !c.sep.includes("\u3002")) c.sep = "";
    });
}

// 将当前 chips 写回编辑框并通知外部刷新状态，然后重绘
function writeChips() {
    ta().value = joinTagsWithSepts(chips.map(c => c.tag), chips.map(c => c.sep));
    if (onChange) onChange();
    renderChips();
}

// 清除所有拖放高亮
function clearDropHover() {
    box().querySelectorAll(".capsule-drop-hover").forEach(el => el.classList.remove("capsule-drop-hover"));
}
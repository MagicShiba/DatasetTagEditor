// popups.js - 浮窗内容定义与集中创建
// 骨架（标题栏/按钮/缩放把手）由 popup.js 的 createPopup 从唯一模板生成，
// 此处只定义各浮窗的标题、按钮组合与内容区 HTML，保持业务元素 id 不变，
// 原有业务代码（ui.js）无需改动元素引用。

import { createPopup } from "./popup.js";

// 6 个浮窗的内容定义：id/size/标题/按钮/内容保持与原静态 HTML 一致
const POPUP_DEFS = [
    {
        id: "llm_progress_panel", size: "list",
        titleKey: "llm_progress.title", titleText: "LLM 反推管理",
        buttons: [
            { type: "pin", id: "llm_progress_pin", titleKey: "llm_progress.pin" },
            { type: "close", id: "btn_llm_progress_close", titleKey: "llm_progress.close" },
        ],
        bodyHTML: `
            <label class="checkbox llm-progress-opt" title="如果图像已有标注内容，选择追加或覆盖">
                <input type="checkbox" id="cb_llm_reverse_append" checked>
                <span data-i18n="llm_progress.append_opt">已有标注则追加</span>
            </label>
            <div class="llm-progress-overview">
                <div class="llm-progress-bar"><div class="llm-progress-fill" id="llm_progress_fill"></div></div>
                <div class="llm-progress-summary" id="llm_progress_summary">0 / 0</div>
            </div>
            <div class="llm-progress-list" id="llm_progress_list"></div>
            <div class="llm-progress-footer">
                <button id="btn_llm_progress_cancel_all" class="btn compact danger" data-i18n="llm_progress.cancel_all">全部移除</button>
                <button id="btn_llm_progress_remove_done" class="btn compact" data-i18n="llm_progress.remove_done">移除已完成</button>
            </div>`,
    },
    {
        id: "json_check_panel", size: "list",
        titleKey: "extra_tools.title", titleText: "JSON 检查结果",
        buttons: [
            { type: "refresh", id: "json_check_refresh", titleKey: "extra_tools.refresh", title: "重新检测" },
            { type: "pin", id: "json_check_pin", titleKey: "llm_progress.pin" },
            { type: "close", id: "btn_json_check_close", titleKey: "llm_progress.close" },
        ],
        bodyHTML: `
            <div class="extra-tools-summary" id="extra_tools_summary"></div>
            <div class="llm-progress-list" id="extra_tools_json_list"></div>`,
    },
    {
        id: "newline_check_panel", size: "list",
        titleKey: "extra_tools.newline_title", titleText: "换行检查结果",
        buttons: [
            { type: "refresh", id: "newline_check_refresh", titleKey: "extra_tools.refresh", title: "重新检测" },
            { type: "pin", id: "newline_check_pin", titleKey: "llm_progress.pin" },
            { type: "close", id: "btn_newline_check_close", titleKey: "llm_progress.close" },
        ],
        bodyHTML: `
            <div class="extra-tools-summary" id="newline_tools_summary"></div>
            <div class="llm-progress-list" id="newline_tools_list"></div>`,
    },
    {
        id: "translate_popup", size: "text",
        titleKey: "translate.title", titleText: "翻译",
        buttons: [
            { type: "refresh", id: "translate_refresh", titleKey: "translate.refresh", title: "重新翻译（忽略重复检查）" },
            { type: "pin", id: "translate_pin", titleKey: "translate.pin", title: "固定（点击外部时保持显示）" },
            { type: "close", id: "translate_close", titleKey: "common.close" },
        ],
        bodyHTML: `
            <textarea id="translate_source" class="translate-source" rows="2" placeholder="原文（回车翻译）"></textarea>
            <div id="translate_output" class="translate-output"></div>`,
    },
    {
        id: "info_popup", size: "text",
        titleId: "info_popup_title", titleText: "信息",
        buttons: [
            { type: "close", id: "info_popup_close", titleKey: "common.close" },
        ],
        bodyHTML: `<div id="info_popup_content" class="highlight-help-content"></div>`,
    },
    {
        id: "highlight_rule_modal", size: "text",
        titleKey: "highlight.edit_rule", titleText: "编辑高亮规则",
        buttons: [
            { type: "pin", id: "hr_pin", titleKey: "highlight.pin" },
            { type: "close", id: "hr_close", titleKey: "common.close" },
        ],
        bodyClass: "hr-body modal-body",
        bodyHTML: `
            <div class="field">
                <label class="field-label" data-i18n="highlight.matched_tags">匹配标签</label>
                <textarea id="hr_tags" rows="2" placeholder="girl, 1girl, long hair"></textarea>
            </div>
            <div class="field hr-color-row">
                <label class="checkbox">
                    <input type="checkbox" id="hr_enable_bg">
                    <span data-i18n="highlight.bg_color">背景色</span>
                </label>
                <input type="color" id="hr_bg" value="#777700" disabled>
            </div>
            <div class="field hr-color-row">
                <label class="checkbox">
                    <input type="checkbox" id="hr_enable_fg">
                    <span data-i18n="highlight.fg_color">文字色</span>
                </label>
                <input type="color" id="hr_fg" value="#ffffff" disabled>
            </div>
            <label class="checkbox">
                <input type="checkbox" id="hr_bold">
                <span data-i18n="highlight.bold">加粗</span>
            </label>
            <label class="checkbox">
                <input type="checkbox" id="hr_partial">
                <span data-i18n="highlight.partial_match">子串匹配</span>
            </label>
            <label class="checkbox">
                <input type="checkbox" id="hr_cs">
                <span data-i18n="highlight.case_sensitive">区分大小写</span>
            </label>
            <div class="hr-preview-label" data-i18n="highlight.preview">示例预览</div>
            <div class="hr-preview">
                <div id="hr_preview" class="hr-preview-content"></div>
            </div>`,
        footerClass: "modal-actions hr-actions",
        footerHTML: `
            <button id="hr_cancel" class="btn" data-i18n="common.cancel">取消</button>
            <button id="hr_save" class="btn primary" data-i18n="common.save">保存</button>`,
    },
];

// 创建全部浮窗（幂等）。必须在 setupUI 最先调用，
// 后续各 init 再按 id 绑定行为与业务逻辑。
export function initPopups() {
    for (const def of POPUP_DEFS) createPopup(def);
}

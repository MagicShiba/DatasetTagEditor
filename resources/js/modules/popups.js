// popups.js - 浮窗内容定义与集中创建
// 骨架（标题栏/按钮/缩放把手）由 popup.js 的 createPopup 从唯一模板生成，
// 此处只定义各浮窗的标题、按钮组合与内容区 HTML，保持业务元素 id 不变，
// 原有业务代码（ui.js）无需改动元素引用。

import { createPopup } from "./popup.js";

// 各浮窗的内容定义：id/size/标题/按钮/内容保持与原静态 HTML 一致
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
        id: "llm_history_panel", size: "history",
        titleKey: "llm_history.title", titleText: "LLM 调用历史",
        buttons: [
            { type: "pin", id: "llm_history_pin", titleKey: "llm_history.pin" },
            { type: "close", id: "btn_llm_history_close", titleKey: "common.close" },
        ],
        bodyHTML: `
            <div class="llm-history">
                <div class="llm-history-list" id="llm_history_list"></div>
                <div class="llm-history-detail" id="llm_history_detail"></div>
            </div>`,
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
        id: "image_tool_popup", size: "history",
        titleKey: "image_tool.title", titleText: "图像分辨率调整",
        buttons: [
            { type: "pin", id: "it_pin", titleKey: "translate.pin" },
            { type: "close", id: "it_close", titleKey: "common.close" },
        ],
        bodyClass: "image-tool-popup-body",
        bodyHTML: `
            <div class="image-tool-workspace">
                <div class="image-tool-left">
                    <div class="image-tool-toolbar">
                        <button type="button" id="it_pick_image" data-i18n="image_tool.pick_image">选择图像</button>
                        <input type="file" id="it_file_input" accept="image/png,image/jpeg" hidden>
                        <button type="button" id="it_save_as" data-i18n="image_tool.save_as">另存为...</button>
                    </div>
                    <div id="it_preview" class="image-tool-preview">
                        <canvas id="it_canvas" class="image-tool-canvas"></canvas>
                        <canvas id="it_overlay" class="image-tool-overlay"></canvas>
                        <div id="it_no_image" class="image-tool-empty" data-i18n="image_tool.no_image">未检测到图像，请先在画廊中选择图像，或在此窗口手动选择。</div>
                    </div>
                    <div class="image-tool-footer">
                        <span id="it_source_info" class="small-note"></span>
                        <span id="it_zoom_info" class="small-note it-zoom-info"></span>
                    </div>
                </div>
                <div class="image-tool-right">
                    <div class="field">
                        <label class="field-label" data-i18n="image_tool.mode">模式</label>
                        <div class="row">
                            <button type="button" id="it_mode_scale" class="btn compact active" data-i18n="image_tool.mode_scale">缩放</button>
                            <button type="button" id="it_mode_crop" class="btn compact" data-i18n="image_tool.mode_crop">裁剪</button>
                        </div>
                    </div>
                    <div class="field">
                        <div class="it-field-head">
                            <span class="field-label" data-i18n="image_tool.size">尺寸（像素）</span>
                            <button type="button" id="it_reset" class="btn compact" data-i18n="image_tool.reset">重置</button>
                        </div>
                        <div class="image-tool-size-row">
                            <div class="it-number">
                                <span class="it-number-label">W</span>
                                <input type="number" id="it_width" min="1" max="10000" step="1" value="1">
                                <span class="it-number-preset-wrap"><select id="it_w_preset" class="it-number-preset" title="尺寸档位" aria-label="宽度档位"></select></span>
                                <span class="it-number-arrows">
                                    <button type="button" id="it_w_inc" title="+64">▲</button>
                                    <button type="button" id="it_w_dec" title="-64">▼</button>
                                </span>
                            </div>
                            <span class="it-times">×</span>
                            <div class="it-number">
                                <span class="it-number-label">H</span>
                                <input type="number" id="it_height" min="1" max="10000" step="1" value="1">
                                <span class="it-number-preset-wrap"><select id="it_h_preset" class="it-number-preset" title="尺寸档位" aria-label="高度档位"></select></span>
                                <span class="it-number-arrows">
                                    <button type="button" id="it_h_inc" title="+64">▲</button>
                                    <button type="button" id="it_h_dec" title="-64">▼</button>
                                </span>
                            </div>
                        </div>
                        <div class="image-tool-size-row image-tool-pos-row hidden" id="it_pos_field">
                            <div class="it-number">
                                <span class="it-number-label">X</span>
                                <input type="number" id="it_x" value="0">
                                <span class="it-number-arrows">
                                    <button type="button" id="it_x_inc" title="+64">▲</button>
                                    <button type="button" id="it_x_dec" title="-64">▼</button>
                                </span>
                            </div>
                            <span class="it-times">,</span>
                            <div class="it-number">
                                <span class="it-number-label">Y</span>
                                <input type="number" id="it_y" value="0">
                                <span class="it-number-arrows">
                                    <button type="button" id="it_y_inc" title="+64">▲</button>
                                    <button type="button" id="it_y_dec" title="-64">▼</button>
                                </span>
                            </div>
                        </div>
                        <label class="checkbox">
                            <input type="checkbox" id="it_lock_ratio" checked>
                            <span data-i18n="image_tool.lock_ratio">保持纵横比</span>
                        </label>
                        <div class="it-common-heading">
                            <span class="small-note" data-i18n="image_tool.common_sizes">常见尺寸</span>
                            <button type="button" id="it_swap_wh" class="it-swap-btn"
                                title="交换宽高" data-i18n-title="image_tool.swap_wh">⇄</button>
                        </div>
                        <div id="it_common_sizes" class="it-common-sizes"></div>
                    </div>
                    <div class="field" id="it_scale_options">
                        <label class="field-label" for="it_algorithm" data-i18n="image_tool.algorithm">缩放算法</label>
                        <select id="it_algorithm">
                            <option value="nearest" data-i18n="image_tool.algo_nearest">Nearest（最近邻）</option>
                            <option value="bicubic" data-i18n="image_tool.algo_bicubic">Bicubic（双三次）</option>
                            <option value="mitchell" data-i18n="image_tool.algo_mitchell">Mitchell</option>
                            <option value="lanczos" selected data-i18n="image_tool.algo_lanczos">Lanczos</option>
                            <option value="lanczos3" data-i18n="image_tool.algo_lanczos3">Lanczos3</option>
                        </select>
                    </div>
                    <div class="field">
                        <span class="field-label" data-i18n="image_tool.format">保存格式</span>
                        <div class="it-format-options">
                            <label><input type="radio" name="it_format" value="follow" checked><span data-i18n="image_tool.format_follow">跟随原图</span></label>
                            <label><input type="radio" name="it_format" value="jpg"><span data-i18n="image_tool.format_jpg">JPG（质量 100）</span></label>
                            <label><input type="radio" name="it_format" value="png"><span data-i18n="image_tool.format_png">PNG</span></label>
                        </div>
                    </div>
                    <div class="field image-tool-actions">
                        <button type="button" id="it_save" class="btn primary" data-i18n="image_tool.save_apply">保存并应用</button>
                    </div>
                    <div id="it_crop_hint" class="small-note hidden" data-i18n="image_tool.crop_hint">拖动边界调整裁剪框；滚轮微调并缩放预览。</div>
                </div>
            </div>`,
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

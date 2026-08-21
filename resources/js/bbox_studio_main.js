// bbox_studio_main.js - 独立窗口入口（新应用程序级窗口）

import { initStudio, updateBboxesFromText } from "./modules/bboxStudio.js";
import { initApp } from "./modules/app.js";
import { applyI18n } from "./modules/i18n.js";
import { config } from "./modules/config.js";
import { loadAutocompleteData } from "./modules/autocomplete.js";
import { parseRules, applyHighlight } from "./modules/highlight.js";

async function start() {
    try {
        if (typeof Neutralino !== "undefined" && Neutralino.init) {
            try { await Neutralino.init(); } catch (e) { console.warn("Neutralino init failed", e); }
        }
        // 复用主应用的初始化（设置、配置、缩略图等），但不依赖画廊
        try { await initApp(); } catch (e) { console.warn("initApp failed", e); }
        try { await applyI18n(); } catch (e) {}

        // 加载高亮规则到独立窗口的 textarea（与主窗口保持一致）
        try {
            const hl = config.read("edit_selected")?.highlight_rules || "";
            const ta = document.getElementById("tb_highlight_rules");
            if (ta) ta.value = hl;
            // 监听变更写回配置（可选，不强制保存）
            if (ta) ta.addEventListener("input", () => {
                const cur = config.read("edit_selected") || {};
                cur.highlight_rules = ta.value;
                config.write(cur, "edit_selected");
            });
        } catch (e) {}

        // 加载自动补全数据
        try { await loadAutocompleteData("/data/autocomplete.txt"); } catch (e) {}

        // 初始化画板（画布、比例、背景、文本等）
        initStudio();

        // 同步高亮：独立窗口内文本与高亮规则联动
        const textEl = document.getElementById("bbox_studio_text");
        const ruleEl = document.getElementById("tb_highlight_rules");
        if (ruleEl && textEl) {
            ruleEl.addEventListener("input", () => {
                // bboxStudio 内部已监听 tb_highlight_rules，此次仅为触发重绘
                const overlay = document.getElementById("bbox_studio_overlay_inner");
                if (overlay && textEl) {
                    const rules = parseRules(ruleEl.value);
                    overlay.innerHTML = applyHighlight(textEl.value, rules) + (textEl.value.endsWith("\n") ? "<br>" : "");
                }
            });
        }

        // 窗口关闭按钮
        const closeBtn = document.getElementById("bbox_studio_close");
        if (closeBtn) closeBtn.addEventListener("click", async () => {
            if (typeof Neutralino !== "undefined" && Neutralino.app) {
                try { await Neutralino.window.hide(); } catch (e) {}
                try { await Neutralino.app.exit(); } catch (e) { window.close(); }
            } else {
                window.close();
            }
        });

        // 可选：接收主窗口传递的初始文本（通过 storage 共享）
        try {
            if (typeof Neutralino !== "undefined" && Neutralino.storage) {
                const initText = await Neutralino.storage.getData("bbox_studio_init_text");
                if (initText) {
                    const ta = document.getElementById("bbox_studio_text");
                    if (ta) {
                        ta.value = initText;
                        ta.dispatchEvent(new Event("input", { bubbles: true }));
                    }
                }
            }
        } catch (e) {}

        // 允许通过查询参数传入文本（备用）
        try {
            const params = new URLSearchParams(window.location.search);
            const q = params.get("text");
            if (q) {
                const ta = document.getElementById("bbox_studio_text");
                if (ta) {
                    ta.value = decodeURIComponent(q);
                    ta.dispatchEvent(new Event("input", { bubbles: true }));
                }
            }
        } catch (e) {}

        console.log("BBox Studio window ready");
    } catch (e) {
        console.error("bbox studio start failed", e);
        document.body.insertAdjacentHTML("beforeend", `<div style="color:#f55;padding:12px">启动失败: ${String(e.message||e)}</div>`);
    }
}

start();

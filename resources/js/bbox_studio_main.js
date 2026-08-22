// bbox_studio_main.js - 独立窗口入口（新应用程序级窗口）

import { initStudio, updateBboxesFromText } from "./modules/bboxStudio.js";
import { initApp } from "./modules/app.js";
import { applyI18n } from "./modules/i18n.js";
import { loadAutocompleteData } from "./modules/autocomplete.js";

async function start() {
    try {
        if (typeof Neutralino !== "undefined" && Neutralino.init) {
            try { await Neutralino.init(); } catch (e) { console.warn("Neutralino init failed", e); }
        }
        // 复用主应用的初始化（设置、配置、缩略图等），但不依赖画廊
        try { await initApp(); } catch (e) { console.warn("initApp failed", e); }
        try { await applyI18n(); } catch (e) {}

        // 加载自动补全数据
        try { await loadAutocompleteData("/data/autocomplete.txt"); } catch (e) {}

        // 允许 F12 打开开发者工具（需窗口 enableInspector:true）
        document.addEventListener("keydown", (e) => {
            if (e.key === "F12" || (e.ctrlKey && e.shiftKey && e.code === "KeyI")) return;
        }, true);

        // 无边框窗口：让顶栏可系统层拖动
        const isNeutralino = typeof Neutralino !== "undefined" && Neutralino.window;
        if (isNeutralino) {
            try {
                const region = await Neutralino.window.setDraggableRegion("bbox-studio-header");
                try { region.exclusions.add(["bbox_studio_close"]); } catch (e) {}
                try { region.exclusions.add(["bbox_studio_close"]); } catch (e) {}
            } catch (e) {}
            try {
                const header = document.getElementById("bbox-studio-header");
                if (header) {
                    header.addEventListener("dblclick", async () => {
                        try {
                            if (await Neutralino.window.isMaximized()) await Neutralino.window.unmaximize();
                            else await Neutralino.window.maximize();
                        } catch (e) {}
                    });
                }
            } catch (e) {}
            // 调整大小：右/下/右下角（同时监听 document/window，避免松开后黏连）
            try {
                const setupResize = (el, dir) => {
                    if (!el) return;
                    let state = null;
                    let onMove = null, onUp = null;
                    const cleanup = () => {
                        if (onMove) {
                            document.removeEventListener("mousemove", onMove);
                            window.removeEventListener("mousemove", onMove);
                        }
                        if (onUp) {
                            document.removeEventListener("mouseup", onUp);
                            window.removeEventListener("mouseup", onUp);
                            document.removeEventListener("mouseleave", onUp);
                        }
                        state = null; onMove = null; onUp = null;
                        document.body.style.userSelect = "";
                    };
                    el.addEventListener("mousedown", async (e) => {
                        if (e.button !== 0) return;
                        e.preventDefault(); e.stopPropagation();
                        try {
                            const sz = await Neutralino.window.getSize();
                            state = { sx: e.screenX, sy: e.screenY, w: sz.width, h: sz.height };
                            document.body.style.userSelect = "none";
                            onMove = (ev) => {
                                if (!state) return;
                                const dx = ev.screenX - state.sx;
                                const dy = ev.screenY - state.sy;
                                let nw = state.w, nh = state.h;
                                if (dir.includes("e")) nw = Math.max(560, state.w + dx);
                                if (dir.includes("s")) nh = Math.max(360, state.h + dy);
                                Neutralino.window.setSize({ width: Math.round(nw), height: Math.round(nh) }).catch(()=>{});
                            };
                            onUp = () => cleanup();
                            document.addEventListener("mousemove", onMove);
                            window.addEventListener("mousemove", onMove);
                            document.addEventListener("mouseup", onUp);
                            window.addEventListener("mouseup", onUp);
                            document.addEventListener("mouseleave", onUp);
                        } catch (err) {}
                    });
                };
                setupResize(document.getElementById("bbox-studio-resize-e"), "e");
                setupResize(document.getElementById("bbox-studio-resize-s"), "s");
                setupResize(document.getElementById("bbox-studio-resize-se"), "se");
            } catch (e) {}
        }

        // 初始化画板（画布、比例、背景、文本等）
        initStudio();

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

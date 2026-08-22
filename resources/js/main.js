// main.js - 应用入口
import { initApp } from "./modules/app.js";
import { setupUI, checkBeforeExit } from "./modules/ui.js";
import { applyI18n } from "./modules/i18n.js";

// 始终注册 windowClose 处理，否则刷新/自动重载后无法关闭窗口。
// 刷新后 window.NL_TOKEN 可能为空（tokenSecurity 为 one-time 时服务端仅首次注入 token），
// 但 Neutralino.init() 会从 sessionStorage 取回 token，所以初始化与事件注册都不能以 window.NL_TOKEN 为条件。
// 关闭窗口前检测是否有未保存的提示词修改
Neutralino.events.on("windowClose", async () => {
    try {
        const ok = await checkBeforeExit();
        if (ok) {
            Neutralino.app.exit();
        }
    } catch (e) {
        // 检测出错时按原行为直接退出
        Neutralino.app.exit();
    }
});

async function start() {
    try {
        // 必须先初始化（建立 WebSocket 连接），否则后续所有原生 API 调用都会挂起
        await Neutralino.init();
        await initApp();
        await setupUI();
        // setupUI 会动态创建带 data-i18n 的元素，界面构建完成后统一应用翻译
        await applyI18n();
        // 加载完成后再显示，避免启动白闪（配合 neutralino.config.json hidden:true）
        try {
            // 等待下一帧确保首帧已绘制
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            if (Neutralino.window) {
                try { await Neutralino.window.show(); } catch(e) {}
                // 兼容旧版本 hidden 未生效时，再次尝试
                try { const v = await Neutralino.window.isVisible(); if (!v) await Neutralino.window.show(); } catch(e){}
            }
        } catch(e) {}
        console.log("Dataset Tag Editor ready");
    } catch (e) {
        console.error("startup error", e);
        document.body.insertAdjacentHTML("beforeend",
            `<div style="color:#f00;padding:20px">启动失败: ${String(e.message || e)}</div>`);
    }
}

start();

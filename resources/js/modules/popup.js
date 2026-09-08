// popup.js - 通用浮窗模板与行为（骨架创建 / 拖动 / 缩放 / 外部关闭 / 固定 / 焦点层级）
// 页面中仅需一份 <template id="popup_template">，所有浮窗都由此模板动态创建，
// 调用方只需提供标题、按钮与内容，无需在 HTML 中重复写骨架。

// 已创建浮窗注册表（id -> 元素，仅模块内部用于幂等创建）
const popupRegistry = new Map();
function getPopup(id) {
    return popupRegistry.get(id) || document.getElementById(id);
}

// 浮窗尺寸预设：list（反推/检查类，稍宽）/ text（翻译/信息/规则类）
const POPUP_SIZE_CLASS = { list: "llm-progress-panel", text: "translate-popup" };
const POPUP_BODY_CLASS = { list: "llm-progress-body", text: "translate-popup-body" };

// 标题栏按钮预设：统一符号与样式，调用方按需选用
const POPUP_BTN = {
    pin: { cls: "translate-pin-btn", text: "📌" },
    refresh: { cls: "translate-refresh-btn", text: "↻" },
    close: { cls: "translate-close-btn", text: "✕" },
};

// 从模板创建浮窗骨架并填充内容，挂到 body 后返回元素。
// def: { id, size, titleKey/titleText/titleId, buttons:[{type,id,titleKey,title}],
//        bodyClass, bodyHTML, footerClass, footerHTML }
// 行为绑定（拖动/缩放/关闭/固定）仍由各业务 init 通过 setupPopup 接入，此处只负责建 DOM。
export function createPopup(def) {
    const { id } = def;
    if (popupRegistry.has(id) || document.getElementById(id)) return getPopup(id);
    const tpl = document.getElementById("popup_template");
    let el = null;
    if (tpl && tpl.content && tpl.content.firstElementChild) {
        el = tpl.content.firstElementChild.cloneNode(true);
    } else {
        // 模板缺失时回退为代码建骨架，保证功能可用
        el = document.createElement("div");
        el.className = "popup-window hidden";
        el.innerHTML = `<div class="translate-popup-header"><span class="translate-popup-title"></span></div><div class="popup-body"></div><div class="translate-resize"><svg viewBox="0 0 10 10" width="10" height="10"><path d="M3 9 L9 3 L9 9 Z" fill="currentColor"/></svg></div>`;
    }
    el.id = id;
    el.classList.add(POPUP_SIZE_CLASS[def.size] || POPUP_SIZE_CLASS.text);
    el.classList.add("hidden");

    // 标题
    const titleEl = el.querySelector(".translate-popup-title");
    if (def.titleId) titleEl.id = def.titleId;
    if (def.titleKey) titleEl.setAttribute("data-i18n", def.titleKey);
    titleEl.textContent = def.titleText || "";

    // 标题栏按钮（按传入顺序添加：一般为 refresh / pin / close）
    const header = el.querySelector(".translate-popup-header");
    for (const b of def.buttons || []) {
        const preset = POPUP_BTN[b.type] || POPUP_BTN.close;
        const btn = document.createElement("button");
        if (b.id) btn.id = b.id;
        btn.className = preset.cls;
        btn.textContent = b.text || preset.text;
        if (b.titleKey) btn.setAttribute("data-i18n-title", b.titleKey);
        if (b.title) btn.title = b.title;
        header.appendChild(btn);
    }

    // 内容区
    const body = el.querySelector(".popup-body");
    body.className = def.bodyClass || POPUP_BODY_CLASS[def.size] || POPUP_BODY_CLASS.text;
    body.innerHTML = def.bodyHTML || "";

    // 可选底部按钮区（如高亮规则编辑的保存/取消）
    if (def.footerHTML) {
        const footer = document.createElement("div");
        footer.className = def.footerClass || "modal-actions";
        footer.innerHTML = def.footerHTML;
        // 插到缩放把手之前，保证把手始终在最后
        el.insertBefore(footer, el.querySelector(".translate-resize"));
    }

    document.body.appendChild(el);
    popupRegistry.set(id, el);
    return el;
}

// 焦点层级：每次点按浮窗时递增，保证后点击的浮窗盖住先前的
let popupZTop = 1200000;

// 已注册焦点管理的浮窗（用于切换 .focused 高亮）
const trackedPopups = new Set();

// 将指定浮窗置顶并高亮，其余浮窗取消高亮
// 点击/拖动/缩放浮窗内部时调用，保证视觉焦点与层级一致
export function focusPopup(el) {
    if (!el) return;
    popupZTop += 1;
    el.style.zIndex = String(popupZTop);
    for (const p of trackedPopups) {
        p.classList.toggle("focused", p === el);
    }
}

// 首次显示时居中并设置默认尺寸（之后拖动/缩放会记住位置，不再重置，仅 showPopup 内部使用）
function centerPopup(el, w = 480, h = 360) {
    const vw = window.innerWidth - 16;
    const vh = window.innerHeight - 16;
    const pw = Math.min(w, Math.max(0, vw));
    const ph = Math.min(h, Math.max(0, vh));
    el.style.width = pw + "px";
    el.style.height = ph + "px";
    el.style.left = Math.max(0, Math.round((window.innerWidth - pw) / 2)) + "px";
    el.style.top = Math.max(0, Math.round((window.innerHeight - ph) / 2)) + "px";
}

// 显示浮窗：去 hidden、首次自动居中、置顶聚焦
export function showPopup(el, w, h) {
    if (!el) return;
    el.classList.remove("hidden");
    if (!el.style.width || !el.style.left) centerPopup(el, w, h);
    focusPopup(el);
}

// 隐藏浮窗并取消其焦点高亮
export function hidePopup(el) {
    if (!el) return;
    el.classList.add("hidden");
    el.classList.remove("focused");
}

// 注册通用浮窗交互，一次调用替代原来的拖动/缩放/关闭重复代码。
// opts:
// - closeBtn: 关闭按钮元素（点击隐藏，可选）
// - pinBtn: 固定按钮元素（可选，与 isPinned/onPinToggle 配合）
// - isPinned: () => bool，返回 true 时点击外部不关闭（可选）
// - onPinToggle: 固定按钮点击回调（可选，不传则只做样式同步）
// - resizeEl: 右下角缩放把手元素（可选，默认查找 .translate-resize）
// - outsideClose: false | "click" | "pointerdown"，点击外部关闭的方式（默认 false）
// - ignoreOutside: 点击外部时忽略的元素数组（例如打开按钮、译按钮，不触发关闭）
// - extraContains: (target) => bool，返回 true 时视为浮窗内部点击（不关闭）
// - onClose: 关闭时回调（可选）
// - dragIgnore: 标题栏中不触发拖动的子元素选择器（默认 "button"）
// - minW/minH/maxW/maxH: 缩放限制（maxW/maxH 可为数字或 () => 数字）
export function setupPopup(el, opts = {}) {
    if (!el) return;
    const {
        closeBtn = null,
        pinBtn = null,
        isPinned = null,
        onPinToggle = null,
        resizeEl = el.querySelector(".translate-resize") || null,
        outsideClose = false,
        ignoreOutside = [],
        extraContains = null,
        onClose = null,
        dragIgnore = "button",
        minW = 260,
        minH = 160,
        maxW = 720,
        maxH = null,
    } = opts;

    trackedPopups.add(el);

    // 点按浮窗内部即置顶聚焦（含标题栏按钮、内容区）
    el.addEventListener("pointerdown", () => focusPopup(el), true);

    // ✕ 关闭
    if (closeBtn) {
        closeBtn.addEventListener("click", () => {
            hidePopup(el);
            if (onClose) onClose();
        });
    }

    // 📌 固定切换（阻止冒泡，避免触发外部关闭）
    if (pinBtn) {
        pinBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (onPinToggle) onPinToggle();
            else if (isPinned) el.classList.toggle("pinned", !!isPinned());
        });
    }

    // 点击外部关闭（固定时除外；浮窗内部 / 忽略元素 / 额外内部判定不关闭）
    if (outsideClose === "click" || outsideClose === "pointerdown") {
        document.addEventListener(outsideClose, (e) => {
            if (el.classList.contains("hidden")) return;
            if (isPinned && isPinned()) return;
            if (el.contains(e.target)) return;
            for (const ig of ignoreOutside) {
                const node = typeof ig === "string" ? document.querySelector(ig) : ig;
                if (node && (node === e.target || node.contains(e.target))) return;
            }
            if (extraContains && extraContains(e.target)) return;
            hidePopup(el);
            if (onClose) onClose();
        });
    }

    // 按住标题栏拖动浮窗
    const header = el.querySelector(".translate-popup-header");
    if (header) {
        let drag = null;
        header.addEventListener("mousedown", (e) => {
            if (dragIgnore && e.target.closest && e.target.closest(dragIgnore)) return;
            drag = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
            e.preventDefault();
            document.body.style.userSelect = "none";
            focusPopup(el);
        });
        window.addEventListener("mousemove", (e) => {
            if (!drag) return;
            el.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - el.offsetWidth)) + "px";
            el.style.top = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - el.offsetHeight)) + "px";
        });
        window.addEventListener("mouseup", () => {
            if (drag) document.body.style.userSelect = "";
            drag = null;
        });
    }

    // 右下角把手拖动调整浮窗大小
    if (resizeEl) {
        let rs = null;
        resizeEl.addEventListener("mousedown", (e) => {
            e.preventDefault();
            rs = { w: el.offsetWidth, h: el.offsetHeight, x: e.clientX, y: e.clientY };
            document.body.style.userSelect = "none";
            focusPopup(el);
        });
        window.addEventListener("mousemove", (e) => {
            if (!rs) return;
            const maxWv = typeof maxW === "function" ? maxW() : (maxW ?? Math.min(720, window.innerWidth - 8));
            const maxHv = typeof maxH === "function" ? maxH() : (maxH ?? (window.innerHeight - 8));
            const w = Math.max(minW, Math.min(rs.w + (e.clientX - rs.x), maxWv));
            const h = Math.max(minH, Math.min(rs.h + (e.clientY - rs.y), maxHv));
            el.style.width = w + "px";
            el.style.height = h + "px";
        });
        window.addEventListener("mouseup", () => {
            if (rs) document.body.style.userSelect = "";
            rs = null;
        });
    }
}

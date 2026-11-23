// theme.js - 亮色 / 暗色主题与主题高亮色
//
// 主题模式写入 <html data-theme>，CSS 据此切换整套颜色变量；
// 高亮色由 JS 派生 hover / 柔化 / 选区 / 文字色，写入根节点内联变量以覆盖主题默认值。

import { getSetting } from "./config.js";

// 默认高亮色（与 config.js 的 SETTINGS_DEFAULT.accent_color 保持一致）
export const ACCENT_DEFAULT = "#0d6efd";

// 常用高亮色预设，供设置页快捷选择；自定义颜色仍可通过取色器选择
export const ACCENT_PRESETS = [
    "#0d6efd", // 默认蓝
    "#6610f2", // 靛紫
    "#8b5cf6", // 紫
    "#d63384", // 粉
    "#dc3545", // 红
    "#fd7e14", // 橙
    "#ffc107", // 琥珀
    "#198754", // 绿
    "#20c997", // 青绿
];

// 只接受 #rrggbb，避免非法颜色写入 CSS 变量
export function normalizeHexColor(value) {
    const s = String(value || "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : "";
}

// 向黑色混合生成 hover 色
function darkenHex(hex, ratio) {
    const n = parseInt(hex.slice(1), 16);
    const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
        .map(v => Math.round(v * (1 - ratio)).toString(16).padStart(2, "0"));
    return "#" + parts.join("");
}

function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// 计算相对亮度，用于按 WCAG 对比度选择高亮背景上的文字色
function relativeLuminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return rgb.reduce((sum, v, i) => {
        const c = v / 255;
        const linear = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        return sum + linear * [0.2126, 0.7152, 0.0722][i];
    }, 0);
}

// 在白字与深字间选择对比度更高的一方，保证任意自定义高亮色都可读
function accentTextColor(hex) {
    const lum = relativeLuminance(hex);
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return ratio(lum, relativeLuminance("#111827")) >= ratio(lum, relativeLuminance("#ffffff"))
        ? "#111827" : "#fff";
}

// 应用主题：模式写入 data-theme，高亮色派生变量直接写入根节点
export function applyTheme(theme, accent) {
    const root = document.documentElement;
    root.dataset.theme = theme === "light" ? "light" : "dark";
    const color = normalizeHexColor(accent) || ACCENT_DEFAULT;
    root.style.setProperty("--accent", color);
    root.style.setProperty("--accent-hover", darkenHex(color, 0.14));
    root.style.setProperty("--on-accent", accentTextColor(color));
    root.style.setProperty("--accent-soft", hexToRgba(color, 0.18));
    root.style.setProperty("--selection-bg", hexToRgba(color, 0.42));
}

// 从当前设置应用主题（主窗口与独立画板窗口共用）
export function applyThemeFromSettings() {
    applyTheme(getSetting("theme"), getSetting("accent_color"));
}

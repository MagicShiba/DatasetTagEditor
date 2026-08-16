// tagfilter_state.js - 标签筛选 UI 状态（对应 Python 版 TagFilterUI / TagSelectUI）
// 负责维护选中标签、搜索词、排序等，并渲染标签复选框组

import { FilterLogic, FilterMode, TagFilter, SortBy, SortOrder } from "./dataset.js";
import { t } from "./i18n.js";
import { bindAutocomplete } from "./autocomplete.js";

// 实例唯一编号，用于生成互不冲突的单选框 name
let _uid = 0;

export class TagFilterState {
    constructor({ mode = FilterMode.INCLUSIVE, showLogic = false } = {}) {
        this.mode = mode;          // INCLUSIVE / EXCLUSIVE
        this.showLogic = showLogic; // 是否显示 Filter Logic 单选（Positive/Negative 显示，Remove 不显示）
        this.logic = FilterLogic.AND;
        this.filterWord = "";
        this.sortBy = SortBy.ALPHA;
        this.sortOrder = SortOrder.ASC;
        this.selectedTags = new Set();
        this.visibleTags = new Set();
        this.prefix = false;
        this.suffix = false;
        this.regex = false;
        this.filter = new TagFilter(this.selectedTags, this.logic, this.mode);
    }

    // 构建 DOM（返回容器元素），并绑定事件
    create(el) {
        el.classList.add("tag-filter-ui");
        const uid = `tf-${++_uid}`;

        const html = `
            <div class="field">
                <label class="field-label">${t("filter_tags.search_tags")}</label>
                <input type="text" class="tf-search" placeholder="搜索标签">
            </div>
            <div class="row">
                <label class="checkbox"><input type="checkbox" class="tf-prefix"><span>${t("filter_tags.prefix")}</span></label>
                <label class="checkbox"><input type="checkbox" class="tf-suffix"><span>${t("filter_tags.suffix")}</span></label>
                <label class="checkbox"><input type="checkbox" class="tf-regex"><span>${t("filter_tags.use_regex")}</span></label>
            </div>
            <div class="field">
                <label class="field-label">${t("filter_tags.sort_by")}</label>
                <div class="radio-row">
                    <label class="checkbox"><input type="radio" class="tf-sortby" name="${uid}-sortby" value="${SortBy.ALPHA}" checked><span>${t("filter_tags.sort_alpha")}</span></label>
                    <label class="checkbox"><input type="radio" class="tf-sortby" name="${uid}-sortby" value="${SortBy.FREQ}"><span>${t("filter_tags.sort_frequency")}</span></label>
                    <label class="checkbox"><input type="radio" class="tf-sortby" name="${uid}-sortby" value="${SortBy.LEN}"><span>${t("filter_tags.sort_length")}</span></label>
                </div>
            </div>
            <div class="field">
                <label class="field-label">${t("filter_tags.sort_order")}</label>
                <div class="radio-row">
                    <label class="checkbox"><input type="radio" class="tf-sortorder" name="${uid}-sortorder" value="${SortOrder.ASC}" checked><span>${t("common.ascending")}</span></label>
                    <label class="checkbox"><input type="radio" class="tf-sortorder" name="${uid}-sortorder" value="${SortOrder.DESC}"><span>${t("common.descending")}</span></label>
                </div>
            </div>
            ${this.showLogic ? `
            <div class="field">
                <label class="field-label">${t("filter_tags.filter_logic")}</label>
                <div class="radio-row">
                    <label class="checkbox"><input type="radio" class="tf-logic" name="${uid}-logic" value="AND" checked><span>${t("filter_tags.and")}</span></label>
                    <label class="checkbox"><input type="radio" class="tf-logic" name="${uid}-logic" value="OR"><span>${t("filter_tags.or")}</span></label>
                    <label class="checkbox"><input type="radio" class="tf-logic" name="${uid}-logic" value="NONE"><span>${t("filter_tags.none")}</span></label>
                </div>
            </div>` : ""}
            <div class="row">
                <button class="btn tf-select-visibles">${t("filter_tags.select_visible")}</button>
                <button class="btn tf-deselect-visibles">${t("filter_tags.deselect_visible")}</button>
            </div>
            <div class="tf-tags"></div>
        `;
        el.innerHTML = html;

        this.el = el;
        this.searchInput = el.querySelector(".tf-search");
        // 搜索词是单值（前缀/后缀/正则匹配），选中补全时不追加逗号
        bindAutocomplete(this.searchInput, { appendComma: false });
        this.prefixCb = el.querySelector(".tf-prefix");
        this.suffixCb = el.querySelector(".tf-suffix");
        this.regexCb = el.querySelector(".tf-regex");
        this.sortByRadios = el.querySelectorAll(".tf-sortby");
        this.sortOrderRadios = el.querySelectorAll(".tf-sortorder");
        this.logicRadios = el.querySelectorAll(".tf-logic");
        this.tagsEl = el.querySelector(".tf-tags");

        // 绑定事件
        this.searchInput.addEventListener("input", () => {
            this.filterWord = this.searchInput.value;
            this.update();
        });
        this.prefixCb.addEventListener("change", () => {
            this.prefix = this.prefixCb.checked;
            this.update();
        });
        this.suffixCb.addEventListener("change", () => {
            this.suffix = this.suffixCb.checked;
            this.update();
        });
        this.regexCb.addEventListener("change", () => {
            this.regex = this.regexCb.checked;
            this.update();
        });
        this.sortByRadios.forEach(rb => rb.addEventListener("change", () => {
            this.sortBy = getCheckedValue(this.sortByRadios);
            this.update();
        }));
        this.sortOrderRadios.forEach(rb => rb.addEventListener("change", () => {
            this.sortOrder = getCheckedValue(this.sortOrderRadios);
            this.update();
        }));
        if (this.logicRadios.length) {
            this.logicRadios.forEach(rb => rb.addEventListener("change", () => {
                const v = getCheckedValue(this.logicRadios);
                this.logic = v === "AND" ? FilterLogic.AND : v === "OR" ? FilterLogic.OR : FilterLogic.NONE;
                this.filter = new TagFilter(this.selectedTags, this.logic, this.mode);
                this.update();
            }));
        }

        // 选择可见 / 取消选择可见
        const selectBtn = el.querySelector(".tf-select-visibles");
        selectBtn.addEventListener("click", () => {
            this.selectedTags = new Set([...this.selectedTags, ...this.visibleTags]);
            this.onFilterChanged();
        });
        const deselectBtn = el.querySelector(".tf-deselect-visibles");
        deselectBtn.addEventListener("click", () => {
            for (const t of this.visibleTags) this.selectedTags.delete(t);
            this.onFilterChanged();
        });

        // 标签复选框变化
        this.tagsEl.addEventListener("change", (e) => {
            if (e.target.matches(".tf-tag-cb")) {
                this.onTagsCheckboxChanged();
            }
        });
    }

    // 标签复选框变化处理
    onTagsCheckboxChanged() {
        const checked = [...this.tagsEl.querySelectorAll(".tf-tag-cb:checked")]
            .map(cb => cb.value);
        const tags = new Set(checked);
        // 保留不可见的选中标签
        const invisibleSelected = [...this.filter.tags].filter(t => !this.visibleTags.has(t));
        this.selectedTags = new Set([...tags, ...invisibleSelected]);
        this.filter = new TagFilter(this.selectedTags, this.logic, this.mode);
        this.onFilterChanged();
    }

    // 筛选条件变化后刷新画廊等
    onFilterChanged() {
        this.renderTags();
        if (window.__app && window.__app.onTagFilterChanged) {
            window.__app.onTagFilterChanged();
        }
    }

    // 从数据集重新计算并渲染标签（需在 DTE 设置后调用）
    update() {
        const dte = window.__app.dte;
        if (!dte || dte.dataset.length === 0) {
            this.renderTags();
            return;
        }

        this.selectedTags = dte.cleanupTagset(this.selectedTags);
        this.filter = new TagFilter(this.selectedTags, this.logic, this.mode);

        const app = window.__app;
        // 依据当前完整筛选（包含本筛选器之外的其他筛选器）
        const filters = app.getOtherFilters(this);
        // "与"逻辑下，本筛选器选中的标签也参与过滤，自动缩小标签范围
        if (this.filter.logic === FilterLogic.AND && this.filter.tags.size > 0) {
            filters.push(this.filter);
        }
        const tags = dte.getFilteredTags(
            filters,
            this.filterWord,
            this.filter.logic === FilterLogic.AND,
            this.prefix, this.suffix, this.regex,
        );

        // 计算应在筛选列表顶部显示的已选中标签
        let tagsInFilter = new Set();
        if (this.filterWord) {
            for (const tag of this.filter.tags) {
                if (this.filterWord && tag.includes(this.filterWord)) tagsInFilter.add(tag);
            }
        } else {
            tagsInFilter = this.filter.tags;
        }

        // 从总标签中移除已在顶部显示的
        const remaining = new Set([...tags].filter(t => !tagsInFilter.has(t)));

        const sortedInFilter = dte.sortTags([...tagsInFilter], this.sortBy, this.sortOrder);
        const sortedRemaining = dte.sortTags([...remaining], this.sortBy, this.sortOrder);
        const all = [...sortedInFilter, ...sortedRemaining];

        this.visibleTags = new Set(all);
        this.renderTags(all);
    }

    // 渲染标签复选框列表
    renderTags(tags = null) {
        const dte = window.__app.dte;
        if (!tags) {
            if (!dte || dte.dataset.length === 0) {
                this.tagsEl.innerHTML = "";
                return;
            }
            // 直接使用当前可见标签
            tags = [...this.visibleTags];
        }
        const selected = new Set(this.selectedTags);
        const html = tags.map(tag => {
            const freq = dte && dte.tag_counts ? (dte.tag_counts.get(tag) || 0) : 0;
            const label = this.sortBy === SortBy.FREQ ? `${tag} [${freq}]`
                : this.sortBy === SortBy.LEN ? `${tag} [${tag.length}]`
                : tag;
            const checked = selected.has(tag) ? "checked" : "";
            return `<label class="checkbox tf-tag-row">
                <input type="checkbox" class="tf-tag-cb" value="${escapeAttr(tag)}" ${checked}>
                <span>${escapeHtml(label)}</span>
            </label>`;
        }).join("");
        this.tagsEl.innerHTML = html || `<div class="small-note">${t("filter_tags.no_tags") || "(no tags)"}</div>`;
    }

    // 清空筛选
    clearFilter() {
        this.filter = new TagFilter(new Set(), this.logic, this.mode);
        this.filterWord = "";
        this.selectedTags = new Set();
        if (this.searchInput) this.searchInput.value = "";
        this.update();
    }

    // 返回当前 TagFilter 对象
    getFilter() {
        return this.filter;
    }

    // 应用配置（含 DOM 控件同步）
    applyConfig(cfg) {
        if (!cfg) return;
        this.logic = cfg.logic === "AND" ? FilterLogic.AND : cfg.logic === "OR" ? FilterLogic.OR : FilterLogic.NONE;
        this.sortBy = cfg.sort_by || SortBy.ALPHA;
        this.sortOrder = cfg.sort_order || SortOrder.ASC;
        this.prefix = !!cfg.sw_prefix;
        this.suffix = !!cfg.sw_suffix;
        this.regex = !!cfg.sw_regex;
        this.filter = new TagFilter(this.selectedTags, this.logic, this.mode);
        if (this.sortByRadios) setRadioValue(this.sortByRadios, this.sortBy);
        if (this.sortOrderRadios) setRadioValue(this.sortOrderRadios, this.sortOrder);
        if (this.prefixCb) this.prefixCb.checked = this.prefix;
        if (this.suffixCb) this.suffixCb.checked = this.suffix;
        if (this.regexCb) this.regexCb.checked = this.regex;
        if (this.logicRadios) setRadioValue(this.logicRadios, this.logic === FilterLogic.AND ? "AND" : this.logic === FilterLogic.OR ? "OR" : "NONE");
    }

    // 重新初始化筛选（模式/逻辑已确定时）
    reset(mode, logic) {
        this.mode = mode;
        this.logic = logic;
        this.filter = new TagFilter(new Set(), this.logic, this.mode);
        this.selectedTags = new Set();
        this.filterWord = "";
        this.visibleTags = new Set();
        if (this.searchInput) this.searchInput.value = "";
        if (this.logicRadios) setRadioValue(this.logicRadios, logic === FilterLogic.AND ? "AND" : logic === FilterLogic.OR ? "OR" : "NONE");
    }
}

// 取当前选中的单选框值
function getCheckedValue(radios) {
    for (const rb of radios) {
        if (rb.checked) return rb.value;
    }
    return "";
}

// 按值设置单选框选中状态
function setRadioValue(radios, value) {
    radios.forEach(rb => { rb.checked = rb.value === value; });
}

function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s) {
    return escapeHtml(s);
}
// dataset.js - 数据集与标签核心逻辑

import * as api from "./api.js";
import { normalizePath, getStem, getExtension, withSuffix, withStem, md5, getDirname, getBasename, splitCaption, splitCaptionWithSepts, cleanupTrailingSep } from "./utils.js";

// ================================================================
// Data: 单张图片及其标签
// ================================================================

export class Data {
    constructor(imgpath, caption, missingCaption = false, applied = false, septs = null) {
        this.imgpath = imgpath;
        const res = splitCaptionWithSepts(caption);
        this.tags = res.tags;
        // septs[i] 为 tags[i] 之后的原始间隔文本（末位为末尾文本，如句号）
        this.septs = septs || res.septs;
        this.tagset = new Set(this.tags);
        // 加载时该图像是否不存在文本文件（用于画廊标记 / LLM 反推）
        this.missing_caption = missingCaption;
        // 用户是否已编辑并通过"将更改应用于图像"应用过非空标注（用于画廊绿点标记）
        this.applied = applied;
    }

    // 原标注末尾文本（最后一个间隔，如句号），无则返回 ""
    getTrailingText() {
        if (this.septs && this.septs.length > 0) return this.septs[this.septs.length - 1];
        return "";
    }

    // 无分隔符信息（批量编辑/替换/排序等）时重建默认间隔：标签间 ", "，末尾沿用原末尾文本（经清理）
    static defaultSepts(tags, trailing) {
        if (!tags || tags.length === 0) return [];
        const arr = new Array(tags.length).fill(", ");
        arr[arr.length - 1] = cleanupTrailingSep(trailing);
        return arr;
    }

    tagContainsAllOf(tags) {
        for (const t of tags) {
            if (!this.tagset.has(t)) return false;
        }
        return true;
    }

    tagContainsAnyOf(tags) {
        for (const t of tags) {
            if (this.tagset.has(t)) return true;
        }
        return false;
    }
}

// 将标签与间隔文本拼接回标注文本（保留原始分隔符与末尾句号）
export function joinTagsWithSepts(tags, septs) {
    if (!tags || tags.length === 0) return "";
    if (septs && septs.length === tags.length) {
        return tags.map((t, i) => t + (septs[i] ?? "")).join("");
    }
    return tags.join(", ");
}

// ================================================================
// Dataset: 数据集（Map 结构）
// ================================================================

export class Dataset {
    constructor() {
        this.datas = new Map(); // path -> Data
    }

    get length() {
        return this.datas.size;
    }

    clear() {
        this.datas.clear();
    }

    merge(other, overwrite = true) {
        for (const [path, data] of other.datas) {
            if (overwrite || !this.datas.has(path)) {
                this.datas.set(path, data);
            }
        }
        return this;
    }

    appendData(data) {
        this.datas.set(data.imgpath, data);
    }

    remove(other) {
        for (const path of other.datas.keys()) {
            if (this.datas.has(path)) {
                this.datas.delete(path);
            }
        }
        return this;
    }

    removeByPath(path) {
        this.datas.delete(path);
    }

    copy() {
        const res = new Dataset();
        res.datas = new Map(this.datas);
        return res;
    }

    getData(path) {
        return this.datas.get(path) || null;
    }

    getDataTags(path) {
        const d = this.getData(path);
        return d ? d.tags : [];
    }

    getDataTagset(path) {
        const d = this.getData(path);
        return d ? d.tagset : new Set();
    }

    getTagset() {
        const tags = new Set();
        for (const data of this.datas.values()) {
            for (const t of data.tagset) tags.add(t);
        }
        return tags;
    }

    getTaglist() {
        return [...this.getTagset()];
    }
}

// ================================================================
// Filters: 过滤器
// ================================================================

export const FilterLogic = { NONE: 0, AND: 1, OR: 2 };
export const FilterMode = { NONE: 0, INCLUSIVE: 1, EXCLUSIVE: 2 };

export class TagFilter {
    constructor(tags = new Set(), logic = FilterLogic.NONE, mode = FilterMode.NONE) {
        this.tags = tags;
        this.logic = logic;
        this.mode = mode;
    }

    apply(dataset) {
        if (!this.tags || this.tags.size === 0 ||
            this.logic === FilterLogic.NONE || this.mode === FilterMode.NONE) {
            return dataset;
        }

        const pathsToRemove = [];

        if (this.logic === FilterLogic.AND) {
            if (this.mode === FilterMode.INCLUSIVE) {
                for (const [path, data] of dataset.datas) {
                    if (!data.tagContainsAllOf(this.tags)) pathsToRemove.push(path);
                }
            } else if (this.mode === FilterMode.EXCLUSIVE) {
                for (const [path, data] of dataset.datas) {
                    if (data.tagContainsAllOf(this.tags)) pathsToRemove.push(path);
                }
            }
        } else if (this.logic === FilterLogic.OR) {
            if (this.mode === FilterMode.INCLUSIVE) {
                for (const [path, data] of dataset.datas) {
                    if (!data.tagContainsAnyOf(this.tags)) pathsToRemove.push(path);
                }
            } else if (this.mode === FilterMode.EXCLUSIVE) {
                for (const [path, data] of dataset.datas) {
                    if (data.tagContainsAnyOf(this.tags)) pathsToRemove.push(path);
                }
            }
        }

        for (const path of pathsToRemove) {
            dataset.removeByPath(path);
        }
        return dataset;
    }

    toString() {
        if (!this.tags || this.tags.size === 0) return "";
        let res = "";
        if (this.mode === FilterMode.EXCLUSIVE) res += "NOT ";
        if (this.logic === FilterLogic.AND) res += "AND";
        else if (this.logic === FilterLogic.OR) res += "OR";
        if (this.logic === FilterLogic.AND || this.logic === FilterLogic.OR) {
            res += `(${[...this.tags].join(", ")})`;
        }
        return res;
    }
}

export class PathFilter {
    constructor(paths = new Set(), mode = FilterMode.NONE) {
        this.paths = paths;
        this.mode = mode;
    }

    apply(dataset) {
        if (this.mode === FilterMode.NONE) return dataset;

        let pathsToRemove = [...this.paths];
        if (this.mode === FilterMode.INCLUSIVE) {
            const all = new Set(dataset.datas.keys());
            pathsToRemove = [...all].filter(p => !this.paths.has(p));
        }

        for (const path of pathsToRemove) {
            dataset.removeByPath(path);
        }
        return dataset;
    }
}

export class TagScoreFilter {
    constructor(scores, tag, threshold, mode = FilterMode.NONE) {
        this.scores = scores;
        this.mode = mode;
        this.tag = tag;
        this.threshold = threshold;
    }

    apply(dataset) {
        if (this.mode === FilterMode.NONE) return dataset;

        let pathsToRemove = new Set();
        for (const [path, scores] of Object.entries(this.scores)) {
            if ((scores[this.tag] || 0) > this.threshold) {
                pathsToRemove.add(path);
            }
        }

        if (this.mode === FilterMode.GREATER_THAN) {
            const all = new Set(dataset.datas.keys());
            pathsToRemove = new Set([...all].filter(p => !pathsToRemove.has(p)));
        }

        for (const path of pathsToRemove) {
            dataset.removeByPath(path);
        }
        return dataset;
    }
}

// ================================================================
// 正则
// ================================================================

const RE_TAGS = /^([\s\S]+?)( \[\d+\])?$/;
const RE_NEWLINES = /[\r\n]+/;
const RE_NUMBERS_AT_START = /^[-\d]+\s*/;

// ================================================================
// DatasetTagEditor: 核心编辑器
// ================================================================

export const SortBy = {
    ALPHA: "Alphabetical Order",
    FREQ: "Frequency",
    LEN: "Length",
};

export const SortOrder = {
    ASC: "Ascending",
    DESC: "Descending",
};

export class DatasetTagEditor {
    constructor() {
        this.dataset = new Dataset();
        this.img_idx = new Map();
        this.tag_counts = new Map();
        this.dataset_dir = "";
        this.re_word = null;
        this.filename_join_string = " ";
        // 同名 stem 分组（loadDataset 时计算），用于标注文件路径消歧
        this.stemGroups = null;
    }

    // ---------- 标签信息 ----------

    constructTagInfos() {
        this.tag_counts = new Map();
        for (const data of this.dataset.datas.values()) {
            for (const tag of data.tags) {
                this.tag_counts.set(tag, (this.tag_counts.get(tag) || 0) + 1);
            }
        }
    }

    getTagList() {
        if (this.tag_counts.size === 0) this.constructTagInfos();
        return [...this.tag_counts.keys()];
    }

    getTagSet() {
        if (this.tag_counts.size === 0) this.constructTagInfos();
        return new Set(this.tag_counts.keys());
    }

    getTagsByImagePath(imgpath) {
        return this.dataset.getDataTags(imgpath);
    }

    setTagsByImagePath(imgpath, tags, missingCaption, applied, septs = null) {
        // 未显式指定时保留原有标记，避免覆盖丢失
        const existing = this.dataset.getData(imgpath);
        const miss = missingCaption !== undefined
            ? missingCaption
            : (existing ? existing.missing_caption : false);
        const appld = applied !== undefined
            ? applied
            : (existing ? existing.applied : false);
        // 无分隔符信息（批量编辑/替换/排序等）时用默认间隔，末尾沿用原有句号等文本
        const effectiveSepts = (septs && septs.length === tags.length)
            ? septs
            : Data.defaultSepts(tags, existing ? existing.getTrailingText() : "");
        const data = new Data(imgpath, "", miss, appld, effectiveSepts);
        data.tags = [...tags];
        data.tagset = new Set(data.tags);
        this.dataset.appendData(data);
        return data;
    }

    // 更新 LLM 反推后的标签，并清除"缺失文本文件"标记
    // append 为 true 时在已有标注后追加并去重，否则覆盖
    setReverseTags(imgpath, tags, append = true, septs = null) {
        const data = this.dataset.getData(imgpath);
        if (!data) return;
        // 空标注时 tags 为 [""]，需排除空字符串后再判定是否已有内容
        const hadContent = data.tags.some(t => t);
        if (append && hadContent) {
            // 追加去重：保留已有标签的原始间隔与末尾标点，反推内容另起一行以便区分
            const base = (data.septs && data.septs.length === data.tags.length)
                ? data.septs.slice()
                : data.tags.map(() => ", ");
            if (base.length > 0) {
                // 末尾标点（如句号 . 。）原样保留，其余末尾逗号/空白清空，统一以换行衔接反推内容
                base[base.length - 1] = cleanupTrailingSep(base[base.length - 1]) + "\n";
            }
            const existingSet = new Set(data.tags);
            for (const t of tags) {
                if (!existingSet.has(t)) {
                    data.tags.push(t);
                    base.push(", ");
                }
            }
            data.septs = base;
        } else {
            const effectiveSepts = (septs && septs.length === tags.length)
                ? septs
                : Data.defaultSepts(tags, "");
            data.tags = tags;
            data.septs = effectiveSepts;
        }
        data.tagset = new Set(data.tags);
        data.missing_caption = false;
        // 原本没有标注、反推后产生内容 → 标记为"反推打标"（画廊黄点）
        if (!hadContent && data.tags.some(t => t)) data.reversed = true;
    }

    // 将标签转换为显示文本（带频率/长度）
    writeTags(tags, sort_by = SortBy.FREQ) {
        if (!tags) return [];
        return tags.map(tag => {
            if (!tag) return "";
            if (sort_by === SortBy.FREQ) return `${tag} [${this.tag_counts.get(tag) || 0}]`;
            if (sort_by === SortBy.LEN) return `${tag} [${tag.length}]`;
            return tag;
        });
    }

    // 从显示文本还原标签（去掉 [n] 后缀）
    readTags(tags) {
        if (!tags) return [];
        return tags.map(tag => {
            const m = RE_TAGS.exec(tag);
            return m ? m[1] : tag;
        }).filter(t => t);
    }

    // 排序标签
    sortTags(tags, sort_by = SortBy.ALPHA, sort_order = SortOrder.ASC) {
        const arr = [...tags];
        const asc = sort_order === SortOrder.ASC;
        if (sort_by === SortBy.ALPHA) {
            arr.sort((a, b) => asc ? (a < b ? -1 : a > b ? 1 : 0) : (a > b ? -1 : a < b ? 1 : 0));
        } else if (sort_by === SortBy.FREQ) {
            arr.sort((a, b) => {
                const fa = this.tag_counts.get(a) || 0;
                const fb = this.tag_counts.get(b) || 0;
                if (fa !== fb) return asc ? fa - fb : fb - fa;
                return a < b ? -1 : a > b ? 1 : 0;
            });
        } else if (sort_by === SortBy.LEN) {
            arr.sort((a, b) => {
                if (a.length !== b.length) return asc ? a.length - b.length : b.length - a.length;
                return a < b ? -1 : a > b ? 1 : 0;
            });
        }
        return arr;
    }

    // ---------- 过滤 ----------

    getFilteredImgpaths(filters = []) {
        const filtered = this.dataset.copy();
        for (const f of filters) f.apply(filtered);
        return [...filtered.datas.keys()].sort();
    }

    getFilteredImgs(filters = []) {
        const filtered = this.dataset.copy();
        for (const f of filters) f.apply(filtered);
        return [...filtered.datas.keys()].sort();
    }

    getFilteredImgindices(filters = []) {
        const filtered = this.dataset.copy();
        for (const f of filters) f.apply(filtered);
        const paths = [...filtered.datas.keys()].sort();
        return paths.map(p => this.img_idx.get(p));
    }

    getFilteredTags(filters = [], filter_word = "", filterTags = true,
        prefix = false, suffix = false, regex = false) {
        let tags;
        if (filterTags) {
            const filtered = this.dataset.copy();
            for (const f of filters) f.apply(filtered);
            tags = filtered.getTagset();
        } else {
            tags = this.dataset.getTagset();
        }

        if (!filter_word) return tags;

        const result = new Set();
        try {
            for (const tag of tags) {
                if (prefix) {
                    if (regex) {
                        if (new RegExp("^" + filter_word).test(tag)) { result.add(tag); continue; }
                    } else {
                        if (tag.startsWith(filter_word)) { result.add(tag); continue; }
                    }
                }
                if (suffix) {
                    if (regex) {
                        if (new RegExp(filter_word + "$").test(tag)) { result.add(tag); continue; }
                    } else {
                        if (tag.endsWith(filter_word)) { result.add(tag); continue; }
                    }
                }
                if (!prefix && !suffix) {
                    if (regex) {
                        if (new RegExp(filter_word).test(tag)) { result.add(tag); continue; }
                    } else {
                        if (tag.includes(filter_word)) { result.add(tag); continue; }
                    }
                }
            }
        } catch (e) {
            return tags;
        }
        return result;
    }

    cleanupTags(tags) {
        const current = this.dataset.getTagset();
        return tags.filter(t => current.has(t));
    }

    cleanupTagset(tags) {
        const current = this.dataset.getTagset();
        return new Set([...tags].filter(t => current.has(t)));
    }

    getCommonTags(filters = []) {
        const filtered = this.dataset.copy();
        for (const f of filters) f.apply(filtered);

        let result = null;
        for (const data of filtered.datas.values()) {
            if (result === null) result = new Set(data.tagset);
            else result = new Set([...result].filter(t => data.tagset.has(t)));
        }
        if (result === null) result = new Set();
        return [...result].sort();
    }

    // ---------- 批量编辑 ----------

    replaceTags(searchTags, replaceTags, filters = [], prepend = false) {
        const imgPaths = this.getFilteredImgpaths(filters);
        const tagsToAppend = replaceTags.slice(searchTags.length);
        const tagsToRemove = searchTags.slice(replaceTags.length);
        const tagsToReplace = {};
        for (let i = 0; i < Math.min(searchTags.length, replaceTags.length); i++) {
            if (replaceTags[i] === null || replaceTags[i] === "") {
                tagsToRemove.push(searchTags[i]);
            } else {
                tagsToReplace[searchTags[i]] = replaceTags[i];
            }
        }
        for (const imgPath of imgPaths) {
            const tags = this.dataset.getDataTags(imgPath);
            const tagsRemoved = tags.filter(t => !tagsToRemove.includes(t));
            const tagsReplaced = tagsRemoved.map(t =>
                tagsToReplace[t] !== undefined ? tagsToReplace[t] : t);
            this.setTagsByImagePath(imgPath,
                prepend ? [...tagsToAppend, ...tagsReplaced] : [...tagsReplaced, ...tagsToAppend]);
        }
        this.constructTagInfos();
    }

    getReplacedTagset(tags, searchTags, replaceTags) {
        const tagsToRemove = searchTags.slice(replaceTags.length);
        const tagsToReplace = {};
        for (let i = 0; i < Math.min(searchTags.length, replaceTags.length); i++) {
            if (replaceTags[i] === null || replaceTags[i] === "") {
                tagsToRemove.push(searchTags[i]);
            } else {
                tagsToReplace[searchTags[i]] = replaceTags[i];
            }
        }
        const tagsRemoved = new Set([...tags].filter(t => !tagsToRemove.includes(t)));
        const tagsReplaced = new Set([...tagsRemoved].map(t =>
            tagsToReplace[t] !== undefined ? tagsToReplace[t] : t));
        return new Set([...tagsReplaced].filter(t => t));
    }

    searchAndReplaceCaption(searchText, replaceText, filters = [], useRegex = false) {
        const imgPaths = this.getFilteredImgpaths(filters);
        for (const imgPath of imgPaths) {
            let caption = this.dataset.getDataTags(imgPath).join(", ");
            if (useRegex) {
                caption = new RegExp(searchText, "g") ? caption.replace(new RegExp(searchText, "g"), replaceText) : caption;
            } else {
                caption = caption.split(searchText).join(replaceText);
            }
            let captionTags = splitCaption(caption);
            this.setTagsByImagePath(imgPath, captionTags);
        }
        this.constructTagInfos();
    }

    searchAndReplaceSelectedTags(searchText, replaceText, selectedTags, filters = [], useRegex = false) {
        const imgPaths = this.getFilteredImgpaths(filters);
        for (const imgPath of imgPaths) {
            let tags = this.dataset.getDataTags(imgPath);
            tags = this.searchAndReplaceTagList(searchText, replaceText, tags, selectedTags, useRegex);
            this.setTagsByImagePath(imgPath, tags);
        }
        this.constructTagInfos();
    }

    searchAndReplaceTagList(searchText, replaceText, tags, selectedTags = null, useRegex = false) {
        let out;
        if (useRegex) {
            const re = new RegExp(searchText, "g");
            out = selectedTags === null
                ? tags.map(t => t.replace(re, replaceText))
                : tags.map(t => selectedTags.has(t) ? t.replace(re, replaceText) : t);
        } else {
            out = selectedTags === null
                ? tags.map(t => t.split(searchText).join(replaceText))
                : tags.map(t => selectedTags.has(t) ? t.split(searchText).join(replaceText) : t);
        }
        const flat = [];
        for (const t of out) {
            for (const t2 of splitCaption(t)) {
                if (t2) flat.push(t2);
            }
        }
        return flat.filter(t => t);
    }

    searchAndReplaceTagSet(searchText, replaceText, tags, selectedTags = null, useRegex = false) {
        let out;
        if (useRegex) {
            const re = new RegExp(searchText, "g");
            out = selectedTags === null
                ? new Set([...tags].map(t => t.replace(re, replaceText)))
                : new Set([...tags].map(t => selectedTags.has(t) ? t.replace(re, replaceText) : t));
        } else {
            out = selectedTags === null
                ? new Set([...tags].map(t => t.split(searchText).join(replaceText)))
                : new Set([...tags].map(t => selectedTags.has(t) ? t.split(searchText).join(replaceText) : t));
        }
        const flat = new Set();
        for (const t of out) {
            for (const t2 of splitCaption(t)) {
                if (t2) flat.add(t2);
            }
        }
        return new Set([...flat].filter(t => t));
    }

    removeDuplicatedTags(filters = []) {
        const imgPaths = this.getFilteredImgpaths(filters);
        for (const path of imgPaths) {
            const tags = this.dataset.getDataTags(path);
            const res = [];
            for (const t of tags) {
                if (!res.includes(t)) res.push(t);
            }
            this.setTagsByImagePath(path, res);
        }
        this.constructTagInfos();
    }

    removeTags(tags, filters = []) {
        const imgPaths = this.getFilteredImgpaths(filters);
        for (const path of imgPaths) {
            let res = this.dataset.getDataTags(path);
            res = res.filter(t => !tags.has(t));
            this.setTagsByImagePath(path, res);
        }
        this.constructTagInfos();
    }

    sortFilteredTags(filters = [], sort_by = SortBy.ALPHA, sort_order = SortOrder.ASC) {
        const imgPaths = this.getFilteredImgpaths(filters);
        for (const path of imgPaths) {
            const tags = this.dataset.getDataTags(path);
            const res = this.sortTags(tags, sort_by, sort_order);
            this.setTagsByImagePath(path, res);
        }
        this.constructTagInfos();
    }

    // ---------- 文件操作 ----------

    // 计算同名 stem 分组（大小写不敏感，如 image.jpg 与 image.png 同名）
    getStemGroups(paths) {
        const groups = new Map();
        for (const p of paths) {
            const stem = getStem(p).toLowerCase();
            if (!groups.has(stem)) groups.set(stem, []);
            groups.get(stem).push(p);
        }
        for (const arr of groups.values()) arr.sort();
        return groups;
    }

    // 解析某图像的标注文件路径：
    // 同名 stem 冲突时，排序后第一个保留标准名 stem.txt，其余用 stem.ext + captionExt 区分（如 image.png.txt），
    // 避免 image.jpg 与 image.png 都写入 image.txt 造成覆盖冲突
    resolveCaptionPath(imgPath, captionExt, groups) {
        const g = groups || this.getStemGroups([...this.dataset.datas.keys()]);
        const stem = getStem(imgPath).toLowerCase();
        const group = g.get(stem);
        if (group && group.length > 1 && group[0] !== imgPath) {
            return `${getDirname(imgPath)}/${getBasename(imgPath)}${captionExt}`;
        }
        return withSuffix(imgPath, captionExt);
    }

    getImgPathList() {
        return [...this.dataset.datas.keys()];
    }

    getImgPathSet() {
        return new Set(this.dataset.datas.keys());
    }

    // 删除文件（图片/标注/备份）
    async deleteDatasetFile(imgPath, captionExt, deleteImage, deleteCaption, deleteBackup) {
        if (!this.dataset.datas.has(imgPath)) return;

        // 在修改数据集前先解析标注文件路径（重名区分），后续删除操作共用
        const txtPath = this.resolveCaptionPath(imgPath, captionExt);

        if (deleteImage) {
            try {
                if (await api.pathExists(imgPath)) {
                    await api.removeFile(imgPath);
                    this.dataset.removeByPath(imgPath);
                }
            } catch (e) { }
        }
        if (deleteCaption) {
            try {
                if (await api.pathExists(txtPath)) {
                    await api.removeFile(txtPath);
                }
            } catch (e) { }
        }
        if (deleteBackup) {
            try {
                // 备份名基于标注文件（与 saveDataset 一致，重名区分后的文件备份为 image.png.001 等）
                const bakBase = txtPath;
                for (let extnum = 0; extnum < 1000; extnum++) {
                    const bakPath = withSuffix(bakBase, `.${String(extnum).padStart(3, "0")}`);
                    if (await api.pathExists(bakPath)) {
                        await api.removeFile(bakPath);
                    } else {
                        break;
                    }
                }
            } catch (e) { }
        }
    }

    async deleteDataset(captionExt, filters, deleteImage, deleteCaption, deleteBackup) {
        const filtered = this.dataset.copy();
        for (const f of filters) f.apply(filtered);
        for (const path of filtered.datas.keys()) {
            await this.deleteDatasetFile(path, captionExt, deleteImage, deleteCaption, deleteBackup);
        }
        if (deleteImage) {
            this.dataset.remove(filtered);
            this.constructTagInfos();
        }
    }

    // 移动文件
    async moveDatasetFile(imgPath, captionExt, destDir, moveImage, moveCaption, moveBackup) {
        if (!this.dataset.datas.has(imgPath)) return;

        // 在修改数据集前先解析标注文件路径（重名区分），后续移动操作共用
        const txtPath = this.resolveCaptionPath(imgPath, captionExt);
        const bakBase = txtPath;

        const needMove = moveImage || moveCaption || moveBackup;
        if (needMove && !(await api.pathExists(destDir))) {
            await api.createDirectory(destDir);
        }

        if (moveImage) {
            try {
                const name = getBasename(imgPath);
                const dst = `${destDir}/${name}`;
                if (await api.pathExists(imgPath)) {
                    await api.moveFile(imgPath, dst);
                    this.dataset.removeByPath(imgPath);
                }
            } catch (e) { }
        }
        if (moveCaption) {
            try {
                if (await api.pathExists(txtPath)) {
                    const name = getBasename(txtPath);
                    await api.moveFile(txtPath, `${destDir}/${name}`);
                }
            } catch (e) { }
        }
        if (moveBackup) {
            try {
                for (let extnum = 0; extnum < 1000; extnum++) {
                    const bakPath = withSuffix(bakBase, `.${String(extnum).padStart(3, "0")}`);
                    if (await api.pathExists(bakPath)) {
                        const name = getBasename(bakPath);
                        await api.moveFile(bakPath, `${destDir}/${name}`);
                    } else {
                        break;
                    }
                }
            } catch (e) { }
        }
    }

    async moveDataset(destDir, captionExt, filters, moveImage, moveCaption, moveBackup) {
        const filtered = this.dataset.copy();
        for (const f of filters) f.apply(filtered);
        for (const path of filtered.datas.keys()) {
            await this.moveDatasetFile(path, captionExt, destDir, moveImage, moveCaption, moveBackup);
        }
        if (moveImage) {
            this.constructTagInfos();
        }
    }

    // ---------- 加载数据集 ----------

    // 仅加载标注与"缺失文本文件"标记，不在此处调用 LLM 反推
    // （反推由 ui.js 在加载完成后通过进度窗口统一处理）
    async loadDataset(imgDir, captionExt, recursive, loadCaptionFromFilename, replaceNewLine) {
        this.clear();
        this.dataset_dir = imgDir;

        try {
            let filepaths;
            if (recursive) {
                filepaths = await api.listFilesRecursive(imgDir);
            } else {
                filepaths = await api.listFiles(imgDir);
            }

            // 过滤出图片文件
            const imgpaths = filepaths.filter(p => api.isImagePath(p));
            imgpaths.sort();

            // 计算同名 stem 分组，用于解析不冲突的标注文件路径
            this.stemGroups = this.getStemGroups(imgpaths);

            // 加载标注
            const missingPaths = [];
            for (const imgPath of imgpaths) {
                const { tags, septs, hasCaptionFile } = await this.loadCaptionForImage(imgPath, captionExt, loadCaptionFromFilename, replaceNewLine);
                this.setTagsByImagePath(imgPath, tags, !hasCaptionFile, undefined, septs);
                if (!hasCaptionFile) missingPaths.push(imgPath);
            }

            // 重建索引
            this.img_idx.clear();
            const keys = [...this.dataset.datas.keys()].sort();
            for (let i = 0; i < keys.length; i++) {
                this.img_idx.set(keys[i], i);
            }

            this.constructTagInfos();
            return { count: this.dataset.length, paths: keys, missingPaths };
        } catch (e) {
            this.clear();
            return { count: 0, paths: [], missingPaths: [], error: String(e.message || e) };
        }
    }

    // 返回 { tags, hasCaptionFile }
    async loadCaptionForImage(imgPath, captionExt, loadCaptionFromFilename, replaceNewLine) {
        const txtPath = this.resolveCaptionPath(imgPath, captionExt, this.stemGroups);
        let captionText = "";
        let hasCaptionFile = false;

        if (await api.pathExists(txtPath)) {
            hasCaptionFile = true;
            captionText = await api.readTextFile(txtPath) || "";
        } else if (loadCaptionFromFilename) {
            captionText = getStem(imgPath);
            captionText = captionText.replace(RE_NUMBERS_AT_START, "");
            if (this.re_word) {
                const tokens = captionText.match(new RegExp(this.re_word, "g")) || [];
                captionText = tokens.join(this.filename_join_string || "");
            }
        }

        if (replaceNewLine) {
            captionText = captionText.replace(RE_NEWLINES, ",");
        }

        let captionSplit = splitCaptionWithSepts(captionText);
        return { tags: captionSplit.tags, septs: captionSplit.septs, hasCaptionFile };
    }

    // ---------- 保存数据集 ----------

    async saveDataset(backup, captionExt) {
        if (this.dataset.length === 0) {
            return { saved: 0, total: 0, dir: this.dataset_dir };
        }

        let savedNum = 0;
        let backupNum = 0;

        // 依据当前数据集重新计算同名分组，保证保存路径与加载一致
        const groups = this.getStemGroups([...this.dataset.datas.keys()]);

        for (const data of this.dataset.datas.values()) {
            const imgPath = data.imgpath;

            // 加载时没有文本文件、保存时仍然没有打标（无实际文本）→ 不生成文本文件
            if (data.missing_caption && data.tags.length === 0) continue;

            const txtPath = this.resolveCaptionPath(imgPath, captionExt, groups);

            // 备份（备份名基于标注文件自身，重名区分后的文件备份到 image.png.001 等）
            if (backup && await api.pathExists(txtPath)) {
                let bakPath = null;
                for (let extnum = 0; extnum < 1000; extnum++) {
                    const cand = withSuffix(txtPath, `.${String(extnum).padStart(3, "0")}`);
                    if (!(await api.pathExists(cand))) {
                        bakPath = cand;
                        break;
                    }
                }
                if (bakPath === null) {
                    // 备份文件过多
                } else {
                    try {
                        await api.moveFile(txtPath, bakPath);
                        backupNum++;
                    } catch (e) { }
                }
            }

            // 保存
            try {
                await api.writeTextFile(txtPath, joinTagsWithSepts(data.tags, data.septs));
                savedNum++;
            } catch (e) { }
        }

        return { saved: savedNum, total: this.dataset.length, dir: this.dataset_dir };
    }

    // ---------- 清理 ----------

    clear() {
        this.dataset.clear();
        this.tag_counts.clear();
        this.img_idx.clear();
        this.dataset_dir = "";
        this.stemGroups = null;
    }
}
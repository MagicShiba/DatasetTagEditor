# 数据集标签编辑器 (Dataset Tag Editor)
这是一个用于编辑图像生成模型训练数据集的打标工具。  
本项目基于 [Neutralinojs](https://neutralino.js.org/) 是对 [Dataset Tag Editor](https://github.com/toshiaki1729/dataset-tag-editor-standalone) 进行的复刻与增强版。  
![alt text](other/sc-main.png)

## 制作目的
出于长期使用习惯，但原项目已停止维护，在进行自用改造时遇到了诸多底层限制，凑合着使用了很久，因此基于自身实际需求进行了复刻与功能扩展。

## 功能与特点
- **功能兼容**：基本操作和大部分功能与原项目一致
- **使用LLM进行打标**：支持调用本地或在线 LLM 进行自动打标
- **进度管理**：可查看自动打标进度，支持添加或删除待打标图像
- **自定义 LLM 功能**：可灵活配置 LLM 用于翻译或打标或其它功能
- **输入辅助**：输入时提供自动文本补全
- **关键字高亮**：支持自定义关键字高亮显示
- **翻译浮窗**：支持调用llm进行翻译,浮窗可拖动与固定
- **文件处理**：支持文件批量自动重命名和删除
- **轻量**：程序整体不到 5MB，基于系统 WebView 运行，无需额外依赖
- **性能优化**：相比原项目更流畅
- 其它 : 自动语言切换，编辑状态指示，分隔符设置，关闭确认

## 功能截图
翻译窗口 与 自定义LLM工具  
![alt text](other/sc-llm.png)  

自定义不同的配置(你可以为不同功能配置是否思考)  
自定义LLM工具和使用的配置(你可以自定义翻译、格式化、润色等工具)
![alt text](other/sc-st.png)  

进度管理与高亮规则编辑窗口    
![alt text](other/sc-hl.png)

## 运行与构建

### Windows 直接运行
使用项目内 `dataset-tag-editor-win_x64.exe` 即可直接启动使用。  


> **平台说明**：我没有其它平台设备，因此只保证能在windows下运行。

### 从neutralinojs运行或构建
本项目基于 [Neutralinojs](https://neutralino.js.org/) 开发，请确保已安装 Node.js 环境。

```bash
# 1. 安装 Neutralino CLI
npm i -g @neutralinojs/neu

# 2. 运行项目
neu run

# 3. 构建发布包
neu build

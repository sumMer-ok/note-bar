# Note Bar / HiWords 项目概况

> 本文档由 AI 助手根据当前代码库整理，用于快速了解项目结构、核心功能与开发约定。

## 1. 项目概述

本项目是一个 **Obsidian 社区插件**，对外发布名称为 **Note Bar**，内部集成了完整的 **HiWords 生词本**功能。

- **插件 ID**: `note-bar`
- **插件名称**: Note Bar
- **当前版本**: `1.0.0`
- **manifest**: [manifest.json](manifest.json)
- **构建产物**: `main.js`（由 esbuild 打包）
- **目标平台**: Obsidian（桌面端为主，manifest 未标记 `isDesktopOnly: true`）

### 1.1 功能定位

Note Bar 提供两类核心能力：

1. **飞书风格浮动格式工具栏**：选中文本时弹出格式化工具栏，支持标题/对齐/加粗/斜体/高亮等常用 Markdown 格式，以及复制、注释、翻译、加入词库等快捷操作。
2. **HiWords 生词本系统**：
   - 以 Obsidian Canvas 文件作为单词本存储介质。
   - 在阅读 Markdown / PDF 时自动高亮生词本中的单词。
   - 悬停查看释义、发音、标记掌握状态。
   - 支持 AI 自动释义、本地离线英汉词典自动填充。
   - 提供右侧生词本侧边栏，按文档/已掌握/学习中维度展示词汇。
   - 支持将 Canvas 单词本导出为 CSV。

### 1.2 子目录说明

- **根目录 `src/`**：当前正在开发的主插件源码。
- **`HiWords/`**：HiWords 原始参考实现（独立子项目），包含完整的上游代码、文档与素材。当前主插件大量复用了其架构与模块。
- **`note-bar/`**：疑似旧产物目录，目前只包含 `manifest.json` 与 `styles.css`。
- **`documents/`**：项目规划文档。

## 2. 目录结构

```
note-bar/
├── manifest.json              # Obsidian 插件清单
├── package.json               # npm 脚本与依赖
├── tsconfig.json              # TypeScript 配置
├── esbuild.config.mjs         # 构建配置
├── styles.css                 # 插件样式（工具栏 + HiWords UI）
├── scripts/
│   └── build-dictionary.js    # 从 SQLite 词库生成 dictionary.json
├── src/
│   ├── main.ts                # 插件入口：生命周期、设置、命令注册
│   ├── constants.ts           # 插件常量（颜色、CSS 类名）
│   ├── toolbar/               # 浮动格式工具栏
│   │   ├── ToolbarManager.ts  # 工具栏主控
│   │   ├── formatting-context.ts
│   │   └── components/        # 样式/对齐/格式按钮下拉组件
│   ├── hiwords/               # 生词本系统
│   │   ├── index.ts           # 对外导出
│   │   ├── canvas/            # Canvas 解析与编辑
│   │   ├── card/              # .hiwords 文件解析
│   │   ├── core/              # 词库管理、高亮、掌握状态
│   │   ├── services/          # 本地词典、AI 词典、翻译服务
│   │   ├── ui/                # 弹窗、侧边栏、阅读模式高亮
│   │   └── utils/             # Trie、句子提取、高亮工具、类型等
│   └── utils/                 # 通用工具（editor-formatter、position-calc）
├── HiWords/                   # 上游参考子项目（完整独立插件）
└── documents/                 # 项目规划文档
```

## 3. 核心模块

### 3.1 插件入口 `src/main.ts`

- 加载 `HiWordsSettings` 设置。
- 初始化 `VocabularyManager`、`MasteredService`、`DefinitionPopover`。
- 注册右侧生词本侧边栏视图 `HiWordsSidebarView`。
- 注册 CodeMirror 6 编辑器扩展（`word-highlighter`）和阅读模式后处理器。
- 初始化 `ToolbarManager`，绑定选区变化监听（80ms 轮询）。
- 注册命令：
  - `Note Bar: 导出单词本为 Excel`
- 监听 Canvas 生词本文件的修改/重命名，同步词库状态。

### 3.2 浮动工具栏 `src/toolbar/ToolbarManager.ts`

- 在 `document.body` 中创建固定定位工具栏。
- 监听选区变化，50ms 防抖后显示/隐藏。
- 工具栏包含：
  - 文本样式下拉（标题、正文等）
  - 对齐下拉
  - 格式按钮（加粗、斜体、删除线、高亮颜色等）
  - 翻译按钮 → 弹出 `TranslatePopover`
  - 加入词库按钮 → 打开 `AddWordModal`
  - 注释按钮 → 插入 Markdown 注释
  - 复制按钮 → 复制 `文件路径: 选中文本`
- 支持浅色/深色主题自动切换。

### 3.3 词库管理 `src/hiwords/core/vocabulary-manager.ts`

- 管理所有已启用的 `vocabularyBooks`（Canvas 或 `.hiwords` 文件）。
- 解析文件得到 `WordDefinition[]`，维护多层级缓存：
  - `definitions`: 按文件路径存储单词定义。
  - `wordDefinitionCache`: 按单词/别名的全局定义缓存。
  - `studyItemCache`: 聚合同一单词在不同来源的掌握状态。
- 提供查词、掌握状态更新、Canvas 节点颜色设置、增删改单词接口。
- `addWordToCanvas` 会按**添加日期**自动创建/复用 Canvas 分组。

### 3.4 高亮引擎 `src/hiwords/core/word-highlighter.ts`

- 基于 CodeMirror 6 `ViewPlugin` + `StateField` + `Decoration`。
- 使用 `Trie` 快速匹配单词与别名。
- 支持多种高亮样式：`underline` / `background` / `bold` / `dotted` / `wavy`。
- 可见区域变化时 300ms 防抖重绘，避免大文档卡顿。
- `highlighterManager` 单例负责统一刷新所有编辑器实例。

### 3.5 Canvas 编辑器 `src/hiwords/canvas/canvas-editor.ts`

- 负责直接读写 `.canvas` 文件 JSON。
- `addWordToCanvas`: 按日期分组创建单词节点。
- `updateWordInCanvas` / `deleteWordFromCanvas`: 更新/删除节点。
- `setNodeColor`: 修改节点颜色。
- 新增节点后会调用 `layoutGroupInner` 与 `normalizeLayout` 自动排版。

### 3.6 添加单词弹窗 `src/hiwords/ui/add-word-modal.ts`

- 支持新增/编辑两种模式。
- 提供多选单词本（仅 `.canvas`）、卡片颜色、别名、释义输入。
- 释义区域支持两种自动填充：
  - **本地词库**：基于 `LocalDictionaryService` 离线查询。
  - **AI 释义**：基于 `DictionaryService` 调用 OpenAI/Anthropic/Gemini 等模型。
- 编辑 `.hiwords` 结构化词库时提示只读。

### 3.7 本地词典 `src/hiwords/services/local-dictionary-service.ts`

- 构建时通过 `require('../data/dictionary.json')` 内联打包。
- 数据由 `scripts/build-dictionary.js` 从 `AutoCompleteData.db`（SQLite）生成。
- 条目结构：音标 `p`、中文释义数组 `d`、词形变化数组 `a`。

### 3.8 侧边栏 `src/hiwords/ui/sidebar-view.ts`

- 自定义 ItemView，类型 `hi-words-sidebar`。
- 默认自动打开，监听 `file-open` / `editor-change` / `modify` 事件。
- 扫描当前 Markdown/PDF 文档中的生词，渲染单词卡片。
- 支持学习/已掌握两个标签页，点击发音，展开查看释义。

### 3.9 导出功能 `src/hiwords/ui/export-vocabulary-modal.ts` + `csv-writer.ts`

- 命令：`Note Bar: 导出单词本为 Excel`
- 按添加日期（含“无日期”选项）过滤单词本。
- 输出 UTF-8 BOM CSV，文件名形如 `单词本-export-2026-07-25.csv`。

## 4. 构建流程

```bash
# 安装依赖
npm install

# 开发模式（watch）
npm run dev

# 生产构建：先 TypeScript 类型检查，再 esbuild 打包
npm run build

# 生成离线词典（需先放置 AutoCompleteData.db）
npm run build:dictionary
```

### 4.1 构建配置 `esbuild.config.mjs`

- Entry: `src/main.ts`
- Output: `main.js`（CommonJS）
- Target: `es2018`
- External: `obsidian`, `electron`, CodeMirror 相关包，以及 Node 内置模块。
- Tree-shaking 启用。

### 4.2 词典构建 `scripts/build-dictionary.js`

1. 读取 `src/hiwords/data/AutoCompleteData.db`。
2. 执行 SQL：`SELECT word, phonetic, translation, exchange FROM stardict ORDER BY word`。
3. 解析 `exchange` 字段生成别名（最多 10 个）。
4. 清洗释义（最多保留 5 条）。
5. 输出 `src/hiwords/data/dictionary.json`。

> ⚠️ `src/hiwords/data/` 已被 `.gitignore` 忽略；新克隆仓库需先获取 `AutoCompleteData.db` 并运行 `npm run build:dictionary`，否则构建会因缺少 `dictionary.json` 而失败。

## 5. 关键数据类型

主要类型定义在 `src/hiwords/utils/types.ts`：

- `WordDefinition`: 单词定义（word、definition、aliases、source、nodeId、mastered 等）。
- `WordCard`: 结构化单词卡片（音标、释义、例句、词根、搭配等）。
- `VocabularyBook`: 单词本配置（path、name、enabled、display）。
- `HiWordsSettings`: 全部插件设置（词库列表、高亮样式、AI 服务、侧边栏等）。
- `WordMatch`: 编辑器中匹配到的单词范围与样式信息。

## 6. 开发约定与注意事项

### 6.1 代码组织

- `main.ts` 保持最小化，聚焦生命周期与模块注册。
- UI、核心服务、Canvas 操作、工具函数按目录拆分。
- 常量集中在 `src/constants.ts`，类型集中在 `src/hiwords/utils/types.ts`。

### 6.2 Git 忽略

`.gitignore` 忽略：

- `node_modules/`
- `main.js`、`*js.map`
- `src/hiwords/data/`（离线词典中间产物与生成结果）
- `.DS_Store`、`.superpowers/`

### 6.3 性能

- 生词本加载延迟到 `onLayoutReady`，避免阻塞 Obsidian 启动。
- 编辑器高亮使用防抖与可见区域缓存。
- `VocabularyManager` 维护缓存，仅在设置/词库变化时失效重建。

### 6.4 已知经验

- **Markdown 格式与高亮 HTML**：HTML 标签包裹 Markdown 标记会导致解析失败；格式标记必须放在 HTML 外侧。
- **Canvas 排版**：`normalizeLayout` 必须保留现有日期分组的布局，否则分组会失效。
- **文件夹选择**：Obsidian/Electron 的 `<input webkitdirectory>` 无法返回路径，应优先使用 Electron 的 `dialog.showOpenDialog({ properties: ['openDirectory'] })`。

### 6.5 部署路径（Vault）

插件构建产物（`main.js` / `styles.css` / `manifest.json`）与词典文件（`data/`）部署到以下两个 vault：

- **测试 vault**：`/Users/shengxia/Documents/Obisidian-test-value`
  - 用于功能开发验证，构建后先复制到这里测试。
- **正式 vault（Library）**：`/Users/shengxia/Documents/Library`
  - 实际日常使用的 vault。

**部署目录**：两者的插件目录均为 `.obsidian/plugins/note-bar/`，词典文件在 `.obsidian/plugins/note-bar/data/`（`dictionary.json` 中文词典 + `legal-dictionary.json` 法律词典）。复制时保留用户数据 `data.json`，不要覆盖。

## 7. 近期主要变更（基于项目记忆）

- **auto-fill 分支**：引入 ECDICT 离线英汉词典，后改为 AutoCompleteData.db SQLite 词库；实现本地词典自动填充与 AI 释义。
- **Toolbar 复制按钮**：将原“终端”按钮改为“复制”，复制内容为 `文件路径: 选中文本`。
- **Canvas 按日期分组**：新增单词自动按 `YYYY-MM-DD` 创建/归入 Canvas 分组。
- **点击来源跳转**：在释义弹窗中点击来源可定位到 Canvas 对应节点并进入编辑状态。
- **导出 CSV**：支持按日期过滤导出单词本为 Excel（CSV 格式）。
- **分支 `words-remember`**：当前工作分支，用于后续“记单词”相关功能开发。

## 8. 快速参考

| 文件/目录 | 职责 |
|-----------|------|
| [src/main.ts](src/main.ts) | 插件入口与生命周期 |
| [src/toolbar/ToolbarManager.ts](src/toolbar/ToolbarManager.ts) | 浮动工具栏 |
| [src/hiwords/core/vocabulary-manager.ts](src/hiwords/core/vocabulary-manager.ts) | 词库管理 |
| [src/hiwords/core/word-highlighter.ts](src/hiwords/core/word-highlighter.ts) | 编辑器高亮 |
| [src/hiwords/canvas/canvas-editor.ts](src/hiwords/canvas/canvas-editor.ts) | Canvas 读写与排版 |
| [src/hiwords/ui/add-word-modal.ts](src/hiwords/ui/add-word-modal.ts) | 添加/编辑单词 |
| [src/hiwords/ui/sidebar-view.ts](src/hiwords/ui/sidebar-view.ts) | 生词本侧边栏 |
| [src/hiwords/services/local-dictionary-service.ts](src/hiwords/services/local-dictionary-service.ts) | 离线本地词典 |
| [scripts/build-dictionary.js](scripts/build-dictionary.js) | 生成 dictionary.json |
| [styles.css](styles.css) | 全部 UI 样式 |

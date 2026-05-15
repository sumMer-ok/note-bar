# HiWords 功能集成计划

## 一、项目考察结论

### 1.1 当前项目 (note-bar)
- **定位**：Obsidian 飞书风格浮动格式工具栏插件
- **核心架构**：`main.ts` → `ToolbarManager` → UI 组件（StyleDropdown、AlignDropdown、FormatButtons）
- **交互模式**：选中文本时弹出 toolbar，支持 source/preview 两种模式
- **样式体系**：毛玻璃质感，支持浅色/深色主题，CSS 变量与 Obsidian 主题联动

### 1.2 HiWords 项目
- **定位**：Obsidian 词汇学习插件，支持生词高亮、AI 释义、划词翻译、词库管理
- **核心模块**：
  - **翻译功能**：`TranslationService`（AI 翻译）+ `SelectionTranslatePopover`（划词翻译浮窗）
  - **词库功能**：`AddWordModal`（添加词汇模态框）+ `VocabularyManager`（词汇管理）+ `CanvasEditor`（Canvas 文件操作）
- **依赖深度**：词库功能深度依赖 Canvas 文件系统（解析、编辑、布局）

## 二、集成方案

### 2.1 目录结构
```
src/
  main.ts                          # 插件入口，初始化 HiWords 服务
  constants.ts                     # 现有常量
  toolbar/
    ToolbarManager.ts              # 修改：右侧添加翻译/加入词库按钮
    ...
  hiwords/                         # 新增：HiWords 核心模块
    services/
      translation-service.ts       # AI 翻译服务
      dictionary-service.ts        # AI 词典服务（用于自动填充释义）
    core/
      vocabulary-manager.ts        # 词汇管理器
    canvas/
      canvas-editor.ts             # Canvas 文件编辑器
      canvas-parser.ts             # Canvas 文件解析器
      layout.ts                    # Canvas 自动布局
    card/
      hiwords-parser.ts            # .hiwords 词库解析
      index.ts                     # 导出
    ui/
      translate-popover.ts         # 翻译浮窗（基于 SelectionTranslatePopover 简化）
      add-word-modal.ts            # 添加词汇模态框
    utils/
      types.ts                     # 类型定义
      sentence-extractor.ts        # 句子提取
      pattern-matcher.ts           # 短语模式匹配
      color-utils.ts               # 颜色工具
    i18n.ts                        # 简化版国际化（仅中文/英文）
```

### 2.2 界面集成
在 `ToolbarManager.createToolbarElement()` 中，现有元素为：
`[StyleDropdown] | [AlignDropdown] | [FormatButtons]`

修改为：
`[StyleDropdown] | [AlignDropdown] | [FormatButtons] | [翻译] | [加入词库]`

右侧两个新增按钮：
- **"翻译"按钮**：点击后获取当前选中文本，弹出翻译浮窗
- **"加入词库"按钮**：点击后打开添加词汇模态框，预填充选中文本

按钮样式与现有 `note-bar-format-btn` 保持一致（尺寸、圆角、hover 效果）。

### 2.3 功能集成

#### 翻译功能
1. 用户选中文本后 toolbar 弹出
2. 点击"翻译"按钮：
   - 获取当前选中文本
   - 调用 `TranslationService.translate()`
   - 在选区下方弹出翻译结果浮窗（类似 HiWords 的 translate popover）
3. 翻译服务使用 AI API（OpenAI/Claude/Gemini 兼容）
4. 支持缓存、错误处理、响应清理

#### 加入词库功能
1. 用户选中文本后 toolbar 弹出
2. 点击"加入词库"按钮：
   - 打开 `AddWordModal` 模态框
   - 预填充单词为选中文本
   - 自动提取所在句子作为上下文
3. 模态框支持：
   - 选择目标生词本（Canvas 文件）
   - 选择卡片颜色
   - 输入别名
   - 输入/AI 自动填充释义
4. 确认后写入 Canvas 文件

### 2.4 依赖处理
- **obsidian API**：两个项目共用，无需额外依赖
- **@codemirror/state/view**：HiWords 高亮功能需要，但 toolbar 集成不需要高亮，可去除相关依赖
- **i18n**：HiWords 原生支持 6 种语言，集成时简化为内联字符串，避免引入完整 i18n 系统

### 2.5 设置集成
在 `main.ts` 的插件类中添加设置加载：
- AI 服务配置（apiUrl、apiKey、model、provider）
- 翻译设置（目标语言、提示词）
- 词库设置（生词本列表、卡片尺寸、自动布局）

使用 Obsidian 的 `loadData/saveData` 持久化设置。

## 三、实施步骤

1. **创建分支**：`merge-hiwords`
2. **复制核心文件**：将 HiWords 需要的模块复制到 `src/hiwords/`
3. **简化适配**：
   - 移除对完整 i18n 的依赖，改为内联字符串
   - 移除不需要的高亮、侧边栏、PDF 相关代码
   - 调整类型导入路径
4. **修改 ToolbarManager**：添加翻译和加入词库按钮
5. **修改 main.ts**：初始化 HiWords 服务，注册设置
6. **添加样式**：在 `styles.css` 中添加翻译浮窗和按钮样式
7. **构建测试**：运行 `npm run build` 验证编译通过

## 四、风险与回退

- **风险**：HiWords 的 VocabularyManager 依赖 Canvas 文件系统，如果用户没有 Canvas 生词本，加入词库功能需要引导创建
- **缓解**：在 AddWordModal 中检测无可用生词本时给出提示，引导用户创建
- **回退**：如遇严重问题，可切换回 main 分支，merge-hiwords 分支保留

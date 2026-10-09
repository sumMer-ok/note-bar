# Note Bar

**Obsidian 社区插件** —— 飞书风格划词浮动工具栏 + HiWords 生词本系统，附带 iOS 背词 App 与 macOS 划词助手。

> 仓库：<https://github.com/sumMer-ok/note-bar> ｜ 许可证：MIT ｜ 插件 ID：`note-bar`

---

## 目录

- [这是什么](#这是什么)
- [三个交付物](#三个交付物)
- [核心功能](#核心功能)
  - [浮动格式工具栏](#浮动格式工具栏)
  - [生词本与词库](#生词本与词库)
  - [闪卡复习（FSRS）](#闪卡复习fsrs)
  - [词库数据防护](#词库数据防护)
- [命令列表](#命令列表)
- [安装](#安装)
- [配置](#配置)
- [数据存放位置](#数据存放位置)
- [开发](#开发)
- [项目结构](#项目结构)
- [测试](#测试)
- [已知限制](#已知限制)
- [许可证](#许可证)

---

## 这是什么

Note Bar 是一个「读完就顺手记下来」的阅读工作流插件：

1. 在任意 Markdown / PDF 里**划词** → 弹出飞书风格工具栏，一键排版或**把生词收进词库**；
2. 之后阅读时，词库里的词**自动高亮**，悬停即可看释义和发音；
3. 词库用 **Obsidian Canvas 文件**本身作为存储介质 —— 不用额外数据库，词条直接躺在你看得见的 `.canvas` 文件里，可手工编辑、可版本控制；
4. 到复习点时，用**闪卡复习**按 FSRS 间隔重复算法安排，桌面端与 iOS App 共用同一套学习进度。

三个端（桌面插件 / iOS App / macOS 助手）共用一套数据语义，词库 Canvas 与学习进度通过 iCloud 边车双向同步。

---

## 三个交付物

| 交付物 | 目录 | 技术栈 | 说明 |
|---|---|---|---|
| **Obsidian 插件** | `src/` | TypeScript + esbuild | 工具栏、生词本、高亮、闪卡、收件箱消费、词库防护 |
| **iOS App** | `NoteBarApp/` | SwiftUI + SwiftData + FSRS | 背词、复习、与插件同步学习进度 |
| **macOS 助手** | `NoteBarHelper/` | SwiftPM（零第三方依赖，macOS 14+） | 任意应用划词 → 写入插件收件箱 |

> iOS 端与桌面端**各自独立实现引擎、不共享代码**，同一功能通常要在两端各做一次；改动时必须保证两端行为口径一致。

---

## 核心功能

### 浮动格式工具栏

在编辑器中选中文本即自动弹出（80ms 防抖监听选区变化），提供：

- **文本样式**：标题 H1–H6、正文
- **对齐**：左对齐 / 居中 / 右对齐
- **格式**：加粗、斜体、删除线、高亮颜色
- **快捷操作**：
  - **翻译** —— 选中即翻译（可配置 AI 服务）
  - **加入词库** —— 打开添加单词弹窗，支持多选单词本、别名、卡片颜色
  - **注释** —— 插入 Markdown 注释
  - **复制** —— 复制「文件路径: 选中文本」，方便粘到别处问 AI

工具栏跟随浅色 / 深色主题自动切换。

### 生词本与词库

**词库即 Canvas 文件**。每个词条是一个 Canvas 节点，按**添加日期**自动归入 `YYYY-MM-DD` 分组，新增节点后自动排版（`layoutGroupInner` + `normalizeLayout`）。

- **多词库并行**：可同时启用多个 `.canvas` / `.hiwords` 词库
- **自动高亮**：基于 CodeMirror 6 `ViewPlugin` + Trie 匹配，可见区域变化 300ms 防抖重绘，大文档不卡顿
- **悬停释义**：显示词典释义、法律英语释义、AI 释义、自定义笔记四段，并标注来源（点击可跳转到 Canvas 对应节点）
- **发音**：支持英式 / 美式，可配置 TTS
- **高亮样式**：`underline` / `background` / `bold` / `dotted` / `wavy`
- **高亮渐隐**：按 FSRS stability 让已掌握的词渐渐变淡（可完全淡出），不喧宾夺主
- **右侧生词本侧边栏**：按「当前文档 / 学习中 / 已掌握」维度展示，可展开看释义、点发音、标记掌握

#### 释义分节契约

词典释义、AI 释义、法律英语释义、自定义笔记是 **4 个独立输入框，显示顺序可调**（设置项 `definitionSectionOrder`，默认 词典 → 法律 → AI → 笔记）。

> ⚠️ **格式硬约束**：Canvas 节点文本里**词典释义段必须排在首位且无标题**，其余三段各带 `--- 标题 ---`。任何调序逻辑都要在词典段不在首位时补上 `--- 词典释义 ---`，否则重新解析会被上一节吞掉。此规则已用 24 种排列的 parse→join→parse 测试锁死。

### 闪卡复习（FSRS）

基于 **FSRS**（Free Spaced Repetition Scheduler）间隔重复算法，背词与复习共用一套进度。

- 两种模式：**英→中 / 中→英**
- 快捷键：`Space` 翻转 / `s` 不认识 / `d` 模糊 / `f` 认识
- 3D 翻转 + 滑动切换动画
- 拼写 / 听写练习
- 每组新词上限 `dailyNewWordLimit`（默认 20），两端一致
- 作答档位写 FSRS 进度（`s` / `d` / `lapses` / `dueDate` / `lastReview` / `history`），经 iCloud 边车双向同步

### 词库数据防护

词库是直接被多方写入的 `.canvas` 文件，历史上出过一次截断事故导致词条丢失，因此内置了四层防护：

| 层 | 模块 | 作用 |
|---|---|---|
| ① 校验器 | `sync/canvas-integrity.ts` | JSON 合法性、nodes 数组、必需几何、id 唯一、边不悬空 |
| ② 写入回执 | `addWordToCanvas(..., {awaitWrite:true})` | 不等落盘就算成功 → 条目被消费但词条静默丢失；失败进 `note-bar-inbox.failed.jsonl` + 通知 + 日志 |
| ③ 镜像采纳前校验 | `sync/mirrorer.ts` | 坏副本**绝不覆盖** vault，另存 `.suspect-<时间戳>.canvas` |
| ④ 快照备份 | `sync/backup-service.ts` | 写入后 30 秒防抖 + 每小时巡检，保留新近 20 份 ∪ 30 天每日一份 |

配套 `sync/canvas-audit.ts` 输出 `canvas-audit.log`（时间 / actor / 词库 / 字节前后 / sha1 前后 / 是否通过校验），512KB 轮转。

**体检命令**：命令面板运行「体检所有词库」，一次性校验全部词库并汇报。

---

## 命令列表

| 命令 | 作用 |
|---|---|
| `Note Bar: 开始闪卡复习` | 打开闪卡复习，选择词库开始 |
| `Note Bar: 导出单词本为 Excel` | 按添加日期过滤，导出 UTF-8 BOM CSV |
| `Note Bar: 导入跨应用词条` | 立即消费收件箱（默认自动消费，此命令用于手动触发） |
| `Note Bar: 体检所有词库` | 校验所有词库完整性并汇报 |

---

## 安装

### 手动安装

```bash
# 1. 克隆到 Obsidian 插件目录
cd <你的 vault>/.obsidian/plugins
git clone https://github.com/sumMer-ok/note-bar.git note-bar
cd note-bar

# 2. 安装依赖并构建
npm install
npm run build
```

构建产物是 `main.js`（由 esbuild 从 `src/main.ts` 打包），需与仓库根目录的 `manifest.json`、`styles.css` 一起放在插件目录。

> 💡 **词典**：`npm run build` **不需要词典**（词典是运行时从 vault 读的，不参与打包）。但 clone 后仓库里的 `dictionary.json` 是个 1.4KB 的 LFS 指针，直接用会查不到词。
> 想离线查常用词，复制仓库自带的子集即可：
> ```bash
> mkdir -p <你的 vault>/.obsidian/plugins/note-bar/data
> cp src/hiwords/data/dictionary.lite.json <你的 vault>/.obsidian/plugins/note-bar/data/dictionary.json
> ```
> 需要完整 363MB 词库的话，需自备词库源文件 `AutoCompleteData.db` 放到 `src/hiwords/data/` 后执行 `npm run build:dictionary`。

启用插件：Obsidian → 设置 → 第三方插件 → 关闭安全模式 → 启用 Note Bar。

---

## 配置

设置项位于 Obsidian 设置 → Note Bar，主要分组：

**词库**
- 启用/停用词库（多个 `.canvas` / `.hiwords`）
- 卡片宽高、自动排版开关

**高亮**
- 高亮开关与样式（`underline`/`background`/`bold`/`dotted`/`wavy`）
- 高亮渐隐开关与透明度下限
- 范围模式：全部 / 排除指定路径 / 仅指定路径

**词典**
- 中文离线词典开关与文件路径
- 法律词典（Black's Law Dictionary）开关与文件路径
- AI 释义：provider / apiUrl / apiKey / model / extraParams，以及提示词（含 `{{word}}`/`{{sentence}}` 占位）

**复习**
- 闪卡设置、每组新词上限
- 拼写/听写每次词数
- 自动毕业稳定性阈值（FSRS stability ≥ 阈值时自动置 graduated）
- 淘汰候选天数阈值

**数据**
- 手机同步（iOS App）
- 跨应用加词收件箱开关与目录
- 词库快照备份目录

> 💡 **日志纪律**：AI 相关日志**只记录「apiKey=已配置」与否，绝不打印 Key 本身**。

---

## 数据存放位置

| 数据 | 路径 |
|---|---|
| 词库（正文） | `<vault>/Words/*.canvas` |
| 插件设置 / 学习进度 | `.obsidian/plugins/note-bar/data.json` |
| 离线词典 | `.obsidian/plugins/note-bar/data/dictionary.json`、`legal-dictionary.json` |
| 收件箱（macOS 助手写入） | 设置里 `crossAppInbox.syncDir` 指定的目录；为空时回落到 `mobileSync.syncDir`，两者都为空则不消费 |
| 词库快照备份 | 设置里配置的备份目录（建议放在 vault 外、iCloud 外） |

---

## 开发

```bash
git clone https://github.com/sumMer-ok/note-bar.git
cd note-bar
npm install

# 开发模式（watch）
npm run dev

# 生产构建：TS 类型检查 → 生成 AI prompt → esbuild 打包
npm run build

# 生成离线词典（需先放置 AutoCompleteData.db 到 src/hiwords/data/）
npm run build:dictionary

# 生成法律词典
node scripts/build-legal-dictionary.js
```

### iOS App

工程由 **xcodegen** 管理（`project.yml` 是唯一源头）：

```bash
xcodegen generate                 # 新增源文件后必须重新生成才会进 target
xcodebuild test -project NoteBarApp.xcodeproj -scheme NoteBarApp \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:NoteBarAppTests
```

### macOS 助手

```bash
cd NoteBarHelper
swift build
swift test          # 真实词典用例需设 NOTEBAR_TEST_DICTIONARY
./scripts/package.sh   # 产物 dist/NoteBarHelper.app（LSUIElement，无 dock 图标）
```

---

## 项目结构

```
note-bar/
├── manifest.json              # Obsidian 插件清单
├── main.js                    # 构建产物（gitignored）
├── styles.css                 # 全部 UI 样式
├── esbuild.config.mjs         # 构建配置
├── project.yml                # iOS 工程唯一源头（xcodegen）
├── src/
│   ├── main.ts                # 插件入口：生命周期、设置、命令注册
│   ├── constants.ts           # 常量
│   ├── toolbar/               # 浮动格式工具栏
│   ├── hiwords/               # 生词本系统
│   │   ├── core/              # 词库管理、高亮、掌握状态、FSRS、闪卡队列
│   │   ├── canvas/            # .canvas 读写与排版
│   │   ├── card/              # .hiwords 结构化词库解析
│   │   ├── services/          # 本地词典、AI 词典、翻译
│   │   ├── ui/                # 侧边栏、弹窗、阅读模式高亮
│   │   └── utils/             # Trie、句子提取、类型
│   ├── sync/                  # 手机同步 + 跨应用收件箱 + 词库防护
│   └── utils/                 # 编辑器排版、位置计算
├── NoteBarApp/                # iOS App（SwiftUI）
├── NoteBarHelper/             # macOS 划词助手（SwiftPM）
├── scripts/                   # 构建、词典生成、表单回归等
└── tests/                     # 插件侧集成测试
```

---

## 测试

```bash
# 插件：esbuild 把 tests/**/*.test.ts 打包后用 node --test 跑
npm test
```

测试风格为 `node:test` + `node:assert/strict`，数据用例使用 `mkdtemp` 临时目录。集成测试通过 `tests/stubs/obsidian.ts` 里的最小 obsidian 桩运行（由 `scripts/build-tests.mjs` 用 esbuild alias 把 `obsidian` 指向桩）。

**可测性约定**：`src/sync` 与 `hiwords` 下的纯逻辑模块**不得 import `obsidian`**（含间接引入），引用宿主类型时只用 `import type` 并通过依赖注入解耦，否则 `npm test` 无法运行。

其他端：

```bash
cd NoteBarHelper && swift test              # 助手
xcodebuild test ... -only-testing:NoteBarAppTests   # iOS
node NoteBarHelper/scripts/check-form-js.mjs   # 助手表单回归（JS 断言 + 样式护栏）
```

---

## 已知限制

- **全量离线词典不在仓库中**：363MB 的 `dictionary.json` 超过 GitHub 单文件 100MB 限制，仓库里只是一个 LFS 指针，clone 后**不能用**。但这不影响构建——词典是插件**运行时**从 vault 读的，不参与打包。仓库另附 `dictionary.lite.json`（1.4 万常用词 / 1.8MB），把它复制到 `.obsidian/plugins/note-bar/data/dictionary.json` 即可离线查常用词；需要全量请自备 `AutoCompleteData.db` 并执行 `npm run build:dictionary`。
- **`HiWords/`、`documents/`、`references/`、`release/`、`docs/` 不在仓库中**：这些是被 `.gitignore` 排除的本地目录（上游参考实现、设计文档、构建产物等）。
- **iOS 端运行依赖 macOS + Xcode**：仅能在 Mac 上构建模拟器版本。
- **macOS 助手需要辅助功能权限**：首次运行或更换签名后，需在「系统设置 → 隐私与安全性 → 辅助功能」重新授权，否则取词失败（会自检并引导授权）。

---

## 许可证

[MIT](LICENSE) © 2026 sumMer-ok
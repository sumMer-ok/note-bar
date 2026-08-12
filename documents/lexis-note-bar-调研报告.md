# Lexis 与 Note Bar (HiWords) 项目对比调研报告

> 调研日期：2026-08-12
> 调研对象：
> - **Lexis**：`references/obsidian-lexis/`（v1.6.1，纯 JS 单文件插件 + Chrome 扩展）
> - **Note Bar / HiWords**：本仓库 `src/`（TypeScript + esbuild 构建）
>
> 报告基于两个项目源码的逐文件精读（Lexis main.js 2720 行、styles.css 609 行、browser-extension 1243 行；Note Bar src/ 全部 30 个 TypeScript 文件约 9000 行），所有结论均可对照代码验证。

---

## 一、项目定位与理念

### 1.1 Lexis：全方位个人词典

Lexis 的定位已经从"背单词工具"演化为**「全方位个人词典」**——词库文件夹里每个笔记标题就是一个词条，可以是任何语言的单词、术语、人名。其设计有完整的理论支撑（README 中给出四条依据）：

1. **延展心智**（Clark & Chalmers）：随时可得、自动查阅的外部存储功能上就是记忆本身 → 词典要"一直在身边"，悬浮即查而非翻查。
2. **注意假说 + 文本增强研究**：被视觉增强的词持续吸引注意且学习效果显著更好 → 永久全局高亮。
3. **偶然习得研究**：单词靠反复相遇学会，单次查词几乎无贡献 → 高亮是工程化的"再相遇"。
4. **测试效应 + 间隔效应**：高亮只负责"注意到"，"记住"要靠提取练习 → FSRS 间隔重复。

并明确承诺边界："不承诺读得更快，不承诺不费力的学习"。

### 1.2 Note Bar：格式工具栏 + 生词本

Note Bar 是"飞书风格浮动格式工具栏 + HiWords 生词本"的复合插件。定位更偏向**工具型**：选中文本即弹出格式化工具栏（标题/对齐/加粗/高亮/翻译/加词/注释/复制），生词本以 **Canvas 文件**为存储介质，提供本地词典（ECDICT）、AI 释义/翻译、SM-2 闪卡复习、拼写练习、侧边栏与 CSV 导出。

### 1.3 定位差异结论

| | Lexis | Note Bar |
|---|---|---|
| 核心哲学 | 词汇是基础设施，词典是记忆的假肢 | 生词本是学习工具，配合编辑器工具栏 |
| 服务对象 | 任何领域术语（语言无关） | 英语学习为主（含法律术语支持） |
| 存储介质 | 文件夹 md 笔记（标题=词条） | Canvas JSON 文件（节点=单词） |
| 学习闭环 | 阅读中注意 → 悬停查 → 相遇记账 → FSRS 复习 | 划词加词 → 本地/AI 释义 → SM-2 闪卡 → 拼写 |

---

## 二、技术架构对比

### 2.1 Lexis：单文件类内聚架构

- **纯 JS 单文件**（`main.js` 2720 行），零构建、零 npm 依赖，FSRS 算法内联实现。核心是 `class LexisPlugin extends Plugin`，所有功能（索引、高亮、悬浮卡、复习、HTTP 桥接、设置）均为该类方法。
- 类外另有 5 个独立类：`LexisAliasPicker`（FuzzySuggestModal）、`LexisRestoreModal`、`LexisReviewView`（ItemView）、`LexisHomeView`（ItemView）、`LexisSettingTab` + `PathSuggest`。
- 顶部集中 60 行小工具函数（`escapeRe`/`boundedSource`/`escHtml`/`cssColorToHex`/日期工具）。
- 生命周期：`onload()` 整体 try/catch；`onLayoutReady` 才首次建索引（避免阻塞启动）；`onunload()` 落盘 encounters、清理定时器与 DOM 钩子。
- 事件监听：`file-open`（相遇记账）、`file-menu`（归档/常驻右键）、`editor-menu`（划词添加）、`vault create/delete/rename`（800ms 防抖重建）、`metadataCache changed`、document 级 mouseover/click/scroll 事件委托（悬浮卡/药丸）。

### 2.2 Note Bar：模块化 TypeScript 架构

```
src/
├── main.ts                  # 入口 + 设置页（935 行）
├── constants.ts             # CSS 类名与颜色常量
├── toolbar/                 # 浮动格式工具栏（ToolbarManager + 4 个组件）
├── utils/                   # editor-formatter、position-calc
└── hiwords/
    ├── canvas/              # Canvas 读写/排版/导出/已掌握分组
    ├── card/                # .hiwords 结构化词包解析
    ├── core/                # vocabulary-manager / word-highlighter / mastered-service / flashcard-algorithm / flashcard-queue
    ├── services/            # local-dictionary / dictionary-service(AI) / translation-service(AI)
    ├── ui/                  # 侧边栏、10 个弹窗/视图/渲染器
    └── utils/               # trie / pattern-matcher / tts / csv-writer 等
```

- 依赖方向清晰：`core` 不依赖 `ui`，`utils` 无业务依赖。
- 启动：同步初始化服务 → 注册编辑器扩展/阅读模式后处理器 → `onLayoutReady` 延迟加载词库与词典 → 80ms 选区轮询驱动工具栏。
- 事件：`vault modify`（Canvas 修改记账）、`active-leaf-change`（离开 Canvas 时同步）、`rename`、自定义 workspace 事件（`hi-words:mastered-changed` 等）。

### 2.3 与 Obsidian API 集成面

| 集成点 | Lexis | Note Bar |
|---|---|---|
| 阅读模式高亮 | `registerMarkdownPostProcessor` → `wrapMatchesInElement`（TreeWalker） | `registerReadingModeHighlighter`（TreeWalker） |
| 实时预览高亮 | CodeMirror 6 `ViewPlugin.fromClass` + `visibleRanges` | CodeMirror 6 `StateField` + `ViewPlugin` + `Decoration.mark` |
| PDF 高亮 | pdf.js `.textLayer` 隐形代理 + `.lexis-pdf-hl-layer` 荧光笔矩形层 | 仅侧边栏 `extractPDFText()` 提取词频，无 PDF 高亮 |
| EPUB | epub.js iframe 注入高亮 | 无 |
| 代码块 | `registerMarkdownCodeBlockProcessor`（`lexis`/`lexis-home`/`lexis-heatmap`） | 无 |
| 设置 | `loadData/saveData` + frontmatter + sidecar JSON | `loadData/saveData` + Canvas JSON |
| 本地服务 | Node `http` 127.0.0.1 桥接（浏览器扩展用） | 无 |
| 浏览器 | Chrome MV3 扩展（content.js/background.js/popup） | 无 |

---

## 三、核心功能模块对比

### 3.1 高亮引擎

**Lexis（`buildMatcher` + 三套渲染路径）**
- 词边界 `boundedSource`：**语言无关**——仅当词首尾是 `[A-Za-z0-9_]` 才加 ASCII 负向断言；中日韩不加（`\b` 只认 ASCII 的坑）。
- 巨型正则：过滤单字母英文词但保留单个汉字 → 剔除 retired → 按长度降序拼接。
- 三处渲染：阅读模式（整篇 TreeWalker）、实时预览（只扫 `visibleRanges`，`docChanged || viewportChanged` 才重建）、PDF（两层架构：隐形 `.lexis-hl` span 做事件代理 + 独立矩形层画荧光笔）。
- **自高亮排除**：`_selfKeysByPath`——词条笔记里出现自己的标题/别名不高亮自己，但其他词照常。

**Note Bar（Trie + 可见区域缓存）**
- `buildWordTrie()`：word + aliases 全部插入 Trie，前缀树 O(n×k) 匹配，含 CJK 词边界判断。
- 支持 `...` 通配符短语（`patternDefinitions` + `findPatternMatches` 跨句匹配，`segments` 分段装饰）。
- 300ms 防抖 + 只遍历 `visibleRanges` + 按区域 key 缓存匹配结果。
- `HighlighterManager` 单例统一 `refreshAll()`。

> 差异：Lexis 覆盖端更多（阅读/预览/PDF/EPUB/网页）且高亮随记忆**渐隐**；Note Bar 的 Trie 匹配在算法上优于巨型正则，但**高亮恒定无渐隐**，且 `removeOverlaps` 是 no-op（重叠匹配未真正去重）。

### 3.2 间隔重复算法（关键差异）

| | Lexis | Note Bar |
|---|---|---|
| 算法 | **FSRS-5**（19 参数 DSR 模型） | **SM-2**（1987 经典） |
| 记忆状态 | stability（稳定性）+ difficulty（难度） | ef（易度因子）+ interval（间隔）+ reps |
| 调度 | `initStability`/`nextRecallStability`/`nextForgetStability`/`retrievability(t,s)` 完整 DSR 公式 | `ef + (0.1 - (5-q)*(0.08+(5-q)*0.02))`，间隔 1/6/ef 倍 |
| 学习阶段 | 新卡直接进长期调度（一词一文件，简化学习步骤） | 学习阶段（newWordSteps 步进）→ 毕业 → review |
| 遗忘处理 | `nextForgetStability` + `lapses++` | q<3 时 reps 归零、间隔重置 1 天 |
| 掌握判定 | 无自动掌握；用户手动 archived/retired | `reps>=3 && ef>=2.5` 自动标记 mastered 同步 Canvas |
| 数据位置 | 笔记 frontmatter `lexis-s/d/due/last/reps/lapses` | `data.json` 的 `studyProgress` |

> FSRS-5 是基于大规模复习日志拟合的现代算法，其 stability/difficulty 双维模型对复习排期优化的效果显著优于 SM-2 的经验公式，这是两者**最核心的差距**。

### 3.3 高亮渐隐 + 词条生命周期（Lexis 独有）

- **渐隐** `fadeAlphaFor`：`progress = s/(s+20)`，新词全强度，随 FSRS stability 增长线性变淡到 `fadeFloor`（默认 0.25）下限。用 stability 而非 retrievability（后者随日历天天变会"没事自己变淡"）。归档词 `text-decoration:none` 视觉消失但保留隐形 span 悬停可查。
- **生命周期状态**：frontmatter `lexis-status: archived|retired` + `lexis-pinned`。归档=退出高亮+复习但可悬停；淘汰=连匹配都剔除（更彻底）；常驻=永不进淘汰候选。**红线：任何功能不得直接改写 FSRS 内部参数，状态只叠加在算法之上**。
- **淘汰法庭** `buildRetireCandidates`：硬条件筛子（非 pinned/archived/retired + 入库 ≥90 天 + 距上次相遇 ≥90 天），只摆证据不打分，淘汰/留下/已掌握由用户判决。

### 3.4 相遇记账 + hover 回流（Lexis 独有，核心学习信号）

- **三种强相遇**：悬停查释义、划词加出处、打开词条笔记 → 写入 sidecar `encounters.json`（不写 frontmatter，避免刷花 git 历史）。
- **防抖落盘**：内存改 + 1.5s setTimeout 落盘；`onunload` 补一次即时保存。
- **(词+类型) 60 秒冷却**：防止鼠标晃出晃入虚高计数。
- **被动相遇**：高亮装饰实际渲染即计一次，按"词+当天" Set 去重（热路径仅一次 `Set.has`），Obsidian 与网页端各自去重。
- **hover 回流** `hoverFeedback`：悬停=一次失败的提取；若 `due > today + N`（默认 3 天）则把 due 拉到今天——**只动 due，绝不伪造复习评分、不改 stability/difficulty**。

### 3.5 复习 UX

| | Lexis | Note Bar |
|---|---|---|
| 卡面 | 单词→整篇 / **出处填空（cloze）** | 英→中 / 中→英 + **拼写练习** |
| 操作 | 重来/较难/记得/简单 + 预测间隔预览 + **撤销(Z)** + 跳过 | 忘记/模糊/记得 + 3D 翻转动画 + 左右滑出 |
| 进度可视化 | 主页统计 + **复习热力图**（18 周）+ 遗忘曲线 SVG | 学习/已掌握标签页 + 今日待复习计数 |
| 入口 | 主页视图/命令/ribbon/代码块 | 侧边栏按钮 → 词库选择器（开始学习/复习） |
| 数据 | 复习日志 `reviewLog` 供热力图 | history 最近 50 条 |

### 3.6 内容与词典

| | Lexis | Note Bar |
|---|---|---|
| 释义来源 | **笔记本体**（模板：意思/词根/同根词/近义词/形近词/辨析/出处），悬浮卡整篇渲染 | 本地 ECDICT 词典自动填充 + AI 释义（OpenAI/Claude/Gemini 三适配器）+ 法律词典 |
| 出处收集 | `occ` 代码块：全文搜索出处 + 去重收藏（OED citation slips 模式） | 加词时自动带上下文句子 |
| 词条关系 | `rel` 代码块：近义词/同根词/形近词/辨析双向关系（`[[link]]` 一边写两边显） | 无 |

### 3.7 划词添加与浏览器扩展

- **Lexis**：Obsidian 内选词药丸（`maybeShowSelPill`，PDF 加词自动带页码出处）；**Chrome 扩展**网页高亮 + 悬浮卡 + 划词回写 vault（经 127.0.0.1 本地桥接，token 鉴权，数据不出本机；离线静默丢弃弱信号）。扩展端悬浮卡 HTML 由 Obsidian 端 `bridgeFullHtml` 渲染（MarkdownRenderer + `finishRenderMath()` flush MathJax）后下发。
- **Note Bar**：工具栏"加入词库"按钮 + AddWordModal（多选词库/卡片颜色/别名/自动填充）。

---

## 四、技术栈选型对比

| 维度 | Lexis | Note Bar |
|---|---|---|
| 语言 | 纯 JavaScript | TypeScript |
| 构建 | **无构建**（`node --check` 验证语法） | esbuild（`npm run build`，tsc 类型检查） |
| 依赖 | 零 npm 依赖（FSRS 内联） | obsidian + @codemirror/view 等 |
| 算法库 | 自研内联 FSRS-5 | 自研内联 SM-2 |
| 存储 | md 笔记 frontmatter + sidecar JSON + data.json | Canvas JSON + data.json（词典独立文件） |
| 词典 | 无（纯笔记驱动） | ECDICT（`dictionary.json` 独立文件运行时懒加载）+ Black's Law 法律词典 |
| 代码块渲染 | MarkdownRenderer + MathJax flush | 无 |
| 浏览器端 | MV3 Chrome 扩展（内容脚本 + background 桥接） | 无 |

选型评价：
- **Lexis 的"无构建"**是刻意的用户偏好（怕插件臃肿、怕更新覆盖魔改、数据都在自己 md 里），换来零依赖与即时可改，代价是单文件强耦合、无类型、无回归测试。
- **Note Bar 的 TS + 构建**换来模块化与类型安全，代价是构建链路与部署复杂度（需部署 main.js/styles.css/manifest + data/ 词典文件到两个 vault）。

---

## 五、性能设计对比

| 机制 | Lexis | Note Bar |
|---|---|---|
| 启动 | `onLayoutReady` 才建索引 | `onLayoutReady` 才加载词库+词典 |
| 高亮 | 巨型正则 + 实时预览只扫 visibleRanges | Trie 前缀树 + visibleRanges + 区域缓存 |
| 重建防抖 | 800ms（vault 事件） | 1000ms Canvas 写入合并 |
| 词典 | 无 | 懒加载 + `cnLoadPromise` 防并发，但首查需 JSON.parse 大文件 |
| 相遇记账 | 1.5s 落盘防抖 + 热路径 Set.has | — |
| 副作用 | 悬浮卡 220ms 消失防抖；PDF rAF 合并 + 180ms ResizeObserver 防抖 | 侧边栏 500ms 交互冷却 + 渲染防抖 |
| 常驻开销 | — | **80ms 全局选区轮询**常驻 |

> Note Bar 的常驻 80ms 轮询与整文件 `JSON.stringify` 重写 Canvas 是潜在性能/竞态热点；Lexis 的热路径开销被严格控制（"记账不得拖慢渲染"是设计红线）。

---

## 六、用户体验设计对比

- **Lexis**：全中文 UI；悬浮卡按笔记 `####` 结构渲染（模板驱动不硬编码）、空段自动隐藏、标题可跳转；复习视图预测下次间隔预览、撤销、跳过、tag 过滤；主页统计+热力图+集合筛选；8 个命令 + 2 个 ribbon；设置 20+ 项分组、PathSuggest 模糊建议；网页端 toast/深色模式。
- **Note Bar**：工具栏"选中即现"（80ms 轮询+50ms 防抖）、点击栏内不破坏选区；加词弹窗记忆上次选择；3D 翻转 + 滑出动画 + Toast；中→英模式自适应字号、毛玻璃 blurDefinitions；拼写练习绿/红反馈；快捷键（空格/s/d/f、回车提交拼写）。

---

## 七、优缺点总结

### 7.1 Lexis

**优点**
1. 设计哲学克制且有理论依据（渐隐/相遇/淘汰均有研究支撑，且诚实声明边界）。
2. 数据主权在用户：进度在 frontmatter、相遇在 sidecar JSON，可见可备份可被 dataview 查询。
3. FSRS-5 算法现代；hover 回流与复习调度严格分离（不伪造评分）。
4. 多渲染端统一（阅读/预览/PDF/EPUB/网页）同一套颜色优先级心智。
5. 兼容迁移意识强（设置迁移、legacy 标题双认、一次性迁移命令）。

**缺点**
1. 单文件 2720 行强耦合，类字段 20+ 扁平挂载；`lexisBlockHtml` 与 `renderLexisBlock`、`renderNoteInto` 与 `bridgeFullHtml` 两套近似逻辑需同步维护。
2. 无 TypeScript、无回归测试套件。
3. 巨型正则匹配，词库上万时构造与回溯代价高（自认可换 trie）。
4. 插件级全局 UI 单例（`_popover`/`_selPill`），多窗口/分屏会互相顶掉。
5. 桥接安全面：token 明文存 data.json、无速率限制、/ping 泄露 vault 名。

### 7.2 Note Bar

**优点**
1. 模块化 + TypeScript 类型安全，分层清晰可维护。
2. 功能丰富：本地词典（ECDICT）+ AI 释义/翻译、拼写练习、3D 闪卡、双模式复习、CSV 导出。
3. Canvas 词库可视化（日期分组/掌握分组/节点颜色）。
4. 容错链健壮：AI JSON 5 层解析降级、请求重试退避、导出双路径、TTS 单例。
5. Trie 匹配算法优于正则。

**缺点**
1. **SM-2 算法落后**，无遗忘曲线模型，是学习体验的最大短板。
2. Canvas 存储：全量重写 + 几何启发式分组（重叠面积≥50% 判断）脆弱 + 临时 ID 延迟替换存在崩溃不一致风险。
3. 高亮恒定无渐隐，显著性随时间稀释；无相遇记账/hover 回流等阅读信号。
4. 无词条生命周期（毕业/归档/淘汰），已掌握词无退出机制。
5. 词典运行时整文件 JSON.parse，首查有卡顿风险；80ms 轮询常驻。
6. `removeOverlaps` no-op，重叠匹配未去重。

---

## 八、综合结论

两个项目方向互补而非重复：

- **Lexis 赢在"学习科学"**：FSRS-5、渐隐、相遇记账、hover 回流、淘汰法庭——构成一个以真实阅读行为为信号源的完整学习闭环，有严谨的理论支撑。
- **Note Bar 赢在"工具完备性"**：本地/AI 词典、拼写练习、双模式闪卡、可视化 Canvas 词库、编辑器集成（工具栏）——学习材料更丰富、操作更顺手。

**改进路径清晰**：以 Note Bar 的工程基础（TS 模块化/Trie/词典体系/UI 完成度）承载 Lexis 的学习科学内核（FSRS-5/渐隐/相遇/生命周期），辅以现有模块的缺陷修复，即可获得"工具完备 + 科学有效"的语言学习体验升级。详见《项目改进报告》。

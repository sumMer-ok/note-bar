# 项目改进报告：语言学习体验升级

> 制定日期：2026-08-12
> 依据：《lexis-note-bar-调研报告》（2026-08-12）
> 改进基线：Note Bar 当前 main 分支（SM-2 + Canvas 词库 + Trie 高亮 + 本地/AI 词典）
> 参考借鉴：Lexis v1.6.1（FSRS-5 + 渐隐 + 相遇记账 + 生命周期）
> 当前工作分支建议：基于 `main` 新建 `language-learning-v2` 分支实施

---

## 一、改进目标

**总目标：将 Note Bar 从"生词工具"升级为"科学有效的语言学习闭环"**——以现有工程基础（TypeScript 模块化、Trie 高亮、词典体系、UI 完成度）承载 Lexis 的学习科学内核，让用户在真实阅读中获得持续注意、高效记忆与合理退出。

三个子目标（对应学习体验的三条主线）：

| 目标 | 内容 | 度量方式 |
|---|---|---|
| G1 记得住 | 复习算法从 SM-2 升级为 FSRS-5，复习排期更精准 | 对比同批词的到期间隔分布、复习次数与遗忘率 |
| G2 遇得到 | 阅读中高亮随记忆渐隐 + 相遇记账 + hover 回流，让"读过的文本自动变成复习材料" | 每篇文档的被动相遇计数、hover 回流生效次数 |
| G3 学得完 | 词条生命周期（毕业/归档/淘汰）+ 学习数据可视化（热力图/主页），避免词库无限膨胀 | 淘汰候选列表、热力图覆盖率、词库清理动作数 |

---

## 二、改进范围

### 2.1 范围界定

**纳入**（本次改进）：
1. 核心算法层：FSRS-5 调度替换 SM-2（含数据迁移）。
2. 高亮层：渐隐、语言无关词边界、自高亮排除、重叠去重修复。
3. 学习信号层：相遇记账（sidecar JSON）、hover 回流、被动相遇。
4. 生命周期层：毕业/归档/淘汰状态 + 迁移命令 + 淘汰候选 UI。
5. 数据可视化层：复习热力图 + 复习主页视图 + 遗忘曲线代码块。
6. 复习体验层：出处填空（cloze）卡面、撤销、跳过、间隔预览。
7. 稳定性修复：Canvas 写入竞态、词典首查卡顿、80ms 轮询优化。

**不纳入**（明确排除，避免范围膨胀）：
- 浏览器扩展（Chrome MV3 本地桥接）——列为远期独立计划。
- EPUB 阅读器高亮——Obsidian 生态依赖第三方阅读器，收益不确定。
- 更换 Canvas 存储介质为 md 文件夹——影响面过大，属架构级决策，单独立项评估。
- 重构现有模块分层/代码风格——仅在改动触及处顺手修正。

### 2.2 实施阶段划分

| 阶段 | 主题 | 对应目标 | 依赖 |
|---|---|---|---|
| P1 | FSRS-5 算法升级 + 数据迁移 | G1 | 无 |
| P2 | 高亮渐隐 + 语言无关边界 + 自高亮排除 | G2 | P1（渐隐依赖 stability） |
| P3 | 相遇记账 + hover 回流 + 被动相遇 | G2 | P1 |
| P4 | 词条生命周期（毕业/归档/淘汰）+ 淘汰候选 | G3 | P1+P3（淘汰依赖相遇数据） |
| P5 | 复习主页 + 热力图 + 遗忘曲线 + cloze 卡面 | G3 | P1 |
| P6 | 稳定性与性能修复（贯穿） | 全部 | 独立 |

---

## 三、融合设计定案（2026-08-12 讨论确认）

### 3.1 融合总体原则

**分层融合，不推翻现有**：

```
UI 层（现有，复用+局部扩展）：工具栏 / 侧边栏 / 定义弹窗 / 闪卡复习 / 拼写练习
学习闭环层（新增）：FSRS-5 调度 / 相遇记账 / hover 回流 / 生命周期状态机
存储层（保留）：Canvas 词库 + data.json + 新增 encounters.json
内容层（保留）：本地 ECDICT / AI 释义翻译 / 音标 / 出处句子 / 关系词
```

Lexis 功能分两类处理：
- **介质无关的**（算法、学习信号、生命周期状态机）→ 直接替换移植。
- **依赖 md 笔记介质的**（代码块渲染、frontmatter、词条文件）→ 不照搬，适配到现有 Canvas + 弹窗体系（如出处/相关词/遗忘曲线渲染进定义弹窗，而非 ` ```lexis ` 代码块）。

### 3.2 关键融合设计决策（已确认）

| # | 决策 | 选择 | 落点 |
|---|---|---|---|
| 1 | 归档/淘汰的 Canvas 视觉表达 | 移入新增"已归档"分组 | 扩展 `mastered-group-manager.ts` 支持多分组类型（Mastered/已归档）；归档与淘汰词均移入已归档分组，淘汰额外从匹配中剔除；分组内仅展示不复习 |
| 2 | 毕业触发 | stability 阈值自动毕业 | 保留自动判定，`reps>=3 && ef>=2.5` 换成 `s >= 阈值`（默认值待实测，设置可调）；毕业仍走现有 Canvas 掌握同步链路（移入 Mastered 分组/变绿） |
| 3 | 渐隐与已掌握过滤合并 | 单开关"渐隐"替代硬过滤 | 设置里"已掌握词过滤"改为"渐隐"开关；fadeFloor 可调到 0 实现已掌握词完全不可见（与 Lexis 毕业一致，悬停入口保留） |
| 4 | 出处/关系词数据来源 | 节点文本按模板分段 | 升级 CanvasParser 识别 `#### ` 分段；风险规避见 3.3 |

### 3.3 决策 4 风险规避（Canvas 节点模板分段）

| 风险 | 对策 |
|---|---|
| R1 解析兼容性：现有 `parseFromText` 把"首行=单词、第二行 `*alias*`=别名、其余=释义"，标题行会混进释义 | 解析器升级为按行匹配 `^####\s+` 开新段，段内行归入该段；**无分段标题的旧节点保持"整段释义"不变**（向后兼容），仅新写/编辑的词模板化 |
| R2 Canvas 节点内 `####` 的 markdown 渲染效果未验证 | **实施前先在测试 vault 手动创建带 `####` 段落的节点验证渲染**，确认无误再动代码 |
| R3 本地词典/AI 自动填充冲突（AI 输出自带标题污染分段） | 自动填充**只写入 `#### 意思` 段**而非整个节点文本；AI 提示词明确要求输出纯文本释义、禁止 markdown 标题 |
| R4 Canvas 全量重写（`vault.process` 整文件 JSON.stringify）覆盖用户手改 | 插件**只负责读解析 + 通过添加弹窗写入**，写前先读文件再合并，绝不整体改写已有节点文本；用户手动分段内容原样保留 |
| R5 旧节点无分段 | 不做强制迁移；解析器对无分段节点降级（现状不变），可选一次性迁移命令（整段释义包进 `#### 意思`），迁移前展示 diff 确认 |
| R6 弹窗需按段渲染 | 解析器输出**结构化分段** `{section, lines}[]`；弹窗按段渲染：意思→正文、出处→逐条列表（走 MarkdownRenderer）、近义词→chip 样式 |

**节点模板约定**（与 Lexis 模板对齐）：

```
knowledge
*知识, know*

#### 意思
（本地词典/AI 填充的释义）

#### 出处
- 上下文句子1
- 上下文句子2

#### 近义词
- comprehension
- understanding
```

### 3.4 联动与实施顺序提醒

- 决策 1 与决策 4 **均改动 CanvasParser/节点操作**，建议同阶段实施，避免两次触碰 Canvas 读写链路。
- 决策 2 的 stability 阈值默认值需实测：`initStability(good)≈1`，复习几轮后可达 10-30；建议默认取中值（如 15）并在设置中可调。
- 决策 3 中 fadeFloor=0 时与 Lexis"毕业完全不高亮"效果一致，悬停入口保留。

---

## 四、预期成果

**功能成果**：
- 复习调度基于 FSRS-5 DSR 模型：新词直接进长期调度，stability/difficulty 双维追踪，遗忘走 `nextForgetStability`。
- 高亮强度随记忆稳定性渐隐（新词全强度 → 熟词淡至可调下限），阅读高亮从"墙纸"变回"指示器"。
- 真实阅读行为进入学习闭环：悬停/加词/打开计强相遇，高亮渲染计被动相遇，悬停远期词自动拉近到期日。
- 词条生命周期完整：毕业（退出高亮与复习仍可悬停查）、归档、淘汰（退出匹配）、常驻；淘汰候选列表只摆证据、用户判决。
- 学习数据可视化：复习热力图（近 18 周）+ 复习主页视图 + 遗忘曲线代码块。
- 复习体验补全：出处填空卡面、撤销（Z）、跳过、评分间隔预览。
- 拼写练习、中→英模式、本地/AI 词典等现有能力全部保留并兼容新算法。

**数据成果**：
- 复习进度从 `data.json` 的 `studyProgress`（SM-2）迁移到词条结构化字段（FSRS `s/d/due/last/reps/lapses`），可被 dataview/导出查询。
- 相遇数据落独立 sidecar 文件，不污染词库文件与 git 历史。

**体验成果（可感知）**：
- 复习间隔不再"拍脑袋"，到期词数量更平稳，遗忘率下降。
- 生词在阅读中"先亮后淡"，注意力被引导到真正没记住的词上。
- 词库不再无限膨胀，久未相遇的词有证据化退出通道。
- 打开复习不再只面对冷冰冰的卡片列表，热力图与主页提供正反馈。

---

## 五、具体可实施改进建议

以下建议均落到现有代码文件，给出目标文件、改动要点与实现顺序。按阶段 P1→P6 推进，每阶段完成即构建并部署到测试 vault 验证，通过后再进入下一阶段。

### 5.1 P1：FSRS-5 算法升级（G1，最高优先级）

**目标文件**：
- `src/hiwords/core/flashcard-algorithm.ts`（123 行，现有 SM-2）
- `src/hiwords/core/flashcard-queue.ts`（167 行）
- `src/hiwords/utils/types.ts`（StudyItem/FlashcardProgress 类型）
- `src/hiwords/ui/flashcard-review-modal.ts`（评分逻辑 `rate()`）
- `src/hiwords/ui/sidebar-view.ts`（今日待复习计数）

**改动要点**：
1. 移植 Lexis 的 FSRS-5 实现（`FSRS_W` 19 参数、`FSRS_DECAY=-0.5`、`FSRS_FACTOR`、`initStability`/`initDifficulty`/`nextRecallStability`/`nextForgetStability`/`retrievability(t,s)`/`nextInterval`），替换 `applySm2`/`calculateEf`。
2. 评分映射保持现状（忘记/模糊/记得/简单）并对齐 FSRS grade：again=1、hard=2、good=3、easy=4（或保持 0-5 但按 FSRS 语义换算）。
3. 进度字段扩展：`{ s, d, due, lastReview, reps, lapses }`；保留现有 `studyProgress` 兼容层，写时双份（新字段 + 兼容旧读取），读时优先新字段。
4. **数据迁移**：提供一次性迁移命令/逻辑，将旧 `studyProgress`（reps/ef/interval/dueDate）映射为 FSRS 初值（如 `s = initStability(3)`、`d = initDifficulty(3)`、`due` 原样保留），不丢既有进度。
5. 新词直接进长期调度（去掉/降级现有学习阶段步进，或保留学习阶段但间隔由 FSRS 计算）。
6. 队列逻辑微调：`flashcard-queue.ts` 按 `due` 升序 + 新词上限（保留 dailyNewWordLimit/dailyReviewLimit），补 due 溢出词优先级。

**验收**：复习几轮后同一词 interval 呈指数增长且不同评分产生不同 stability；旧进度无缝迁移；到期计数正确。

### 5.2 P2：高亮渐隐 + 匹配健壮性（G2）

**目标文件**：
- `src/hiwords/core/word-highlighter.ts`（346 行）
- `src/hiwords/ui/reading-mode-highlighter.ts`（150 行）
- `src/hiwords/utils/trie.ts` + `pattern-matcher.ts`（词边界）
- `src/hiwords/utils/types.ts`（WordDefinition 增 stability 缓存）
- `styles.css`

**改动要点**：
1. **渐隐**：`fadeAlphaFor(entry)`：`progress = s/(s+K)`（K=20），新词（无 s）返回 1，透明度下限 `fadeFloor`（默认 0.25）入设置。用 stability 而非 retrievability。在 `rebuildIndex`/`refreshHighlighter` 时把 `s/archived/status` 缓存进 definition，渲染实时读设置（改设置无需重建索引）。
2. **语言无关词边界**：trie/pattern-matcher 中增加"仅 ASCII 词加边界、CJK 不加"的逻辑（对标 Lexis `boundedSource`），修复中文词误匹配。
3. **自高亮排除**：为每个词条记录"自身 word+aliases"集合，词条文档内命中自身不高亮（其他词照常）。
4. **修复 `removeOverlaps` no-op**：实现真正的重叠裁剪（短词优先保留或按优先级），避免 `the` 与 `the...end` 等重叠装饰冲突。
5. 高亮 CSS 变量支持透明度（`color-mix` 或 rgba），为渐隐提供渲染通道。

**验收**：新词高亮最亮；复习稳定后的词肉眼可见变淡；中文词不再因 `\b` 误判；词条自身关键词在自己的笔记中不高亮。

### 5.3 P3：相遇记账 + hover 回流（G2）

**目标文件**：
- 新增 `src/hiwords/core/encounter-tracker.ts`（参考 Lexis `recordEncounter`/`hoverFeedback`）
- `src/hiwords/ui/definition-popover.ts`（468 行，hover 触发点）
- `src/hiwords/ui/add-word-modal.ts`（加词触发点）
- `src/main.ts`（`file-open` 事件 + 加载/落盘）
- `src/hiwords/utils/types.ts`（Encounters 类型）

**改动要点**：
1. sidecar 存储：`<vault>/.obsidian/plugins/note-bar/encounters.json`，按词条 key 存 `{ hoverCount, encounterCount, lastEncounter }`；内存改 + 1.5s 防抖落盘，`onunload` 补一次即时保存。**不写进 Canvas 文件**（避免刷花 mtime）。
2. 强相遇三事件：`definition-popover` 打开时记 hover；`add-word-modal` 确认时记 add；`main.ts` 监听 `workspace.on("file-open")` 打开词库词条时记 open。
3. **(词+类型) 60s 冷却**去重，防鼠标晃入晃出虚高。
4. **hover 回流**：hover 某词时若 `due > today + N`（默认 3，设置可调，可整体关闭）则把 due 拉到今天；**只动 due，不伪造评分、不改 stability/difficulty**；已毕业词只记账不回流。
5. 被动相遇（可选延后）：高亮装饰实际渲染时按"词+当天" Set 去重计一次，热路径仅一次 `Set.has`。

**验收**：悬停后 encounters.json 计数与日期变化；悬停远期到期词后它出现在近期复习队列；关闭开关后行为恢复；渲染无明显变慢。

### 5.4 P4：词条生命周期 + 淘汰候选（G3）

**目标文件**：
- `src/hiwords/utils/types.ts`（WordDefinition 增 `status`/`pinned`）
- `src/hiwords/core/vocabulary-manager.ts`（状态读写）
- `src/hiwords/ui/sidebar-view.ts` 或新增 `src/hiwords/ui/retirement-panel.ts`（候选列表）
- `src/main.ts`（命令：毕业/归档/淘汰/常驻/迁移）

**改动要点**：
1. 词条状态：`status: active | graduated | archived | retired` + `pinned` 布尔。**红线：任何功能不得直接改写 FSRS 内部参数，状态只叠加在算法之上**（沿用 Lexis 定案）。
2. 毕业/归档：退出高亮与复习队列，悬停仍可查（视觉上不高亮但保留 hover 入口）；归档词不出现在 `getStudyDefinitionsForHighlight` 与复习队列。
3. 淘汰：从匹配模式中彻底剔除（连 hover 都不触发），词条文件/节点保留不删除。
4. 迁移命令：一次性把已掌握（mastered）词映射为 graduated 或归档（二选一确认，参考 Lexis `LexisRestoreModal`）。
5. **淘汰候选**：硬条件筛子——非 pinned/已退出 + 入库 ≥N 天（默认 90）+ 距上次相遇 ≥N 天（用 encounters 数据，未相遇用入库日期）；列表展示证据（入库日期/相遇/悬停次数），三个动作：淘汰/留下/已掌握，支持多选。入口放侧边栏底部或主页，被动展示不打扰。

**验收**：毕业词正文无高亮但悬停有卡；淘汰词完全无匹配；构造 90 天前零相遇的测试词能出现在候选；状态写入持久化且不污染 FSRS 字段。

### 5.5 P5：复习主页 + 热力图 + 遗忘曲线 + cloze 卡面（G3）

**目标文件**：
- 新增 `src/hiwords/ui/review-home-view.ts`（ItemView，参考 Lexis `LexisHomeView`）
- 新增 `src/hiwords/ui/review-heatmap.ts`（近 18 周热力图，`reviewLog` 数据）
- 新增 `src/hiwords/core/flashcard-log.ts`（复习日志 `reviewLog`）
- `src/hiwords/ui/flashcard-review-modal.ts`（cloze 卡面 + 撤销 + 间隔预览）
- `src/main.ts`（注册视图与 ribbon/命令）

**改动要点**：
1. 复习日志：每次评分记 `{ date, word, grade }` 进 `reviewLog`（存 data.json），供热力图与统计。
2. 热力图：近 18 周 × 7 天网格，按当天复习量 4 档着色，可嵌入侧边栏或主页。
3. 主页视图：待复习/新词/总计统计 + 热力图 + 集合筛选（按词库/标签）+ 开始复习按钮 + 淘汰候选区（P4 接入）。
4. **cloze 卡面**：基于词条"出处/例句"挖空目标词（保留首字母提示可选），正面渲染 Markdown。
5. 撤销（Z）：还原上一次评分对进度字段的写入并回退队列。
6. 评分按钮显示下次间隔预览（`humanInterval` 将天数转"x 天/x 个月/x 年"）。

**验收**：复习后热力图对应日期着色；主页统计准确；cloze 卡可完成一轮复习；撤销后进度字段还原。

### 5.6 P6：稳定性与性能修复（贯穿，按优先级）

**目标文件**：
- `src/hiwords/core/vocabulary-manager.ts` + `canvas/canvas-editor.ts`：临时 ID 竞态
- `src/hiwords/services/local-dictionary-service.ts`：词典加载
- `src/toolbar/ToolbarManager.ts` + `src/main.ts`：80ms 轮询
- `src/hiwords/ui/sidebar-view.ts`：全量重渲染

**改动要点（按 ROI 排序）**：
1. **修复临时 ID 竞态**（高）：`addWordToCanvas` 先插 `temp_` ID 再 1s 异步替换——改为写入前先分配真实 ID 或写入成功后立即读取真实 ID 替换内存缓存，杜绝崩溃后内存/文件不一致。
2. **词典首查卡顿**（中）：`local-dictionary-service.ts` 首查 `JSON.parse` 大文件卡顿——改为（a）构建脚本输出分片索引（按首字母分片），查词只读对应分片；（b）或引入 Web Worker 解析；（c）至少异步加载 + 加载中占位提示。同时修正 CLAUDE.md 中"内联打包"的过时描述。
3. **80ms 轮询**（中）：选区轮询改为"mouseup/keyup/selectionchange 事件驱动 + 防抖"，无选区变化时零开销（保留 toolbar 内交互需的极短轮询或直接事件化）。
4. **侧边栏全量重渲染**（低）：`container.empty()` 重建改为差异更新或按需更新单卡片。
5. 顺手修复：`removeOverlaps`（若 P2 未做）、`masteredThreshold` 经验阈值与 FSRS 毕业逻辑统一（P1 联动）。

**验收**：连续快速加词后重载插件，词库无 temp_ 残留、无重复节点；首次查词不卡界面；无选区时 CPU 空闲。

---

## 六、实施顺序与验证流程

1. 从 `main` 新建分支 `language-learning-v2`。
2. 按 P1→P6 顺序实施；每阶段：
   - 改完 `npm run build` + `tsc` 类型检查通过；
   - 部署到测试 vault（`~/Documents/Obisidian-test-value/.obsidian/plugins/note-bar/`，保留用户 `data.json`）；
   - 按该阶段"验收"条目手动验证；
   - 通过后进入下一阶段。
3. 全部完成后回归全功能（工具栏/翻译/导出/拼写），再按既有部署流程征询确认后部署正式 vault。

---

## 七、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| SM-2→FSRS 迁移丢进度 | 用户复习数据受损 | 迁移逻辑保留旧字段双写 + 提供回滚开关；先在小样本词库验证 |
| Canvas 写入竞态未彻底解决 | 词库文件损坏 | P6 优先处理；写入前后校验 JSON 可解析 |
| 渐隐/相遇引入性能开销 | 渲染卡顿 | 热路径仅 Set.has / 缓存 stability 于索引；用 dev 性能面板对比前后帧耗时 |
| 词条状态与 FSRS 字段耦合污染 | 算法状态被手动改坏 | 严格遵循"状态只叠加不内改"红线，代码 review 把关 |
| 范围蔓延（浏览器扩展等） | 周期拉长 | 明确列为远期，本次只做 Obsidian 端 |

---

## 八、结论

本次改进以"科学有效的语言学习闭环"为纲，共 6 个阶段。其中 **P1（FSRS-5）是最大杠杆**——算法升级直接提升复习效果；**P3（相遇记账+hover 回流）与 P2（渐隐）是体验质变点**——让阅读本身成为学习信号源；P4/P5 完成生命周期与可视化闭环；P6 保障稳定性。整体改动集中在现有模块内，不更换存储介质、不引入新依赖，风险可控、可阶段验收。

# 语言学习体验升级 Spec

## Why
Note Bar 目前使用 1987 年的 SM-2 算法、恒定高亮、无阅读行为信号采集，复习效果与阅读体验有明确提升空间。借鉴 Lexis 的学习科学内核（FSRS-5、高亮渐隐、相遇记账、词条生命周期），在保留现有 Canvas 词库、词典体系、工具栏、拼写练习等能力的前提下，将 Note Bar 升级为"科学有效的语言学习闭环"。融合设计已与用户逐项讨论定案（见 `documents/lexis-note-bar-改进报告.md` 第三章）。

## What Changes
- **BREAKING** 复习算法由 SM-2 替换为 FSRS-5，进度字段由 `{ef, interval, reps}` 迁移为 `{s, d, due, lastReview, reps, lapses}`
- 新增 FSRS-5 纯函数模块，替换 `flashcard-algorithm.ts` 的 SM-2 实现
- 高亮渐隐：高亮透明度随词条 stability 变化（新词全强度 → 熟词淡至 fadeFloor）
- 新增相遇记账（sidecar `encounters.json`）与 hover 回流
- 新增词条生命周期状态（active/graduated/archived/retired/pinned）与 Canvas"已归档"分组
- 新增淘汰候选列表、复习日志、热力图、主页视图、遗忘曲线、cloze 卡面、撤销/跳过/间隔预览
- Canvas 节点文本支持 `#### ` 模板分段（`#### 意思` / `#### 出处` / `#### 近义词`），解析器向后兼容旧节点
- 稳定性修复：Canvas 临时 ID 竞态、词典分片加载、选区轮询事件化

## Impact
- Affected specs: 复习算法、高亮引擎、词库管理、Canvas 解析、设置项、侧边栏、定义弹窗、复习弹窗、导出
- Affected code:
  - `src/hiwords/core/`：`flashcard-algorithm.ts`（重写为 FSRS-5）、`flashcard-queue.ts`、`word-highlighter.ts`、`vocabulary-manager.ts`、`mastered-service.ts`、新增 `fsrs.ts`、`encounter-tracker.ts`、`flashcard-log.ts`
  - `src/hiwords/canvas/`：`mastered-group-manager.ts`（多分组）、`canvas-parser.ts`（分段解析）
  - `src/hiwords/services/`：`local-dictionary-service.ts`（分片）、`dictionary-service.ts`（AI 提示词约束）
  - `src/hiwords/ui/`：`definition-popover.ts`、`add-word-modal.ts`、`sidebar-view.ts`、`flashcard-review-modal.ts`、新增 `review-home-view.ts`、`review-heatmap.ts`
  - `src/hiwords/utils/types.ts`、`src/main.ts`、`styles.css`、`scripts/build-dictionary.js`

## ADDED Requirements

### Requirement: FSRS-5 间隔重复调度
系统 SHALL 提供基于 FSRS-5 DSR 模型的复习调度，替换现有 SM-2。

#### Scenario: 新词进入长期调度
- **WHEN** 用户对从未复习过的词点击"忘记/模糊/记得/简单"
- **THEN** 系统用 `initStability(grade)`/`initDifficulty(grade)` 初始化 `s`/`d`，按 `nextInterval` 计算首次到期日 `due`，写入进度

#### Scenario: 复习后调度更新
- **WHEN** 用户对已复习过的词评分（grade 1-4）
- **THEN** 系统用 `retrievability(t, s)` 计算记忆提取率，按 grade 经 `nextRecallStability`/`nextForgetStability` 更新 `s`/`d`，计算新 `due`，`reps`/`lapses` 相应增减

#### Scenario: 旧进度迁移
- **WHEN** 系统加载到含旧 SM-2 字段 `{ef, interval, reps, dueDate}` 的进度
- **THEN** 迁移为 `{s: initStability(3), d: initDifficulty(3), due: dueDate 原样}`，新字段写入、旧字段保留双写兼容，不丢既有到期日

### Requirement: 高亮渐隐
系统 SHALL 使高亮透明度随词条 stability 单调变淡，保护高亮的显著性。

#### Scenario: 新词全强度
- **WHEN** 词条尚无 FSRS 进度（无 `s`）
- **THEN** 高亮 alpha = 1（全强度）

#### Scenario: 熟词渐隐
- **WHEN** 词条 `s > 0`
- **THEN** 高亮 alpha = `1 - (s/(s+K))·(1 - fadeFloor)`（K=20，fadeFloor 默认 0.25，设置可调可到 0）

#### Scenario: 与已掌握过滤合并
- **WHEN** 用户启用"渐隐"开关
- **THEN** 已掌握词不再硬过滤，改为淡至 fadeFloor；fadeFloor=0 时完全不可见但悬停入口保留

### Requirement: 相遇记账
系统 SHALL 记录用户与词条的真实相遇事件到 sidecar `encounters.json`（不写 Canvas 文件）。

#### Scenario: 悬停相遇
- **WHEN** 用户在定义弹窗打开某词条释义
- **THEN** 记 `hover` 事件，`hoverCount` +1、`lastEncounter` 更新

#### Scenario: 加词相遇
- **WHEN** 用户通过加词弹窗确认加入某词条
- **THEN** 记 `add` 事件，`encounterCount` +1

#### Scenario: 侧边栏相遇
- **WHEN** 用户在侧边栏点击展开某词条
- **THEN** 记 `open` 事件（替代 Lexis 的"打开词条文件"）

#### Scenario: 冷却与落盘
- **WHEN** 同一词条同一事件类型 60 秒内重复触发
- **THEN** 去重不计数；内存累积 1.5s 防抖落盘，`onunload` 补一次即时保存

### Requirement: hover 回流
系统 SHALL 在悬停远期到期词时将其复习到期日拉近，反哺复习排期。

#### Scenario: 悬停远期词
- **WHEN** 用户悬停查看某词条，且该词 `due > today + N`（N 默认 3 天，设置可调可关闭），且非已毕业
- **THEN** `due` 被拉至今天；**只动 due，不修改 s/d，不进入复习日志**

### Requirement: 词条生命周期
系统 SHALL 支持词条状态：`active | graduated | archived | retired` + `pinned`，状态只叠加在 FSRS 之上，绝不内改 `s/d/due`。

#### Scenario: 自动毕业
- **WHEN** 词条 stability `s >= 阈值`（默认值待实测，设置可调）
- **THEN** 状态置为 `graduated`，退出高亮与复习队列（悬停仍可查），并触发现有 Canvas 掌握同步链路（移入 Mastered 分组/变绿）

#### Scenario: 归档与淘汰
- **WHEN** 用户归档某词条
- **THEN** 状态置为 `archived`，退出高亮与复习，保留悬停查询入口，节点移入 Canvas"已归档"分组
- **WHEN** 用户淘汰某词条
- **THEN** 状态置为 `retired`，从匹配中彻底剔除（悬停不触发），节点移入"已归档"分组

#### Scenario: 常驻
- **WHEN** 用户标记某词条为常驻
- **THEN** `pinned = true`，永不再进淘汰候选

### Requirement: 淘汰候选
系统 SHALL 在侧边栏提供淘汰候选列表（被动展示，不打扰）。

#### Scenario: 候选筛子
- **WHEN** 词条满足：非 pinned/已退出 + 入库天数 ≥ N（默认 90）+ 距上次相遇 ≥ N 天（未相遇用入库日期，入库日期取 Canvas 日期分组 label）
- **THEN** 该词条进入候选列表，展示证据（入库日期/相遇次数/悬停次数）

#### Scenario: 用户判决
- **WHEN** 用户在候选列表点击"淘汰/留下/已掌握"
- **THEN** 分别执行 retired / pinned / graduated 操作，支持多选批量

### Requirement: 复习主页与热力图
系统 SHALL 提供复习数据可视化：每次评分记入 `reviewLog`（`{date, word, grade}`），渲染近 18 周复习热力图与统计主页。

#### Scenario: 复习记录
- **WHEN** 用户完成一次评分
- **THEN** `reviewLog` 追加一条记录，热力图对应日期着色（4 档强度）

#### Scenario: 主页统计
- **WHEN** 用户打开复习主页
- **THEN** 显示待复习/新词/总计统计、热力图、按词库/标签筛选与开始复习按钮、淘汰候选区

### Requirement: cloze 卡面与复习增强
系统 SHALL 在复习卡中提供出处填空（cloze）卡面、撤销、跳过与间隔预览。

#### Scenario: cloze 卡面
- **WHEN** 词条有出处/例句且用户选择 cloze 模式
- **THEN** 正面渲染挖空目标词的出处句子（保留首字母提示可选）

#### Scenario: 撤销
- **WHEN** 用户按 Z 撤销上一次评分
- **THEN** 还原该次评分对 `s/d/due/reps/lapses` 的写入并回退队列

#### Scenario: 间隔预览
- **WHEN** 评分按钮悬停或点击前
- **THEN** 显示该评分将产生的下次间隔（"x 天/x 个月/x 年"）

### Requirement: Canvas 节点模板分段
系统 SHALL 支持 Canvas 节点文本按 `#### ` 标题分段解析（意思/出处/近义词），向后兼容无分段旧节点。

#### Scenario: 分段解析
- **WHEN** 解析节点文本
- **THEN** 按行匹配 `^####\s+` 开新段，输出结构化分段 `{section, lines}[]`；无分段标题的节点保持"整段释义"（现状不变）

#### Scenario: 自动填充写入分段
- **WHEN** 本地词典/AI 自动填充释义
- **THEN** 释义只写入 `#### 意思` 段；AI 提示词要求输出纯文本释义、禁止 markdown 标题

#### Scenario: 弹窗分段渲染
- **WHEN** 定义弹窗显示词条
- **THEN** 按段渲染：意思→正文、出处→逐条列表（MarkdownRenderer）、近义词→chip 样式

#### Scenario: 写入保护
- **WHEN** 插件写入词条文本
- **THEN** 写前先读文件再合并，不整体改写已有节点文本，用户手动分段内容原样保留

### Requirement: 稳定性修复
系统 SHALL 修复已知稳定性与性能问题。

#### Scenario: 临时 ID 竞态
- **WHEN** 快速连续添加单词后重载插件
- **THEN** 词库无 `temp_` 残留 ID、无重复节点、内存与文件一致

#### Scenario: 词典分片加载
- **WHEN** 首次查词
- **THEN** 词典按首字母分片读取，仅加载对应分片，界面不卡顿

#### Scenario: 选区轮询事件化
- **WHEN** 无选区变化
- **THEN** 无 80ms 常驻轮询开销（改事件驱动 + 防抖）

## MODIFIED Requirements

### Requirement: 复习进度存储
原 `studyProgress`（SM-2：status/stage/reps/ef/interval/dueDate/history）修改为支持 FSRS 字段（s/d/due/lastReview/lapses），写入时新旧字段双写兼容，读取优先新字段。

### Requirement: 掌握判定
原 `masteredThreshold {reps:3, minEf:2.5}` 修改为 `s >= 阈值`（设置可调），触发时仍走现有 MasteredService 同步链路。

### Requirement: 高亮过滤设置
原"已掌握词过滤"开关修改为"渐隐"开关（含 fadeFloor 下限设置），已掌握词由硬消失改为渐隐。

### Requirement: Canvas 词库解析
`canvas-parser.ts` 的 `parseFromText` 修改为支持 `#### ` 分段识别，首行=单词、第二行 `*alias*`=别名的既有约定保持不变。

## REMOVED Requirements

### Requirement: SM-2 调度算法
**Reason**: SM-2 为 1987 年经验公式，无遗忘曲线模型，调度精度不足。
**Migration**: 进度经迁移逻辑双写为 FSRS 字段；`flashcard-algorithm.ts` 的 `applySm2`/`calculateEf` 删除，替换为 `fsrs.ts` 纯函数。

### Requirement: 已掌握词硬过滤
**Reason**: 硬过滤导致高亮"断崖式"消失，与渐隐理念冲突。
**Migration**: 合并为"渐隐"开关；fadeFloor=0 可达等效效果。

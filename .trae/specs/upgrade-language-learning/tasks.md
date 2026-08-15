# Tasks

> 基于 `documents/lexis-note-bar-改进报告.md` 第五章的 P1-P6 阶段划分。
> 每阶段完成后：`npm run build` + `tsc` 通过 → 部署测试 vault（`~/Documents/Obisidian-test-value/.obsidian/plugins/note-bar/`，保留用户 `data.json`）→ 按该阶段验收条目手动验证。

## P1：FSRS-5 算法升级（G1，最高优先级，无依赖）

- [x] Task 1: 新增 FSRS-5 纯函数模块 `src/hiwords/core/fsrs.ts`
  - [x] 移植 Lexis FSRS-5：`FSRS_W` 19 参数、`FSRS_DECAY=-0.5`、`FSRS_FACTOR`
  - [x] 实现 `initStability(grade)` / `initDifficulty(grade)` / `nextDifficulty(d, grade)` / `retrievability(t, s)` / `nextRecallStability(d, s, r, grade)` / `nextForgetStability(d, s, r)` / `nextInterval(s, R)`（R=0.9）
  - [x] 评分映射：忘记=1、模糊=2、记得=3、简单=4
  - [x] 单元测试：新卡初始化、连续复习调度单调递增、遗忘分支 lapses+1
- [x] Task 2: 重写 `src/hiwords/core/flashcard-algorithm.ts` 接入 FSRS
  - [x] `applyReviewRating` 改为调用 `fsrs.ts`，移除 `applySm2`/`calculateEf`
  - [x] 进度字段扩展：`{s, d, due, lastReview, reps, lapses}`；保留 status/stage 学习阶段（间隔由 FSRS 计算）
  - [x] 迁移逻辑：旧 `{ef, interval, reps, dueDate}` → `s=initStability(3)`、`d=initDifficulty(3)`、`due` 原样保留，新字段双写、旧字段保留
- [x] Task 3: 更新 `src/hiwords/utils/types.ts` 进度类型定义
  - [x] FlashcardProgress/相关类型增加 s/d/lastReview/lapses 字段
  - [x] studyKey 兼容性确认（studyProgress key 不变）
- [x] Task 4: 适配 `src/hiwords/ui/flashcard-review-modal.ts` 评分调用
  - [x] `rate()` 评分走新算法，评分映射重排
  - [x] 复习卡间隔预览（`humanInterval` 显示下次间隔）
- [x] Task 5: 适配 `src/hiwords/core/flashcard-queue.ts` 与 `sidebar-view.ts`
  - [x] 队列按 `due` 升序 + 新词上限（保留 dailyNewWordLimit/dailyReviewLimit）
  - [x] "今日待复习"计数用新 due 计算
- [ ] 验证：复习几轮后同一词 interval 指数增长且不同评分产生不同 stability；旧进度无缝迁移；到期计数正确

## P2：高亮渐隐 + 匹配健壮性（G2，依赖 P1）

- [ ] Task 6: 高亮渐隐
  - [ ] `word-highlighter.ts` 构建 decoration 时读取词条缓存 `s`，计算 alpha = `1 - (s/(s+20))·(1 - fadeFloor)`（新词 alpha=1）
  - [ ] 高亮样式支持透明度（`color-mix` 或 rgba），styles.css 调整
  - [ ] 设置："已掌握词过滤"改为"渐隐"开关 + fadeFloor 下限（默认 0.25，可到 0）；`reading-mode-highlighter.ts` 同步
- [ ] Task 7: 语言无关词边界 + 自高亮排除 + 重叠去重
  - [ ] `trie.ts`/`pattern-matcher.ts`：词首尾为 ASCII 词字符才加边界，CJK 不加
  - [ ] Canvas 词条节点内：自身 word/aliases 出现在释义文本时不自我高亮（其他词照常）
  - [ ] 修复 `removeOverlaps` no-op：实现真正重叠裁剪
- [ ] 验证：新词最亮；复习稳定词肉眼可见变淡；中文词无误判；自身关键词在节点内不高亮

## P3：相遇记账 + hover 回流（G2，依赖 P1）

- [x] Task 8: 新增 `src/hiwords/core/encounter-tracker.ts`
  - [x] sidecar `encounters.json`（`<vault>/.obsidian/plugins/note-bar/`），按词条 key 记 `{hoverCount, encounterCount, lastEncounter}`
  - [x] 内存改 + 1.5s 防抖落盘；`onunload` 补一次即时保存
  - [x] (词+类型) 60s 冷却去重
- [x] Task 9: 挂接相遇触发点
  - [x] `definition-popover.ts` 打开时记 hover
  - [x] `add-word-modal.ts` 确认时记 add
  - [x] `sidebar-view.ts` 点击展开时记 open
- [x] Task 10: hover 回流
  - [x] hover 时若 `due > today + N`（N 默认 3，设置可调可关）且非已毕业 → due 拉至今天；只动 due，不改 s/d、不进复习日志
- [ ] 验证：悬停后 encounters.json 计数与日期变化；悬停远期词后它出现在近期复习队列；关闭开关后行为恢复；渲染无明显变慢

## P4：词条生命周期 + 淘汰候选（G3，依赖 P1+P3）

- [x] Task 11: 状态模型与存储
  - [x] `types.ts`：WordDefinition 增 `status: active|graduated|archived|retired` + `pinned`
  - [x] `vocabulary-manager.ts`：状态读写；graduated/archived 退出高亮与复习队列（悬停仍可查）；retired 从匹配剔除
  - [x] **红线：状态只叠加，不内改 s/d/due**
- [x] Task 12: 自动毕业（stability 阈值）
  - [x] `mastered-service.ts`/相关逻辑：`s >= 阈值`（默认值 30，设置可调）自动置 graduated
  - [x] 触发时仍走现有 Canvas 掌握同步链路（移入 Mastered 分组/变绿）
- [x] Task 13: Canvas"已归档"分组
  - [x] `mastered-group-manager.ts` 扩展支持多分组类型（Mastered/已归档）
  - [x] 归档/淘汰节点移入已归档分组（几何移动，沿用现有模式）
- [x] Task 14: 淘汰候选
  - [x] 硬条件筛子：非 pinned/已退出 + 入库 ≥90 天 + 距上次相遇 ≥90 天（入库日期取日期分组 label，未相遇用入库日期）
  - [x] 侧边栏"淘汰候选"入口，证据展示（入库日期/相遇/悬停次数），三个动作：淘汰/留下/已掌握，多选批量
- [ ] 验证：毕业词正文无高亮但悬停有卡；淘汰词完全无匹配；构造 90 天前零相遇测试词出现在候选；状态持久化且不污染 FSRS 字段

## P5：复习主页 + 热力图 + 遗忘曲线 + cloze（G3，依赖 P1）

- [ ] Task 15: 复习日志 `reviewLog`
  - [ ] 新增 `src/hiwords/core/flashcard-log.ts`：每次评分记 `{date, word, grade}`（存 data.json）
- [ ] Task 16: 热力图组件
  - [ ] 新增 `src/hiwords/ui/review-heatmap.ts`：近 18 周 × 7 天网格，按当天复习量 4 档着色
- [ ] Task 17: 复习主页视图
  - [ ] 新增 `src/hiwords/ui/review-home-view.ts`（ItemView）：统计 + 热力图 + 集合筛选 + 开始复习按钮 + 淘汰候选区（接 Task 14）
  - [ ] `main.ts` 注册视图与 ribbon/命令
- [ ] Task 18: 遗忘曲线 + cloze 卡面
  - [ ] 遗忘曲线 SVG（48 段折线 + 目标保留率虚线），渲染进定义弹窗
  - [ ] `flashcard-review-modal.ts` 新增 cloze 模式（挖空目标词，首字母提示可选）
  - [ ] 撤销（Z）：还原上一次评分写入并回退队列
- [ ] 验证：复习后热力图对应日期着色；主页统计准确；cloze 卡完成一轮复习；撤销后进度字段还原

## P6：稳定性与性能修复（贯穿，独立）

- [ ] Task 19: 修复 Canvas 临时 ID 竞态
  - [ ] `vocabulary-manager.ts` + `canvas-editor.ts`：写入后从返回文件读回真实 ID 更新缓存（或写入前生成真实 ID），杜绝 temp_ 残留
- [ ] Task 20: 词典分片加载
  - [ ] `scripts/build-dictionary.js` 输出按首字母分片索引
  - [ ] `local-dictionary-service.ts` 查词只读对应分片
- [ ] Task 21: 选区轮询事件化
  - [ ] `main.ts` 80ms 轮询改为 mouseup/keyup/selectionchange 事件驱动 + 防抖
- [ ] 验证：连续快速加词后重载无 temp_ 残留/重复节点；首次查词不卡界面；无选区时 CPU 空闲

# Task Dependencies
- [Task 6] depends on [Task 1]（渐隐依赖 stability 字段）
- [Task 10] depends on [Task 8/9]（hover 回流依赖相遇与 due）
- [Task 11-14] depends on [Task 1] 与 [Task 8/9]（淘汰依赖相遇数据）
- [Task 15-18] depends on [Task 1]
- [Task 19] 与 [Task 20/21] 相互独立，可并行
- [Task 1-5]（P1）无依赖，最先实施

# 实施与验收流程（贯穿）
1. 每任务完成：`npm run build` + TypeScript 类型检查通过
2. 每阶段完成：部署测试 vault（`~/Documents/Obisidian-test-value/.obsidian/plugins/note-bar/`，保留用户 `data.json`）
3. 按该阶段"验证"条目手动验收，通过后进入下一阶段
4. 全部完成：回归全功能（工具栏/翻译/导出/拼写），征询确认后部署正式 vault

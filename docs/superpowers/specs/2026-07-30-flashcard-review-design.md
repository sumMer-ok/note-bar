# Note Bar 闪卡复习系统 PRD

> 状态：设计已批准  
> 分支：`words-remember`  
> 目标版本：`1.1.0`

## 1. 背景与目标

Note Bar 已集成 HiWords 生词本系统，支持在阅读时高亮生词、悬停查看释义、Canvas 单词本管理以及「已掌握」状态标记。为了强化记忆效果，本 PRD 增加基于 SM-2 算法的闪卡复习功能，实现「学习 → 复习 → 掌握」的闭环，体验参考不背单词。

## 2. 产品形态

- **复习界面**：大居中模态弹窗（非全屏），沉浸式但不遮挡 Obsidian 全部 UI。
- **触发入口**：
  - 命令面板：`Note Bar: 开始闪卡复习`
  - HiWords 侧边栏顶部显示「今日待复习 xx」，点击打开弹窗。
- **复习范围**：用户手动选择 1 个或多个已启用的 **Canvas 单词本**（`.canvas`）。
- **复习模式**：
  - `英→中`（默认）：正面英文单词，背面中文释义。
  - `中→英`：正面中文释义，背面英文单词+完整释义。

## 3. 用户故事

1. 用户打开侧边栏，看到「今日待复习 12」，点击后选择要复习的 Canvas 单词本。
2. 弹窗显示第一张卡片正面：单词 + 音标 + 发音按钮 + 拼写输入框。
3. 用户可在输入框中输入单词并按回车检查拼写，正确显示绿色，错误显示红色（仅辅助练习，不影响评级）。
4. 用户按空格或点击卡片翻转，背面显示完整 Canvas 节点文本（含释义、别名、用户笔记）。
5. 用户按下 `f`（认识）、`d`（模糊）、`s`（不认识）或在界面点击「太简单」按钮，卡片以弹性动画滑出，下一张卡片弹入。
6. 一轮结束后显示统计，已掌握单词自动同步到 Canvas「Mastered」分组。

## 4. 数据模型

### 4.1 扩展 `StudyProgressItem`

```ts
interface StudyProgressItem {
  status: 'new' | 'learning' | 'review' | 'mastered';
  stage?: number;            // 新学阶段进度（默认 0）
  reps?: number;             // SM-2 连续成功次数
  ef?: number;               // SM-2 熟练度因子（默认 2.5）
  interval?: number;         // 当前间隔（天）
  dueDate?: string;          // ISO 格式下次到期日
  lastReview?: string;       // 上次复习时间
  history?: ReviewRecord[];  // 最近自评记录（可选）
}

interface ReviewRecord {
  date: string;
  quality: 'again' | 'hard' | 'good' | 'easy';
}
```

### 4.2 复习设置

```ts
interface FlashcardSettings {
  defaultMode: 'word-to-definition' | 'definition-to-word';
  newWordSteps: number;      // 默认 2
  masteredThreshold: { reps: number; minEf: number }; // 默认 { reps: 3, minEf: 2.5 }
  dailyNewWordLimit: number; // 默认 20
  dailyReviewLimit: number;  // 默认 50
  studyOrder: 'review-first' | 'new-first'; // 默认 'review-first'
  syncMasteredToCanvas: boolean; // 默认 true
  enableAnimation: boolean;  // 默认 true
}
```

### 4.3 兼容性

- 旧 `studyProgress` 中 `status: 'mastered'` 的数据视为 `status='mastered', ef=2.5, reps=3`。

## 5. 复习算法

### 5.1 自评映射

| 用户操作 | 快捷键 | quality | 效果 |
|---|---|---|---|
| 认识 | `f` | 4 | `ef` 不变；`reps += 1`；interval 按 reps 升级 |
| 模糊 | `d` | 3 | `ef -= 0.14`；`reps` 不变；`interval` 取 1 或小幅增加 |
| 不认识 | `s` | 0/1 | `ef -= 0.8`；`reps = 0`；`interval = 1` |
| 太简单 | 点击按钮 | 5 | `ef += 0.1`；`reps += 1`；interval 额外放大 |

### 5.2 SM-2 计算

```ts
function sm2(item: StudyProgressItem, quality: number): StudyProgressItem {
  const ef = Math.max(1.3, item.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  let interval: number;
  let reps = item.reps || 0;

  if (quality < 3) {
    reps = 0;
    interval = 1;
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round((item.interval || 1) * ef);
  }

  return {
    ...item,
    ef,
    reps,
    interval,
    dueDate: addDays(new Date(), interval).toISOString()
  };
}
```

### 5.3 新词学习阶段

- 首次出现：`status = 'new'` → 进入队列后变为 `'learning'`，`stage = 0`。
- 学习阶段点击「认识」或「太简单」：`stage += 1`。
- 当 `stage >= newWordSteps`（默认 2）：新词毕业，`status = 'review'`，`reps = 1`，`interval = 1`，`dueDate = 明天`。
- 学习阶段点击「模糊」或「不认识」：`stage = 0`，当天重新学习。

### 5.4 掌握判定

同时满足以下条件时自动标记为已掌握：
- `status === 'review'`
- `reps >= masteredThreshold.reps`（默认 3）
- `ef >= masteredThreshold.minEf`（默认 2.5）

触发后：
- 调用 `MasteredService.markWordAsMastered(...)` 同步到 Canvas「Mastered」分组（或改颜色，取决于设置）。
- `status` 更新为 `'mastered'`，但继续按长期间隔复习。

### 5.5 复习队列生成

1. 获取选中单词本的所有单词（通过 `VocabularyManager`）。
2. 未在 `studyProgress` 中的单词 → 新词候选池。
3. `dueDate <= 今天` 且 `status !== 'mastered'` 的单词 → 复习候选池。
4. 按设置截取当日任务：
   - 复习池最多取 `dailyReviewLimit` 个。
   - 新词池最多取 `dailyNewWordLimit` 个。
5. 队列顺序由 `studyOrder` 决定：
   - `review-first`（默认）：先排复习单词，再排新词。
   - `new-first`：先排新词，再排复习单词。
6. 同一 `studyKey` 在一次队列中只出现一次。

## 6. 界面设计

### 6.1 入口

- **命令面板**：`Note Bar: 开始闪卡复习`
- **侧边栏**：HiWords 侧边栏顶部显示 `今日待复习 xx`，点击打开。

### 6.2 单词本选择弹窗

- 标题：选择本次复习的单词本
- 列表：已启用的 Canvas 单词本，可多选，显示总词数 / 今日到期 / 新词。
- 底部：「开始复习」按钮。

### 6.3 复习主界面

**顶部栏**
- 左侧：模式切换 `英→中 / 中→英`
- 中间：进度 `3 / 28`
- 右侧：关闭按钮

**卡片区域**
- 正面：
  - 大号单词（`中→英` 模式下显示释义）
  - 音标（如果有）
  - 播放发音按钮（调用有道云 TTS）
  - 拼写输入框：输入单词后按回车检查拼写，正确变绿、错误变红，不影响评级
  - 提示：按空格翻转
- 背面：
  - 完整 Canvas 节点 Markdown 文本（释义、别名、用户笔记）
  - 底部评级按钮

**底部操作区**
- 键盘评级：`f` 认识 / `d` 模糊 / `s` 不认识
- 单独按钮：「太简单」
- 快捷键提示：空格翻转，f/d/s 评级

### 6.4 结束界面

- 本次复习单词数、新词数、已掌握数
- 平均难度 / 总耗时（可选）
- 按钮：「完成」「再复习一组」

### 6.5 动画

- **翻转**：3D Y 轴翻转，带弹性缓动。
- **切题**：
  - 认识/太简单 → 卡片向右滑出
  - 模糊/不认识 → 卡片向左滑出
  - 新卡片从中心弹性缩放入场
- 提供设置项关闭动画。

## 7. 系统集成

| 现有模块 | 集成方式 |
|---|---|
| `VocabularyManager` | 获取候选单词、更新定义、同步掌握状态。 |
| `MasteredService` | 达到掌握阈值时调用 `markWordAsMastered` / `unmarkWordAsMastered`。 |
| `LocalDictionaryService` | 可选：为新词补全音标/释义。 |
| `styles.css` | 新增 `.flashcard-*` 类名，保持视觉风格一致。 |
| `main.ts` | 注册命令、侧边栏入口、清理弹窗与监听。 |

## 8. 设置项

在 `NoteBarSettingTab` 中新增「闪卡复习」分区：

- 默认复习模式：`英→中` / `中→英`
- 每日新词上限
- 每日复习上限
- 学习顺序：`先复习再学习新词` / `先学习新词再复习`
- 新词学习步数
- 掌握阈值（reps + min EF）
- 是否自动同步掌握状态到 Canvas Mastered 分组
- 动画开关

## 9. 错误处理与边界

- 空单词本：提示「所选单词本暂无单词」。
- Canvas 文件被修改/删除：跳过该单词并记录警告。
- 保存进度失败：显示 Notice 并允许重试。
- `.hiwords` 只读词库：本次不支持进入复习。
- 一个单词出现在多个单词本：以 `studyKey` 为唯一标识，只复习一次；掌握状态同步到所有来源。
- 中途关闭弹窗：已评级进度已保存，未评级单词保留在队列中。

## 10. 技术约束

- 使用 Obsidian API：`Modal`、`Notice`、`MarkdownRenderer`、`setIcon`。
- 动画使用 CSS transforms + transitions，不使用重型动画库。
- 复习进度通过 `plugin.saveData()` 持久化，避免新增外部存储。
- 保持 TypeScript strict 风格，遵循现有 `src/` 目录组织。

## 11. 后续可扩展

- 拼写/听写模式
- 例句填空
- 学习统计面板（掌握率、遗忘曲线）
- 每日学习目标与提醒
- 复习日历

## 12. 参考

- [CLAUDE.md](../../../CLAUDE.md)
- `src/hiwords/core/vocabulary-manager.ts`
- `src/hiwords/core/mastered-service.ts`
- `src/hiwords/utils/study-key.ts`
- `src/hiwords/utils/types.ts`

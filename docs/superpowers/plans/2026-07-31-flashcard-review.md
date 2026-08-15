# Note Bar 闪卡复习功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Note Bar 插件中实现基于 SM-2 算法的闪卡复习系统，支持英→中/中→英两种模式、拼写辅助、键盘快捷键、单词本选择、掌握状态同步与复习进度持久化。

**Architecture:** 新增独立的闪卡算法与队列模块（`flashcard-algorithm.ts`、`flashcard-queue.ts`），通过扩展 `StudyProgressItem` 与 `HiWordsSettings` 持久化 SM-2 进度；UI 层新增 `FlashcardBookPickerModal` 与 `FlashcardReviewModal`，并复用 `VocabularyManager`、`MasteredService` 与 `playWordTTS`；入口与设置集中在 `main.ts` 与 `NoteBarSettingTab`，侧边栏显示今日待复习数量。

**Tech Stack:** TypeScript、Obsidian API（`Modal`、`Notice`、`MarkdownRenderer`、`setIcon`）、CSS transforms/transitions。

---

## 文件映射

| 文件 | 职责 |
|---|---|
| `src/hiwords/utils/types.ts` | 扩展 `StudyProgressItem`，新增 `ReviewRecord`、`FlashcardSettings`，在 `HiWordsSettings` 中加入 `flashcard`。 |
| `src/main.ts` | 增加闪卡默认设置、注册 `Note Bar: 开始闪卡复习` 命令、在设置页新增「闪卡复习」分区。 |
| `src/hiwords/core/mastered-service.ts` | 修改掌握状态持久化逻辑，保留 SM-2 进度字段，取消掌握时改为 `status: 'review'` 而非删除。 |
| `src/hiwords/core/flashcard-algorithm.ts` | SM-2 计算、评级映射、新词学习阶段、掌握判定。 |
| `src/hiwords/core/flashcard-queue.ts` | 根据选中单词本、复习/新词上限与学习顺序生成复习队列；提供今日任务统计。 |
| `src/hiwords/ui/flashcard-review-modal.ts` | 闪卡复习主界面：翻转、评级、拼写检查、发音、进度保存、掌握同步、结束统计。 |
| `src/hiwords/ui/flashcard-book-picker-modal.ts` | 选择 1 个或多个已启用的 Canvas 单词本，显示总词数/今日到期/新词。 |
| `src/hiwords/ui/sidebar-view.ts` | 在侧边栏顶部添加「今日待复习 xx」入口按钮。 |
| `styles.css` | 新增 `.flashcard-*` 样式，复现 demo 的弹性动画、布局与按钮配色。 |

---

## Task 1：扩展类型定义

**Files:**
- Modify: `src/hiwords/utils/types.ts`

- [ ] **Step 1：扩展 `StudyProgressItem` 并新增 `ReviewRecord` 与 `FlashcardSettings`**

将文件中的 `StudyProgressItem` 与 `HiWordsSettings` 替换为以下内容（其余类型保持不变）：

```ts
export interface ReviewRecord {
    date: string;
    quality: 'again' | 'hard' | 'good' | 'easy';
}

export interface StudyProgressItem {
    status: 'new' | 'learning' | 'review' | 'mastered';
    stage?: number;
    reps?: number;
    ef?: number;
    interval?: number;
    dueDate?: string;
    lastReview?: string;
    history?: ReviewRecord[];
    // 兼容旧数据
    masteredAt?: string;
    updatedAt?: string;
}

export interface FlashcardSettings {
    defaultMode: 'word-to-definition' | 'definition-to-word';
    newWordSteps: number;
    masteredThreshold: { reps: number; minEf: number };
    dailyNewWordLimit: number;
    dailyReviewLimit: number;
    studyOrder: 'review-first' | 'new-first';
    syncMasteredToCanvas: boolean;
    enableAnimation: boolean;
}

export interface HiWordsSettings {
    vocabularyBooks: VocabularyBook[];
    studyProgress?: Record<string, StudyProgressItem>;
    flashcard?: FlashcardSettings;
    showDefinitionOnHover: boolean;
    enableAutoHighlight: boolean;
    highlightStyle: HighlightStyle;
    enableMasteredFeature: boolean;
    showMasteredInSidebar: boolean;
    blurDefinitions: boolean;
    showSidebar?: boolean;
    masteredDetection?: 'group' | 'color';
    ttsTemplate?: string;
    pronunciationVariant?: 'uk' | 'us';
    aiService: AIServiceSettings;
    aiDefinition: AIDefinitionSettings;
    autoLayoutEnabled?: boolean;
    cardWidth?: number;
    cardHeight?: number;
    highlightMode?: 'all' | 'exclude' | 'include';
    highlightPaths?: string;
    fileNodeParseMode?: 'filename' | 'content' | 'filename-with-alias';
    enableSectionTabs?: boolean;
    sidebarDefaultDisplayMode?: 'detail' | 'word';
    selectionTranslate: SelectionTranslateSettings;
    hideDefinitions?: boolean;
    defaultVocabularyBookPaths?: string[];
}
```

- [ ] **Step 2：运行类型检查**

Run: `npm run build`
Expected: 仅提示 `flashcard` 相关字段未使用（后续任务会消除），无类型错误。

---

## Task 2：更新默认设置

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1：在 `DEFAULT_HIWORDS_SETTINGS` 中加入闪卡默认值**

在 `cardHeight: 120` 之后、`highlightMode: 'all'` 之前插入：

```ts
  flashcard: {
    defaultMode: 'word-to-definition',
    newWordSteps: 2,
    masteredThreshold: { reps: 3, minEf: 2.5 },
    dailyNewWordLimit: 20,
    dailyReviewLimit: 50,
    studyOrder: 'review-first',
    syncMasteredToCanvas: true,
    enableAnimation: true,
  },
```

- [ ] **Step 2：编译验证**

Run: `npm run build`
Expected: PASS（`tsc -noEmit` 与 esbuild 均成功）。

---

## Task 3：调整 `MasteredService` 的进度持久化

**Files:**
- Modify: `src/hiwords/core/mastered-service.ts`

- [ ] **Step 1：修改 `saveStudyProgress`，保留 SM-2 字段**

将 `private async saveStudyProgress(...)` 替换为：

```ts
    private async saveStudyProgress(wordDef: WordDefinition | null, mastered: boolean): Promise<void> {
        if (!wordDef?.studyKey) return;

        if (!this.plugin.hiwordsSettings.studyProgress) {
            this.plugin.hiwordsSettings.studyProgress = {};
        }

        const existing = this.plugin.hiwordsSettings.studyProgress[wordDef.studyKey];
        const now = new Date().toISOString();

        if (!mastered) {
            if (existing) {
                this.plugin.hiwordsSettings.studyProgress[wordDef.studyKey] = {
                    ...existing,
                    status: 'review',
                    updatedAt: now,
                };
            } else {
                delete this.plugin.hiwordsSettings.studyProgress[wordDef.studyKey];
            }
            await this.plugin.saveHiWordsSettings();
            return;
        }

        this.plugin.hiwordsSettings.studyProgress[wordDef.studyKey] = {
            ...(existing || {}),
            status: 'mastered',
            masteredAt: existing?.masteredAt || now,
            updatedAt: now,
        };
        await this.plugin.saveHiWordsSettings();
    }
```

- [ ] **Step 2：编译验证**

Run: `npm run build`
Expected: PASS。

---

## Task 4：实现 SM-2 算法

**Files:**
- Create: `src/hiwords/core/flashcard-algorithm.ts`

- [ ] **Step 1：创建算法模块**

```ts
import type { StudyProgressItem, FlashcardSettings } from '../utils';

export type FlashcardRating = 'again' | 'hard' | 'good' | 'easy';
export type FlashcardQuality = 0 | 3 | 4 | 5;

function startOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function addDays(date: Date, days: number): Date {
    const result = startOfDay(date);
    result.setDate(result.getDate() + days);
    return result;
}

function toISODate(date: Date): string {
    return startOfDay(date).toISOString();
}

export function getQuality(rating: FlashcardRating): FlashcardQuality {
    switch (rating) {
        case 'again': return 0;
        case 'hard': return 3;
        case 'good': return 4;
        case 'easy': return 5;
    }
}

export function calculateEf(ef: number, quality: FlashcardQuality): number {
    return Math.max(1.3, ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
}

export function applySm2(progress: StudyProgressItem, rating: FlashcardRating): StudyProgressItem {
    const quality = getQuality(rating);
    const ef = calculateEf(progress.ef ?? 2.5, quality);
    let interval: number;
    let reps = progress.reps || 0;

    if (quality < 3) {
        reps = 0;
        interval = 1;
    } else {
        reps += 1;
        if (reps === 1) interval = 1;
        else if (reps === 2) interval = 6;
        else interval = Math.round((progress.interval || 1) * ef);
    }

    return {
        ...progress,
        status: progress.status === 'mastered' ? 'mastered' : 'review',
        ef,
        reps,
        interval,
        dueDate: toISODate(addDays(new Date(), interval)),
        lastReview: new Date().toISOString(),
    };
}

export interface ReviewRatingResult {
    progress: StudyProgressItem;
    graduated: boolean;
    mastered: boolean;
}

export function applyReviewRating(
    progress: StudyProgressItem,
    rating: FlashcardRating,
    settings: FlashcardSettings
): ReviewRatingResult {
    const quality = getQuality(rating);
    let next: StudyProgressItem = { ...progress };
    let graduated = false;
    let mastered = false;

    if (progress.status === 'new' || progress.status === 'learning' || !progress.status) {
        const stage = progress.stage || 0;
        let nextStage = stage;
        if (rating === 'good' || rating === 'easy') {
            nextStage = stage + 1;
        } else if (rating === 'again' || rating === 'hard') {
            nextStage = 0;
        }

        if (nextStage >= settings.newWordSteps) {
            const ef = calculateEf(progress.ef ?? 2.5, quality);
            next = {
                ...progress,
                status: 'review',
                stage: nextStage,
                reps: 1,
                ef,
                interval: 1,
                dueDate: toISODate(addDays(new Date(), 1)),
                lastReview: new Date().toISOString(),
            };
            graduated = true;
        } else {
            next = {
                ...progress,
                status: 'learning',
                stage: nextStage,
                lastReview: new Date().toISOString(),
            };
        }
    } else {
        next = applySm2(progress, rating);
    }

    if (next.status === 'review' && settings.masteredThreshold) {
        if (
            (next.reps || 0) >= settings.masteredThreshold.reps &&
            (next.ef || 0) >= settings.masteredThreshold.minEf
        ) {
            next.status = 'mastered';
            mastered = true;
        }
    }

    return { progress: next, graduated, mastered };
}
```

- [ ] **Step 2：编译验证**

Run: `npm run build`
Expected: PASS。

---

## Task 5：测试 SM-2 算法

**Files:**
- Create: `src/hiwords/core/flashcard-algorithm.test.ts`
- Delete after run: `src/hiwords/core/flashcard-algorithm.test.ts`、`.tmp-test/`

- [ ] **Step 1：编写独立测试文件**

```ts
import { applyReviewRating, applySm2 } from './flashcard-algorithm';
import type { FlashcardSettings, StudyProgressItem } from '../utils/types';

const settings: FlashcardSettings = {
    defaultMode: 'word-to-definition',
    newWordSteps: 2,
    masteredThreshold: { reps: 3, minEf: 2.5 },
    dailyNewWordLimit: 20,
    dailyReviewLimit: 50,
    studyOrder: 'review-first',
    syncMasteredToCanvas: true,
    enableAnimation: true,
};

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

// 新词学习：连续两次 good 毕业
let p: StudyProgressItem = { status: 'learning', stage: 0, reps: 0, ef: 2.5, interval: 0 };
let r = applyReviewRating(p, 'good', settings);
assert(r.progress.status === 'learning' && r.progress.stage === 1, 'first good should stage 1');
r = applyReviewRating(r.progress, 'good', settings);
assert(r.graduated === true, 'should graduate after newWordSteps');
assert(r.progress.status === 'review', 'graduated status review');
assert(r.progress.reps === 1, 'graduated reps 1');
assert(r.progress.interval === 1, 'graduated interval 1');

// 复习 good 三次后掌握
p = { status: 'review', reps: 0, ef: 2.5, interval: 1 };
r = applyReviewRating(p, 'good', settings);
assert(r.progress.reps === 1 && !r.mastered, 'review good 1');
r = applyReviewRating(r.progress, 'good', settings);
assert(r.progress.reps === 2 && !r.mastered, 'review good 2');
r = applyReviewRating(r.progress, 'good', settings);
assert(r.mastered === true, 'should be mastered after 3 good');
assert(r.progress.status === 'mastered', 'mastered status');

// again 重置 reps
p = { status: 'review', reps: 5, ef: 2.5, interval: 10 };
r = applyReviewRating(p, 'again', settings);
assert(r.progress.reps === 0, 'again resets reps');
assert(r.progress.interval === 1, 'again interval 1');

// easy 增加 ef
p = { status: 'review', reps: 2, ef: 2.5, interval: 6 };
r = applySm2(p, 'easy');
assert(r.ef > 2.5, 'easy increases ef');

console.log('flashcard-algorithm tests passed');
```

- [ ] **Step 2：编译并运行测试**

Run:
```bash
npx tsc -p tsconfig.json --skipLibCheck --outDir .tmp-test
node .tmp-test/src/hiwords/core/flashcard-algorithm.test.js
```
Expected: 输出 `flashcard-algorithm tests passed`。

- [ ] **Step 3：清理测试产物**

Run: `rm -rf .tmp-test src/hiwords/core/flashcard-algorithm.test.ts`
Expected: 目录与文件已删除。

---

## Task 6：实现复习队列构建器

**Files:**
- Create: `src/hiwords/core/flashcard-queue.ts`

- [ ] **Step 1：创建队列模块**

```ts
import type { StudyItem, StudyProgressItem, FlashcardSettings, WordDefinition } from '../utils';

export interface FlashcardQueueItem {
    studyKey: string;
    studyItem: StudyItem;
    primary: WordDefinition;
    progress: StudyProgressItem;
    isNew: boolean;
}

function startOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function toISODate(date: Date): string {
    return startOfDay(date).toISOString();
}

function normalizeProgress(progress: StudyProgressItem): StudyProgressItem {
    if (progress.status === 'mastered') {
        return {
            ...progress,
            status: 'mastered',
            ef: progress.ef ?? 2.5,
            reps: progress.reps ?? 3,
            interval: progress.interval ?? 0,
        };
    }
    return progress;
}

function createNewProgress(): StudyProgressItem {
    return {
        status: 'learning',
        stage: 0,
        reps: 0,
        ef: 2.5,
        interval: 0,
    };
}

export interface BookReviewStats {
    total: number;
    dueToday: number;
    new: number;
}

export function getBookReviewStats(
    bookPath: string,
    studyItems: StudyItem[],
    studyProgress: Record<string, StudyProgressItem>,
    today: Date = new Date()
): BookReviewStats {
    const todayStr = toISODate(today);
    let total = 0;
    let dueToday = 0;
    let newCount = 0;

    for (const item of studyItems) {
        if (!item.sources.some(s => s.source === bookPath)) continue;
        total++;
        const progress = studyProgress[item.studyKey];
        if (!progress) {
            newCount++;
        } else {
            const normalized = normalizeProgress(progress);
            if (normalized.status !== 'mastered' && (!normalized.dueDate || normalized.dueDate <= todayStr)) {
                dueToday++;
            }
        }
    }

    return { total, dueToday, new: newCount };
}

export function buildFlashcardQueue(
    studyItems: StudyItem[],
    selectedBookPaths: string[],
    studyProgress: Record<string, StudyProgressItem>,
    settings: FlashcardSettings,
    today: Date = new Date()
): FlashcardQueueItem[] {
    const todayStr = toISODate(today);
    const reviewPool: FlashcardQueueItem[] = [];
    const newPool: FlashcardQueueItem[] = [];
    const seen = new Set<string>();

    for (const item of studyItems) {
        const isCanvas = item.sources.some(s => s.source.endsWith('.canvas'));
        if (!isCanvas) continue;
        const inSelectedBooks = selectedBookPaths.length === 0 || item.sources.some(s => selectedBookPaths.includes(s.source));
        if (!inSelectedBooks) continue;
        if (seen.has(item.studyKey)) continue;
        seen.add(item.studyKey);

        let progress = studyProgress[item.studyKey];
        if (!progress) {
            progress = createNewProgress();
            newPool.push({
                studyKey: item.studyKey,
                studyItem: item,
                primary: item.primary,
                progress,
                isNew: true,
            });
        } else {
            const normalized = normalizeProgress(progress);
            if (normalized.status !== 'mastered' && (!normalized.dueDate || normalized.dueDate <= todayStr)) {
                reviewPool.push({
                    studyKey: item.studyKey,
                    studyItem: item,
                    primary: item.primary,
                    progress: normalized,
                    isNew: false,
                });
            }
        }
    }

    const limitedReview = reviewPool.slice(0, settings.dailyReviewLimit);
    const limitedNew = newPool.slice(0, settings.dailyNewWordLimit);

    return settings.studyOrder === 'review-first'
        ? [...limitedReview, ...limitedNew]
        : [...limitedNew, ...limitedReview];
}

export function getTodayTotalTaskCount(
    studyItems: StudyItem[],
    studyProgress: Record<string, StudyProgressItem>,
    settings: FlashcardSettings,
    bookPaths?: string[],
    today: Date = new Date()
): number {
    const todayStr = toISODate(today);
    const limit = settings.dailyReviewLimit + settings.dailyNewWordLimit;
    let count = 0;

    const bookSet = bookPaths && bookPaths.length > 0 ? new Set(bookPaths) : null;

    for (const item of studyItems) {
        const isCanvas = item.sources.some(s => s.source.endsWith('.canvas'));
        if (!isCanvas) continue;
        if (bookSet && !item.sources.some(s => bookSet.has(s.source))) continue;

        const progress = studyProgress[item.studyKey];
        if (!progress) {
            count++;
        } else {
            const normalized = normalizeProgress(progress);
            if (normalized.status !== 'mastered' && (!normalized.dueDate || normalized.dueDate <= todayStr)) {
                count++;
            }
        }
        if (count >= limit) break;
    }

    return count;
}
```

- [ ] **Step 2：编译验证**

Run: `npm run build`
Expected: PASS。

---

## Task 7：测试复习队列

**Files:**
- Create: `src/hiwords/core/flashcard-queue.test.ts`
- Delete after run: `src/hiwords/core/flashcard-queue.test.ts`、`.tmp-test/`

- [ ] **Step 1：编写测试文件**

```ts
import { buildFlashcardQueue, getTodayTotalTaskCount } from './flashcard-queue';
import type { FlashcardSettings, StudyItem, StudyProgressItem, WordDefinition } from '../utils/types';

const settings: FlashcardSettings = {
    defaultMode: 'word-to-definition',
    newWordSteps: 2,
    masteredThreshold: { reps: 3, minEf: 2.5 },
    dailyNewWordLimit: 2,
    dailyReviewLimit: 2,
    studyOrder: 'review-first',
    syncMasteredToCanvas: true,
    enableAnimation: true,
};

function makeItem(word: string, source: string): StudyItem {
    const def: WordDefinition = {
        word,
        definition: 'def',
        source,
        nodeId: `node-${word}`,
    };
    return {
        studyKey: `en:word:${word}`,
        word,
        aliases: [],
        mastered: false,
        sources: [def],
        primary: def,
    };
}

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

const today = new Date();
const dueOld: StudyProgressItem = { status: 'review', reps: 1, ef: 2.5, interval: 1, dueDate: new Date(today.getTime() - 86400000).toISOString() };
const dueFuture: StudyProgressItem = { status: 'review', reps: 1, ef: 2.5, interval: 3, dueDate: new Date(today.getTime() + 86400000 * 3).toISOString() };
const mastered: StudyProgressItem = { status: 'mastered', reps: 3, ef: 2.5 };

const progress: Record<string, StudyProgressItem> = {
    'en:word:old1': dueOld,
    'en:word:old2': dueOld,
    'en:word:old3': dueOld,
    'en:word:future': dueFuture,
    'en:word:mastered': mastered,
};

const items: StudyItem[] = [
    makeItem('old1', 'book.canvas'),
    makeItem('old2', 'book.canvas'),
    makeItem('old3', 'book.canvas'),
    makeItem('future', 'book.canvas'),
    makeItem('mastered', 'book.canvas'),
    makeItem('new1', 'book.canvas'),
    makeItem('new2', 'book.canvas'),
    makeItem('new3', 'book.canvas'),
];

const queue = buildFlashcardQueue(items, ['book.canvas'], progress, settings, today);
assert(queue.length === 4, `queue length should be 4, got ${queue.length}`);
assert(queue[0].isNew === false, 'review-first first item should be review');
assert(queue[2].isNew === true, 'review-first third item should be new');
assert(queue.filter(q => q.isNew).length === 2, 'new limit 2');
assert(queue.filter(q => !q.isNew).length === 2, 'review limit 2');

const count = getTodayTotalTaskCount(items, progress, settings, ['book.canvas'], today);
assert(count === 4, `today count should be 4, got ${count}`);

console.log('flashcard-queue tests passed');
```

- [ ] **Step 2：编译并运行**

Run:
```bash
npx tsc -p tsconfig.json --skipLibCheck --outDir .tmp-test
node .tmp-test/src/hiwords/core/flashcard-queue.test.js
```
Expected: 输出 `flashcard-queue tests passed`。

- [ ] **Step 3：清理**

Run: `rm -rf .tmp-test src/hiwords/core/flashcard-queue.test.ts`
Expected: 已删除。

---

## Task 8：实现闪卡复习弹窗

**Files:**
- Create: `src/hiwords/ui/flashcard-review-modal.ts`

- [ ] **Step 1：创建完整复习弹窗文件**

```ts
import { App, Modal, Notice, MarkdownRenderer, MarkdownView, setIcon } from 'obsidian';
import type NoteBarPlugin from '../../main';
import type { StudyProgressItem, FlashcardSettings, WordDefinition } from '../utils';
import { playWordTTS } from '../utils';
import { buildFlashcardQueue, type FlashcardQueueItem } from '../core/flashcard-queue';
import { applyReviewRating, type FlashcardRating } from '../core/flashcard-algorithm';

export type FlashcardMode = 'word-to-definition' | 'definition-to-word';

const DEFAULT_FLASHCARD_SETTINGS: FlashcardSettings = {
    defaultMode: 'word-to-definition',
    newWordSteps: 2,
    masteredThreshold: { reps: 3, minEf: 2.5 },
    dailyNewWordLimit: 20,
    dailyReviewLimit: 50,
    studyOrder: 'review-first',
    syncMasteredToCanvas: true,
    enableAnimation: true,
};

export class FlashcardReviewModal extends Modal {
    private plugin: NoteBarPlugin;
    private settings: FlashcardSettings;
    private mode: FlashcardMode;
    private queue: FlashcardQueueItem[];
    private currentIndex = 0;
    private flipped = false;
    private animating = false;
    private stats = { total: 0, new: 0, mastered: 0 };

    private headerEl: HTMLElement;
    private bodyEl: HTMLElement;
    private footerEl: HTMLElement;
    private cardEl: HTMLElement;
    private frontWordEl: HTMLElement;
    private frontPhoneticEl: HTMLElement;
    private backWordEl: HTMLElement;
    private backPhoneticEl: HTMLElement;
    private backNotesEl: HTMLElement;
    private spellInput: HTMLInputElement;
    private spellFeedback: HTMLElement;
    private progressEl: HTMLElement;
    private endScreenEl: HTMLElement;
    private toastEl: HTMLElement;

    constructor(app: App, plugin: NoteBarPlugin, selectedBookPaths: string[]) {
        super(app);
        this.plugin = plugin;
        this.settings = plugin.hiwordsSettings.flashcard ?? DEFAULT_FLASHCARD_SETTINGS;
        this.mode = this.settings.defaultMode;

        const vocabularyManager = plugin.vocabularyManager;
        const studyItems = vocabularyManager?.getStudyItems() || [];
        const progress = plugin.hiwordsSettings.studyProgress || {};
        this.queue = buildFlashcardQueue(studyItems, selectedBookPaths, progress, this.settings);
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass('mod-note-bar-flashcard');
        if (!this.settings.enableAnimation) {
            modalEl.addClass('no-animation');
        }
        contentEl.empty();
        contentEl.addClass('flashcard-modal-content');

        if (this.queue.length === 0) {
            this.renderEmptyState(contentEl);
            return;
        }

        this.headerEl = contentEl.createDiv({ cls: 'flashcard-header' });
        this.bodyEl = contentEl.createDiv({ cls: 'flashcard-body' });
        this.footerEl = contentEl.createDiv({ cls: 'flashcard-footer' });

        this.toastEl = this.bodyEl.createDiv({ cls: 'flashcard-toast' });
        this.renderHeader();
        this.renderCardScene();
        this.renderEndScreen();
        this.renderFooter();

        this.renderCard();

        this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => this.onKeyDown(evt));
    }

    onClose() {
        this.contentEl.empty();
    }

    private renderEmptyState(container: HTMLElement) {
        container.createEl('h3', { text: '暂无复习内容', cls: 'flashcard-empty-title' });
        container.createEl('p', {
            text: '所选单词本没有今日到期或新词。',
            cls: 'flashcard-empty-text'
        });
        const closeBtn = container.createEl('button', {
            text: '关闭',
            cls: 'flashcard-primary-btn'
        });
        closeBtn.onclick = () => this.close();
    }

    private renderHeader() {
        this.headerEl.empty();

        const modeToggle = this.headerEl.createDiv({ cls: 'flashcard-mode-toggle' });

        const wordModeBtn = modeToggle.createEl('button', {
            cls: `flashcard-mode-btn ${this.mode === 'word-to-definition' ? 'active' : ''}`,
            text: '英→中'
        });
        wordModeBtn.onclick = () => this.setMode('word-to-definition');

        const defModeBtn = modeToggle.createEl('button', {
            cls: `flashcard-mode-btn ${this.mode === 'definition-to-word' ? 'active' : ''}`,
            text: '中→英'
        });
        defModeBtn.onclick = () => this.setMode('definition-to-word');

        this.progressEl = this.headerEl.createDiv({ cls: 'flashcard-progress' });

        const closeBtn = this.headerEl.createEl('button', {
            cls: 'flashcard-close-btn',
            text: '×'
        });
        closeBtn.onclick = () => this.close();
    }

    private renderCardScene() {
        const scene = this.bodyEl.createDiv({ cls: 'flashcard-card-scene' });
        this.cardEl = scene.createDiv({ cls: 'flashcard-card' });

        const front = this.cardEl.createDiv({ cls: 'flashcard-card-face flashcard-card-face-front' });
        this.frontWordEl = front.createDiv({ cls: 'flashcard-word' });
        this.frontPhoneticEl = front.createDiv({ cls: 'flashcard-phonetic' });

        const speakBtn = front.createEl('button', {
            cls: 'flashcard-speak-btn',
            attr: { 'aria-label': '播放发音' }
        });
        setIcon(speakBtn, 'volume-2');
        speakBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.playAudio();
        });

        const spellSection = front.createDiv({ cls: 'flashcard-spell-section' });
        this.spellInput = spellSection.createEl('input', {
            type: 'text',
            cls: 'flashcard-spell-input',
            placeholder: '输入单词后按回车检查拼写',
            attr: { autocomplete: 'off' }
        });
        this.spellInput.addEventListener('click', (e) => e.stopPropagation());
        this.spellInput.addEventListener('input', () => {
            this.spellInput.removeClass('correct', 'wrong');
            this.spellFeedback.textContent = '';
        });
        this.spellFeedback = spellSection.createDiv({ cls: 'flashcard-spell-feedback' });

        front.createDiv({
            cls: 'flashcard-flip-hint',
            text: '按 空格 或点击卡片翻转'
        });

        const back = this.cardEl.createDiv({ cls: 'flashcard-card-face flashcard-card-face-back' });
        const backHeader = back.createDiv({ cls: 'flashcard-back-header' });
        const backTitle = backHeader.createDiv();
        this.backWordEl = backTitle.createDiv({ cls: 'flashcard-back-word' });
        this.backPhoneticEl = backTitle.createDiv({ cls: 'flashcard-back-phonetic' });
        this.backNotesEl = back.createDiv({ cls: 'flashcard-notes' });

        this.cardEl.addEventListener('click', () => this.flip());
    }

    private renderEndScreen() {
        this.endScreenEl = this.bodyEl.createDiv({ cls: 'flashcard-end-screen' });
        this.endScreenEl.createDiv({ cls: 'flashcard-end-title', text: '本轮复习完成' });

        const stats = this.endScreenEl.createDiv({ cls: 'flashcard-end-stats' });
        stats.innerHTML = `
            <div class="flashcard-end-stat"><strong class="flashcard-stat-total">0</strong>复习单词</div>
            <div class="flashcard-end-stat"><strong class="flashcard-stat-new">0</strong>新词</div>
            <div class="flashcard-end-stat"><strong class="flashcard-stat-mastered">0</strong>已掌握</div>
        `;

        const actions = this.endScreenEl.createDiv({ cls: 'flashcard-end-actions' });
        const restartBtn = actions.createEl('button', {
            cls: 'flashcard-primary-btn',
            text: '再复习一组'
        });
        restartBtn.onclick = () => this.restart();

        const finishBtn = actions.createEl('button', {
            cls: 'flashcard-secondary-btn',
            text: '完成'
        });
        finishBtn.onclick = () => this.close();
    }

    private renderFooter() {
        this.footerEl.empty();

        const ratingRow = this.footerEl.createDiv({ cls: 'flashcard-rating-row' });

        const againBtn = ratingRow.createEl('button', {
            cls: 'flashcard-rating-btn flashcard-rating-btn-again',
            text: '不认识',
            attr: { 'data-key': 's' }
        });
        againBtn.onclick = () => this.rate('again');

        const hardBtn = ratingRow.createEl('button', {
            cls: 'flashcard-rating-btn flashcard-rating-btn-hard',
            text: '模糊',
            attr: { 'data-key': 'd' }
        });
        hardBtn.onclick = () => this.rate('hard');

        const goodBtn = ratingRow.createEl('button', {
            cls: 'flashcard-rating-btn flashcard-rating-btn-good',
            text: '认识',
            attr: { 'data-key': 'f' }
        });
        goodBtn.onclick = () => this.rate('good');

        const easyBtn = this.footerEl.createEl('button', {
            cls: 'flashcard-super-easy-btn',
            text: '太简单'
        });
        easyBtn.onclick = () => this.rate('easy');

        const hint = this.footerEl.createDiv({ cls: 'flashcard-hint' });
        hint.innerHTML = `
            <span><kbd>空格</kbd> 翻转</span>
            <span><kbd>s</kbd> 不认识</span>
            <span><kbd>d</kbd> 模糊</span>
            <span><kbd>f</kbd> 认识</span>
        `;
    }

    private async renderCard() {
        if (this.currentIndex >= this.queue.length) return;

        const item = this.queue[this.currentIndex];
        const wordDef = item.primary;

        this.spellInput.value = '';
        this.spellInput.removeClass('correct', 'wrong');
        this.spellFeedback.textContent = '';

        const phonetic = wordDef.card?.phonetic || wordDef.phonetic || '';

        if (this.mode === 'word-to-definition') {
            this.frontWordEl.textContent = wordDef.word;
            this.frontWordEl.removeClass('flashcard-definition-front');
            this.frontPhoneticEl.style.display = 'block';
            this.frontPhoneticEl.textContent = phonetic;
        } else {
            this.frontWordEl.textContent = this.extractDefinition(wordDef.definition);
            this.frontWordEl.addClass('flashcard-definition-front');
            this.frontPhoneticEl.style.display = 'none';
        }

        this.backWordEl.textContent = wordDef.word;
        this.backPhoneticEl.textContent = phonetic;

        this.backNotesEl.empty();
        const content = wordDef.rawDefinition || wordDef.definition || '暂无释义';
        const leaf = this.app.workspace.getMostRecentLeaf();
        const activeView = leaf?.view instanceof MarkdownView ? leaf.view : null;
        const sourcePath = (activeView && activeView.file?.path) || this.app.workspace.getActiveFile()?.path || '';

        try {
            await MarkdownRenderer.render(this.app, content, this.backNotesEl, sourcePath, this.plugin);
        } catch (e) {
            this.backNotesEl.textContent = content;
        }

        this.updateProgress();
    }

    private updateProgress() {
        this.progressEl.textContent = `${this.currentIndex + 1} / ${this.queue.length}`;
    }

    private extractDefinition(definition: string): string {
        const match = definition.match(/\*\*[^*]+\*\*\s*[^\n]+/);
        if (match) return match[0].replace(/\*\*/g, '');
        const firstLine = definition.split('\n')[0];
        return firstLine || definition;
    }

    private setMode(mode: FlashcardMode) {
        if (this.mode === mode) return;
        this.mode = mode;
        this.flipped = false;
        this.cardEl.removeClass('flipped');
        this.renderHeader();
        void this.renderCard();
    }

    private flip() {
        if (this.animating) return;
        this.flipped = !this.flipped;
        this.cardEl.toggleClass('flipped', this.flipped);
    }

    private playAudio() {
        const item = this.queue[this.currentIndex];
        if (!item) return;
        void playWordTTS(this.app, this.plugin.hiwordsSettings, item.primary.word, item.primary);
    }

    private checkSpell() {
        const item = this.queue[this.currentIndex];
        const input = this.spellInput.value.trim().toLowerCase();
        const target = item.primary.word.toLowerCase();
        const aliases = item.primary.aliases?.map(a => a.toLowerCase()) || [];
        const correct = input === target || aliases.includes(input);

        this.spellInput.removeClass('correct', 'wrong');
        if (correct) {
            this.spellInput.addClass('correct');
            this.spellFeedback.textContent = '✓ 拼写正确';
        } else {
            this.spellInput.addClass('wrong');
            this.spellFeedback.textContent = `✗ 正确拼写：${item.primary.word}`;
        }
    }

    private async rate(rating: FlashcardRating) {
        if (this.animating || this.currentIndex >= this.queue.length) return;
        this.animating = true;

        const item = this.queue[this.currentIndex];
        const { progress, mastered } = applyReviewRating(item.progress, rating, this.settings);
        item.progress = progress;

        await this.saveProgress(item, rating);

        if (mastered && this.settings.syncMasteredToCanvas) {
            await this.syncMastered(item);
        }

        this.stats.total++;
        if (item.isNew) this.stats.new++;
        if (mastered) this.stats.mastered++;

        const direction = (rating === 'good' || rating === 'easy') ? 'right' : 'left';
        this.showToast(`${this.ratingLabel(rating)} · 已记录`);
        this.cardEl.addClass(direction === 'right' ? 'slide-out-right' : 'slide-out-left');

        activeWindow.setTimeout(() => {
            this.currentIndex++;
            if (this.currentIndex >= this.queue.length) {
                this.showEnd();
                return;
            }

            this.flipped = false;
            this.cardEl.removeClass('flipped', 'slide-out-right', 'slide-out-left');
            this.cardEl.addClass('slide-in');

            void this.renderCard().then(() => {
                activeWindow.setTimeout(() => {
                    this.cardEl.removeClass('slide-in');
                    this.animating = false;
                }, 550);
            });
        }, 450);
    }

    private async saveProgress(item: FlashcardQueueItem, rating: FlashcardRating) {
        const settings = this.plugin.hiwordsSettings;
        if (!settings.studyProgress) settings.studyProgress = {};

        const history = item.progress.history || [];
        const record: import('../utils').ReviewRecord = {
            date: new Date().toISOString(),
            quality: rating
        };

        settings.studyProgress[item.studyKey] = {
            ...item.progress,
            history: [...history, record].slice(-50)
        };

        await this.plugin.saveHiWordsSettings();
    }

    private async syncMastered(item: FlashcardQueueItem) {
        const masteredService = this.plugin.masteredService;
        if (!masteredService || !this.plugin.hiwordsSettings.enableMasteredFeature) return;

        for (const source of item.studyItem.sources) {
            if (source.source.endsWith('.hiwords')) continue;
            await masteredService.markWordAsMastered(source.source, source.nodeId, source.word);
        }
    }

    private showEnd() {
        const scene = this.bodyEl.querySelector('.flashcard-card-scene');
        if (scene) (scene as HTMLElement).addClass('hide');
        this.footerEl.addClass('hide');

        this.endScreenEl.addClass('show');
        const totalEl = this.endScreenEl.querySelector('.flashcard-stat-total');
        const newEl = this.endScreenEl.querySelector('.flashcard-stat-new');
        const masteredEl = this.endScreenEl.querySelector('.flashcard-stat-mastered');
        if (totalEl) totalEl.setText(String(this.stats.total));
        if (newEl) newEl.setText(String(this.stats.new));
        if (masteredEl) masteredEl.setText(String(this.stats.mastered));

        this.animating = false;
    }

    private restart() {
        this.currentIndex = 0;
        this.flipped = false;
        this.stats = { total: 0, new: 0, mastered: 0 };

        this.endScreenEl.removeClass('show');
        this.cardEl.removeClass('flipped');

        const scene = this.bodyEl.querySelector('.flashcard-card-scene');
        if (scene) (scene as HTMLElement).removeClass('hide');
        this.footerEl.removeClass('hide');

        void this.renderCard();
    }

    private showToast(message: string) {
        this.toastEl.textContent = message;
        this.toastEl.addClass('show');
        activeWindow.setTimeout(() => {
            this.toastEl.removeClass('show');
        }, 1600);
    }

    private ratingLabel(rating: FlashcardRating): string {
        switch (rating) {
            case 'again': return '不认识';
            case 'hard': return '模糊';
            case 'good': return '认识';
            case 'easy': return '太简单';
        }
    }

    private onKeyDown(evt: KeyboardEvent) {
        if (this.animating) return;

        if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLTextAreaElement) {
            if (evt.key === 'Enter' && evt.target === this.spellInput) {
                evt.preventDefault();
                this.checkSpell();
            }
            return;
        }

        switch (evt.key) {
            case ' ':
            case 'Spacebar':
                evt.preventDefault();
                this.flip();
                break;
            case 'f':
            case 'F':
                evt.preventDefault();
                this.rate('good');
                break;
            case 'd':
            case 'D':
                evt.preventDefault();
                this.rate('hard');
                break;
            case 's':
            case 'S':
                evt.preventDefault();
                this.rate('again');
                break;
        }
    }
}
```

- [ ] **Step 2：编译验证**

Run: `npm run build`
Expected: PASS。

---

## Task 9：实现单词本选择弹窗

**Files:**
- Create: `src/hiwords/ui/flashcard-book-picker-modal.ts`

- [ ] **Step 1：创建选择弹窗文件**

```ts
import { App, Modal, Notice } from 'obsidian';
import type NoteBarPlugin from '../../main';
import { getBookReviewStats } from '../core/flashcard-queue';
import { FlashcardReviewModal } from './flashcard-review-modal';

export class FlashcardBookPickerModal extends Modal {
    private plugin: NoteBarPlugin;
    private selectedPaths: string[] = [];

    constructor(app: App, plugin: NoteBarPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flashcard-book-picker-content');
        contentEl.createEl('h2', { text: '选择本次复习的单词本' });

        const enabledCanvasBooks = this.plugin.hiwordsSettings.vocabularyBooks
            .filter(b => b.enabled && b.path.endsWith('.canvas'));

        if (enabledCanvasBooks.length === 0) {
            contentEl.createEl('p', {
                text: '没有可用的 Canvas 单词本，请先在设置中启用。',
                cls: 'setting-item-description'
            });
            const closeBtn = contentEl.createEl('button', { text: '关闭' });
            closeBtn.onclick = () => this.close();
            return;
        }

        const vocabularyManager = this.plugin.vocabularyManager;
        const studyItems = vocabularyManager?.getStudyItems() || [];
        const progress = this.plugin.hiwordsSettings.studyProgress || {};

        const listContainer = contentEl.createDiv({ cls: 'flashcard-book-list' });

        for (const book of enabledCanvasBooks) {
            const stats = getBookReviewStats(book.path, studyItems, progress);
            const row = listContainer.createDiv({ cls: 'flashcard-book-row' });

            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.style.width = '16px';
            checkbox.style.height = '16px';
            checkbox.style.flexShrink = '0';
            checkbox.style.marginRight = '10px';
            checkbox.style.cursor = 'pointer';
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectedPaths.push(book.path);
                } else {
                    this.selectedPaths = this.selectedPaths.filter(p => p !== book.path);
                }
            });

            const info = row.createDiv({ cls: 'flashcard-book-info' });
            info.createDiv({ cls: 'flashcard-book-name', text: book.name });
            info.createDiv({
                cls: 'flashcard-book-meta',
                text: `共 ${stats.total} 词 · 今日到期 ${stats.dueToday} · 新词 ${stats.new}`
            });
        }

        const buttonContainer = contentEl.createDiv({ cls: 'flashcard-button-container' });

        const startBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: '开始复习'
        });
        startBtn.onclick = () => {
            if (this.selectedPaths.length === 0) {
                new Notice('请至少选择一个单词本');
                return;
            }
            this.close();
            new FlashcardReviewModal(this.app, this.plugin, this.selectedPaths).open();
        };

        const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
        cancelBtn.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}
```

- [ ] **Step 2：编译验证**

Run: `npm run build`
Expected: PASS。

---

## Task 10：注册命令与设置入口

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1：导入弹窗类**

在 `src/main.ts` 的 import 区添加：

```ts
import { FlashcardBookPickerModal } from "./hiwords/ui/flashcard-book-picker-modal";
```

- [ ] **Step 2：注册命令**

在 `// 命令：导出单词本为 Excel` 之后添加：

```ts
    // 命令：开始闪卡复习
    this.addCommand({
      id: 'note-bar-start-flashcard-review',
      name: '开始闪卡复习',
      callback: () => {
        new FlashcardBookPickerModal(this.app, this).open();
      }
    });
```

- [ ] **Step 3：在设置页新增「闪卡复习」分区**

在 `NoteBarSettingTab.display()` 的「显示设置」区块之前插入以下代码（即放在 book list 之后、显示设置之前）：

```ts
    // 闪卡复习设置
    containerEl.createEl('h3', { text: '闪卡复习' });

    const flashcard = this.plugin.hiwordsSettings.flashcard ?? {
      defaultMode: 'word-to-definition',
      newWordSteps: 2,
      masteredThreshold: { reps: 3, minEf: 2.5 },
      dailyNewWordLimit: 20,
      dailyReviewLimit: 50,
      studyOrder: 'review-first',
      syncMasteredToCanvas: true,
      enableAnimation: true,
    };
    this.plugin.hiwordsSettings.flashcard = flashcard;

    new Setting(containerEl)
      .setName('默认复习模式')
      .setDesc('打开复习弹窗时默认正面显示的内容')
      .addDropdown(dropdown => dropdown
        .addOption('word-to-definition', '英→中')
        .addOption('definition-to-word', '中→英')
        .setValue(flashcard.defaultMode)
        .onChange(async (value) => {
          flashcard.defaultMode = value as 'word-to-definition' | 'definition-to-word';
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('每日新词上限')
      .setDesc('每轮复习最多出现几个新词')
      .addText(text => text
        .setValue(String(flashcard.dailyNewWordLimit))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          flashcard.dailyNewWordLimit = isNaN(num) ? 20 : Math.max(0, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('每日复习上限')
      .setDesc('每轮复习最多出现几个到期复习词')
      .addText(text => text
        .setValue(String(flashcard.dailyReviewLimit))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          flashcard.dailyReviewLimit = isNaN(num) ? 50 : Math.max(0, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('学习顺序')
      .setDesc('复习词与新词的出现顺序')
      .addDropdown(dropdown => dropdown
        .addOption('review-first', '先复习再学习新词')
        .addOption('new-first', '先学习新词再复习')
        .setValue(flashcard.studyOrder)
        .onChange(async (value) => {
          flashcard.studyOrder = value as 'review-first' | 'new-first';
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('新词学习步数')
      .setDesc('新词需要连续认识/太简单几次才进入复习阶段')
      .addText(text => text
        .setValue(String(flashcard.newWordSteps))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          flashcard.newWordSteps = isNaN(num) ? 2 : Math.max(1, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('掌握阈值 - 连续成功次数')
      .setDesc(' reps 达到多少时判定为已掌握')
      .addText(text => text
        .setValue(String(flashcard.masteredThreshold.reps))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          flashcard.masteredThreshold.reps = isNaN(num) ? 3 : Math.max(1, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('掌握阈值 - 最低 EF')
      .setDesc('熟练度因子最低值')
      .addText(text => text
        .setValue(String(flashcard.masteredThreshold.minEf))
        .onChange(async (value) => {
          const num = parseFloat(value);
          flashcard.masteredThreshold.minEf = isNaN(num) ? 2.5 : Math.max(1.3, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('自动同步已掌握到 Canvas')
      .setDesc('达到掌握阈值后自动移动到 Canvas 的 Mastered 分组')
      .addToggle(toggle => toggle
        .setValue(flashcard.syncMasteredToCanvas)
        .onChange(async (value) => {
          flashcard.syncMasteredToCanvas = value;
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('启用动画')
      .setDesc('翻转与切题动画开关')
      .addToggle(toggle => toggle
        .setValue(flashcard.enableAnimation)
        .onChange(async (value) => {
          flashcard.enableAnimation = value;
          await this.plugin.saveHiWordsSettings();
        }));
```

- [ ] **Step 4：编译验证**

Run: `npm run build`
Expected: PASS。

---

## Task 11：在侧边栏添加复习入口

**Files:**
- Modify: `src/hiwords/ui/sidebar-view.ts`

- [ ] **Step 1：导入依赖**

在文件顶部 import 区添加：

```ts
import { FlashcardBookPickerModal } from './flashcard-book-picker-modal';
import { getTodayTotalTaskCount } from '../core/flashcard-queue';
```

- [ ] **Step 2：在 renderWordList 中插入复习入口**

找到 `renderWordList` 方法中的：

```ts
        container.empty();
        this.bindDelegatedHandlers(container as HTMLElement);

        if (this.currentWords.length === 0) {
```

替换为：

```ts
        container.empty();
        this.bindDelegatedHandlers(container as HTMLElement);
        this.renderReviewHeader(container as HTMLElement);

        if (this.currentWords.length === 0) {
```

- [ ] **Step 3：实现复习入口渲染与计数**

在 `HiWordsSidebarView` 类中任意位置添加以下私有方法：

```ts
    private renderReviewHeader(container: HTMLElement) {
        const header = container.createDiv({ cls: 'hi-words-review-header' });
        header.createDiv({ cls: 'hi-words-review-title', text: 'HiWords 生词本' });

        const dueCount = this.getTodayReviewCount();
        const reviewBtn = header.createEl('button', {
            cls: 'hi-words-review-button',
            text: `今日待复习 ${dueCount}`
        });
        reviewBtn.onclick = () => {
            new FlashcardBookPickerModal(this.app, this.plugin).open();
        };
    }

    private getTodayReviewCount(): number {
        const vocabularyManager = this.plugin.vocabularyManager;
        if (!vocabularyManager) return 0;

        const settings = this.plugin.hiwordsSettings;
        const flashcard = settings.flashcard;
        if (!flashcard) return 0;

        const enabledCanvasBooks = settings.vocabularyBooks
            .filter(b => b.enabled && b.path.endsWith('.canvas'))
            .map(b => b.path);

        if (enabledCanvasBooks.length === 0) return 0;

        const studyItems = vocabularyManager.getStudyItems();
        const progress = settings.studyProgress || {};

        return getTodayTotalTaskCount(studyItems, progress, flashcard, enabledCanvasBooks);
    }
```

- [ ] **Step 4：编译验证**

Run: `npm run build`
Expected: PASS。

---

## Task 12：添加闪卡样式

**Files:**
- Modify: `styles.css`

- [ ] **Step 1：在文件末尾追加闪卡样式**

```css
/* Note Bar — 闪卡复习样式 */

.modal.mod-note-bar-flashcard {
  width: min(720px, 92vw);
  height: min(600px, 86vh);
  border-radius: 24px;
  overflow: hidden;
  background: var(--background-secondary);
}

.flashcard-modal-content,
.flashcard-book-picker-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0;
}

/* Header */
.flashcard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid var(--background-modifier-border);
  flex-shrink: 0;
}

.flashcard-mode-toggle {
  display: flex;
  background: var(--background-primary-alt);
  border-radius: 10px;
  padding: 3px;
  gap: 3px;
}

.flashcard-mode-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.flashcard-mode-btn.active {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-weight: 600;
}

.flashcard-progress {
  font-size: 14px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.flashcard-close-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.flashcard-close-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}

/* Body */
.flashcard-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 32px 20px;
  position: relative;
  perspective: 1200px;
  min-height: 0;
}

.flashcard-toast {
  position: absolute;
  top: 18px;
  left: 50%;
  transform: translateX(-50%) translateY(-20px);
  background: var(--background-primary-alt);
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 13px;
  color: var(--text-normal);
  opacity: 0;
  transition: all 0.3s ease;
  pointer-events: none;
  border: 1px solid var(--background-modifier-border);
  z-index: 10;
}

.flashcard-toast.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* Card */
.flashcard-card-scene {
  width: 100%;
  max-width: 520px;
  height: 380px;
  max-height: 100%;
  position: relative;
  transform-style: preserve-3d;
  flex-shrink: 1;
}

.flashcard-card-scene.hide {
  opacity: 0;
  pointer-events: none;
}

.flashcard-card {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  transition: transform 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
  cursor: pointer;
}

.flashcard-card.flipped {
  transform: rotateY(180deg);
}

.flashcard-card-face {
  position: absolute;
  inset: 0;
  backface-visibility: hidden;
  background: var(--background-primary-alt);
  border-radius: 20px;
  border: 1px solid var(--background-modifier-border);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  padding: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  overflow: hidden;
}

.flashcard-card-face-back {
  transform: rotateY(180deg);
  align-items: flex-start;
  text-align: left;
  justify-content: flex-start;
}

.flashcard-word {
  font-size: 56px;
  font-weight: 700;
  letter-spacing: -1px;
  margin-bottom: 16px;
  background: linear-gradient(135deg, var(--text-normal) 0%, var(--interactive-accent-hover) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  line-height: 1.2;
}

.flashcard-definition-front {
  font-size: 22px;
  line-height: 1.6;
  color: var(--text-normal);
  max-height: 220px;
  overflow-y: auto;
  -webkit-text-fill-color: var(--text-normal);
  background: none;
}

.flashcard-phonetic {
  font-size: 18px;
  color: var(--text-muted);
  font-family: "Times New Roman", serif;
  margin-bottom: 20px;
}

.flashcard-speak-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
  color: var(--interactive-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.flashcard-speak-btn:hover {
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  transform: scale(1.08);
}

.flashcard-flip-hint {
  font-size: 12px;
  color: var(--text-muted);
  opacity: 0.7;
  margin-top: 12px;
}

/* Spell */
.flashcard-spell-section {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 280px;
}

.flashcard-spell-input {
  width: 100%;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: 16px;
  text-align: center;
  outline: none;
  transition: all 0.2s ease;
}

.flashcard-spell-input.correct {
  border-color: var(--color-green);
  color: var(--color-green);
  background: color-mix(in srgb, var(--color-green) 8%, transparent);
}

.flashcard-spell-input.wrong {
  border-color: var(--color-red);
  color: var(--color-red);
  background: color-mix(in srgb, var(--color-red) 8%, transparent);
}

.flashcard-spell-feedback {
  font-size: 12px;
  min-height: 18px;
  color: var(--text-muted);
}

/* Back */
.flashcard-back-header {
  width: 100%;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.flashcard-back-word {
  font-size: 24px;
  font-weight: 700;
}

.flashcard-back-phonetic {
  font-size: 14px;
  color: var(--text-muted);
  font-family: "Times New Roman", serif;
}

.flashcard-notes {
  flex: 1;
  width: 100%;
  overflow-y: auto;
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-normal);
  white-space: pre-wrap;
}

.flashcard-notes::-webkit-scrollbar {
  width: 6px;
}

.flashcard-notes::-webkit-scrollbar-thumb {
  background: var(--background-modifier-border);
  border-radius: 3px;
}

/* Footer */
.flashcard-footer {
  padding: 14px 32px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.flashcard-footer.hide {
  opacity: 0;
  pointer-events: none;
}

.flashcard-rating-row {
  display: flex;
  gap: 12px;
  justify-content: center;
  align-items: center;
}

.flashcard-rating-btn {
  border: none;
  border-radius: 12px;
  padding: 10px 18px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 80px;
  color: #111;
  position: relative;
  overflow: hidden;
}

.flashcard-rating-btn::after {
  content: attr(data-key);
  font-size: 11px;
  opacity: 0.6;
  font-weight: 500;
}

.flashcard-rating-btn-again {
  background: var(--color-red);
}

.flashcard-rating-btn-hard {
  background: var(--color-orange);
}

.flashcard-rating-btn-good {
  background: var(--color-green);
}

.flashcard-rating-btn:hover {
  transform: translateY(-2px) scale(1.03);
  filter: brightness(1.1);
}

.flashcard-rating-btn:active {
  transform: translateY(0) scale(0.97);
}

.flashcard-super-easy-btn {
  border: 1px solid color-mix(in srgb, var(--interactive-accent) 35%, transparent);
  background: color-mix(in srgb, var(--interactive-accent) 8%, transparent);
  color: var(--interactive-accent);
  border-radius: 12px;
  padding: 8px 16px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.flashcard-super-easy-btn:hover {
  background: color-mix(in srgb, var(--interactive-accent) 15%, transparent);
  transform: translateY(-1px);
}

.flashcard-hint {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  gap: 16px;
}

.flashcard-hint kbd {
  background: var(--background-primary-alt);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: inherit;
  border: 1px solid var(--background-modifier-border);
}

/* Slide animations */
.flashcard-card.slide-out-right {
  animation: flashcard-slide-out-right 0.45s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.flashcard-card.slide-out-left {
  animation: flashcard-slide-out-left 0.45s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.flashcard-card.slide-in {
  animation: flashcard-slide-in 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

@keyframes flashcard-slide-out-right {
  to {
    transform: translateX(140%) rotate(12deg);
    opacity: 0;
  }
}

@keyframes flashcard-slide-out-left {
  to {
    transform: translateX(-140%) rotate(-12deg);
    opacity: 0;
  }
}

@keyframes flashcard-slide-in {
  from {
    transform: translateX(0) scale(0.85);
    opacity: 0;
  }
  to {
    transform: translateX(0) scale(1);
    opacity: 1;
  }
}

/* End screen */
.flashcard-end-screen {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  opacity: 0;
  pointer-events: none;
  transform: scale(0.96);
  transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.flashcard-end-screen.show {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1);
}

.flashcard-end-title {
  font-size: 28px;
  font-weight: 700;
}

.flashcard-end-stats {
  display: flex;
  gap: 32px;
  font-size: 15px;
  color: var(--text-muted);
}

.flashcard-end-stat strong {
  display: block;
  font-size: 26px;
  color: var(--text-normal);
  margin-bottom: 4px;
}

.flashcard-end-actions {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}

.flashcard-primary-btn,
.flashcard-secondary-btn {
  border: none;
  border-radius: 10px;
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.flashcard-primary-btn {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}

.flashcard-primary-btn:hover {
  background: var(--interactive-accent-hover);
}

.flashcard-secondary-btn {
  background: var(--background-primary-alt);
  color: var(--text-normal);
}

.flashcard-secondary-btn:hover {
  background: var(--background-modifier-hover);
}

/* Empty state */
.flashcard-empty-title {
  font-size: 20px;
  margin-bottom: 12px;
}

.flashcard-empty-text {
  color: var(--text-muted);
  margin-bottom: 20px;
}

.mod-note-bar-flashcard.no-animation * {
  transition: none !important;
  animation: none !important;
}

/* Book picker */
.flashcard-book-picker-content .flashcard-book-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 0;
}

.flashcard-book-row {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--background-primary-alt);
  border: 1px solid var(--background-modifier-border);
}

.flashcard-book-info {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.flashcard-book-name {
  font-weight: 600;
  font-size: 14px;
}

.flashcard-book-meta {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

.flashcard-button-container {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

/* Sidebar review header */
.hi-words-review-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.hi-words-review-title {
  font-weight: 600;
  font-size: 14px;
}

.hi-words-review-button {
  border: none;
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  transition: background 0.15s;
}

.hi-words-review-button:hover {
  background: var(--interactive-accent-hover);
}
```

- [ ] **Step 2：编译验证**

Run: `npm run build`
Expected: PASS（CSS 不会被 tsc 检查，esbuild 会打包）。

---

## Task 13：最终构建与集成验证

**Files:**
- 无新增或修改

- [ ] **Step 1：完整构建**

Run: `npm run build`
Expected:
```
tsc -noEmit -skipLibCheck && node esbuild.config.mjs production
```
以退出码 0 结束，生成 `main.js`。

- [ ] **Step 2：确认产物存在**

Run: `ls -lh main.js`
Expected: 输出包含 `main.js` 文件且大小合理。

---

## Self-Review

### 1. Spec coverage

| PRD / 需求 | 实现任务 |
|---|---|
| 命令面板入口「Note Bar: 开始闪卡复习」 | Task 10 Step 2 |
| 侧边栏「今日待复习 xx」入口 | Task 11 |
| 单词本选择弹窗（仅 Canvas，多选，显示统计） | Task 9 |
| 英→中 / 中→英 两种模式 | Task 8 `setMode` / `renderCard` |
| 空格翻转、发音按钮、拼写输入回车检查 | Task 8 |
| 键盘 s/d/f 评级，无「太简单」快捷键 | Task 8 `onKeyDown` |
| SM-2 算法与评级映射 | Task 4 |
| 新词学习阶段（stage、毕业） | Task 4 `applyReviewRating` |
| 掌握判定与 Canvas 同步 | Task 4 + Task 8 `syncMastered` |
| 复习队列（dailyNewWordLimit / dailyReviewLimit / studyOrder） | Task 6 |
| 进度持久化到 `HiWordsSettings.studyProgress`，key 为 `studyKey \|\| source:nodeId` | Task 8 `saveProgress`、Task 6 `buildFlashcardQueue` |
| 动画与 demo 一致 | Task 12 |
| 设置项（所有字段） | Task 10 Step 3 |
| 兼容旧 `status: 'mastered'` 数据 | Task 1 类型 + Task 6 `normalizeProgress` |

### 2. Placeholder scan

- 无 `TBD` / `TODO` / `implement later`。
- 无「添加适当错误处理」等模糊描述；错误处理已在代码中显式实现（`try/catch`、空队列提示、Notice）。
- 无未定义的类型或方法；所有函数、接口均在任务中给出完整定义。

### 3. Type consistency

- `FlashcardRating` / `FlashcardQuality` 在 `flashcard-algorithm.ts` 中定义并在 `flashcard-review-modal.ts` 中复用。
- `FlashcardQueueItem` 在 `flashcard-queue.ts` 中定义并在复习弹窗中使用。
- `StudyProgressItem.status` 扩展为 `'new' | 'learning' | 'review' | 'mastered'`，`MasteredService` 与队列模块均一致使用。
- `HiWordsSettings.flashcard` 默认值在 `main.ts` 中设置，弹窗中通过 `plugin.hiwordsSettings.flashcard ?? DEFAULT_FLASHCARD_SETTINGS` 访问。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-31-flashcard-review.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints for review.

**Which approach?**

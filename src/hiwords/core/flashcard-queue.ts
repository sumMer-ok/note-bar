import type { StudyItem, StudyProgressItem, FlashcardSettings, WordDefinition, WordLifecycle } from '../utils';

export interface FlashcardQueueItem {
    studyKey: string;
    studyItem: StudyItem;
    primary: WordDefinition;
    progress: StudyProgressItem;
    isNew: boolean;
}

// 学习会话类型：'new' 仅新词，'review' 仅到期复习词，'all' 按学习顺序混合
export type FlashcardSessionMode = 'new' | 'review' | 'all';

/** 读取词条生命周期状态（无记录视为 active，旧 mastered 视为 graduated） */
function getLifecycle(progress: StudyProgressItem | undefined): WordLifecycle {
    if (progress?.lifecycle) return progress.lifecycle;
    if (progress?.status === 'mastered') return 'graduated';
    return 'active';
}

/** 判断词条是否可参与复习队列（仅 active 词可复习） */
function isReviewable(progress: StudyProgressItem | undefined): boolean {
    return getLifecycle(progress) === 'active';
}

function startOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function toISODate(date: Date): string {
    // 使用本地时区 YYYY-MM-DD 格式，与 encounter-tracker 的 formatYYYYMMDD 一致，
    // 避免 UTC ISO 时间戳与本地日期字符串混合比较时因时区偏差导致到期日判定错误。
    const d = startOfDay(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function normalizeProgress(progress: StudyProgressItem): StudyProgressItem {
    return {
        ef: 2.5,
        reps: 0,
        interval: 0,
        ...progress,
    };
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
    newCount: number;
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
        if (!item.sources.some(s => s.source.endsWith('.canvas'))) continue;
        if (!item.sources.some(s => s.source === bookPath)) continue;
        const progress = studyProgress[item.studyKey];
        // graduated/archived/retired 词退出复习统计
        if (!isReviewable(progress)) continue;
        total++;
        if (!progress) {
            newCount++;
        } else {
            const normalized = normalizeProgress(progress);
            if (normalized.status !== 'mastered' && (!normalized.dueDate || normalized.dueDate <= todayStr)) {
                dueToday++;
            }
        }
    }

    return { total, dueToday, newCount };
}

export function buildFlashcardQueue(
    studyItems: StudyItem[],
    selectedBookPaths: string[],
    studyProgress: Record<string, StudyProgressItem>,
    settings: FlashcardSettings,
    sessionMode: FlashcardSessionMode = 'all',
    excludeKeys?: Set<string>,
    today: Date = new Date()
): FlashcardQueueItem[] {
    const todayStr = toISODate(today);
    const reviewPool: FlashcardQueueItem[] = [];
    const newPool: FlashcardQueueItem[] = [];
    const seen = new Set<string>();

    for (const item of studyItems) {
        if (excludeKeys && excludeKeys.has(item.studyKey)) continue;
        const isCanvas = item.sources.some(s => s.source.endsWith('.canvas'));
        if (!isCanvas) continue;
        const inSelectedBooks = selectedBookPaths.length === 0 || item.sources.some(s => selectedBookPaths.includes(s.source));
        if (!inSelectedBooks) continue;
        if (seen.has(item.studyKey)) continue;
        seen.add(item.studyKey);

        let progress = studyProgress[item.studyKey];
        // graduated/archived/retired 词退出复习队列
        if (!isReviewable(progress)) continue;
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

    // 复习队列按到期时间升序排列：到期最早的优先复习（FSRS-5 调度）
    reviewPool.sort((a, b) => (a.progress.dueDate || '').localeCompare(b.progress.dueDate || ''));
    // 新词队列保持添加顺序（先加入的先学）
    const limitedReview = reviewPool.slice(0, settings.dailyReviewLimit);
    const limitedNew = newPool.slice(0, settings.dailyNewWordLimit);

    if (sessionMode === 'new') {
        return limitedNew;
    }
    if (sessionMode === 'review') {
        return limitedReview;
    }
    return settings.studyOrder === 'review-first'
        ? [...limitedReview, ...limitedNew]
        : [...limitedNew, ...limitedReview];
}

export function getTodayDueReviewCount(
    studyItems: StudyItem[],
    studyProgress: Record<string, StudyProgressItem>,
    bookPaths?: string[],
    today: Date = new Date()
): number {
    const todayStr = toISODate(today);
    const seen = new Set<string>();
    let count = 0;

    const bookSet = bookPaths && bookPaths.length > 0 ? new Set(bookPaths) : null;

    for (const item of studyItems) {
        const isCanvas = item.sources.some(s => s.source.endsWith('.canvas'));
        if (!isCanvas) continue;
        if (bookSet && !item.sources.some(s => bookSet.has(s.source))) continue;
        if (seen.has(item.studyKey)) continue;
        seen.add(item.studyKey);

        const progress = studyProgress[item.studyKey];
        if (!progress) continue;
        if (!isReviewable(progress)) continue;
        const normalized = normalizeProgress(progress);
        if (normalized.status !== 'mastered' && (!normalized.dueDate || normalized.dueDate <= todayStr)) {
            count++;
        }
    }

    return count;
}

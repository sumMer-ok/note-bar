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

    return { total, dueToday, newCount };
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

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

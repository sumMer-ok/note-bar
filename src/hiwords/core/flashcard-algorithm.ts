import type { StudyProgressItem, FlashcardSettings } from '../utils';
import {
    initStability,
    initDifficulty,
    nextDifficulty,
    retrievability,
    nextRecallStability,
    nextForgetStability,
    nextInterval,
} from './fsrs';

/** 默认毕业稳定性阈值（约对应 1 个月间隔） */
const DEFAULT_GRADUATED_S = 30;

export type FlashcardRating = 'again' | 'hard' | 'good' | 'easy';
export type FlashcardQuality = 1 | 2 | 3 | 4;

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
    // 使用本地时区 YYYY-MM-DD 格式，与 encounter-tracker 的 formatYYYYMMDD 一致，
    // 避免 UTC ISO 时间戳与本地日期字符串混合比较时因时区偏差导致到期日判定错误。
    const d = startOfDay(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** 解析 "YYYY-MM-DD"（或 ISO 时间戳）为本地日期 */
function parseDate(s: string): Date {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y || 1970, (m || 1) - 1, d || 1);
}

/** 将评分映射为 FSRS grade：again=1, hard=2, good=3, easy=4 */
export function getQuality(rating: FlashcardRating): FlashcardQuality {
    switch (rating) {
        case 'again': return 1;
        case 'hard': return 2;
        case 'good': return 3;
        case 'easy': return 4;
    }
}

/**
 * FSRS-5 调度核心：计算稳定性 s、难度 d、间隔与到期日。
 * - 首次评分（progress 无 s/d）：用 initStability / initDifficulty 初始化；
 * - 已有 s/d：按距上次复习的天数计算记忆保留率 r，回忆成功走 nextRecallStability，
 *   遗忘走 nextForgetStability（lapses +1）；
 * - 兼容双写：同时保留 ef（原值或 2.5）与 interval（与 due 一致），保证旧读取路径不失效。
 */
function applyFsrs(progress: StudyProgressItem, grade: FlashcardQuality): StudyProgressItem {
    let s: number;
    let d: number;
    let lapses = progress.lapses || 0;

    if (progress.s === undefined || progress.d === undefined) {
        // 从未 FSRS 评分：初始化稳定性与难度
        s = initStability(grade);
        d = initDifficulty(grade);
    } else {
        // 距上次复习的天数（优先 lastReview，回退 dueDate，无记录则取 0）
        // lastReview 是 ISO 时间戳（含时区），需用 new Date() 解析后取本地日期 0 点，
        // 避免直接 slice(0,10) 取到 UTC 日期在 UTC+ 时区凌晨差 1 天。
        let t = 0;
        const lastReviewDate = progress.lastReview ? new Date(progress.lastReview) : null;
        if (lastReviewDate && !isNaN(lastReviewDate.getTime())) {
            t = Math.max(0, Math.round((startOfDay(new Date()).getTime() - startOfDay(lastReviewDate).getTime()) / 86400000));
        } else if (progress.dueDate) {
            const lastStr = progress.dueDate.slice(0, 10);
            if (lastStr) {
                t = Math.max(0, Math.round((startOfDay(new Date()).getTime() - parseDate(lastStr).getTime()) / 86400000));
            }
        }
        const r = retrievability(t, progress.s);

        if (grade === 1) {
            // 遗忘：稳定性下降，遗忘次数 +1，难度保持不变
            s = nextForgetStability(progress.d, progress.s, r);
            d = progress.d;
            lapses += 1;
        } else {
            // 回忆成功：稳定性上升，难度更新
            s = nextRecallStability(progress.d, progress.s, r, grade);
            d = nextDifficulty(progress.d, grade);
        }
    }

    const interval = nextInterval(s, 0.9);
    const dueDate = toISODate(addDays(new Date(), interval));

    // reps：again 归 0，其余（hard/good/easy）+1，保持现有语义以兼容 mastered 判定
    let reps = progress.reps || 0;
    if (grade === 1) reps = 0;
    else reps += 1;

    return {
        ...progress,
        s,
        d,
        lapses,
        interval, // 兼容字段：与 due 对应的间隔
        dueDate,
        lastReview: new Date().toISOString(),
        ef: progress.ef ?? 2.5, // 兼容字段：保留原值或默认 2.5
        reps,
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
    settings: FlashcardSettings,
    graduatedStabilityThreshold?: number
): ReviewRatingResult {
    const grade = getQuality(rating);
    let next: StudyProgressItem = { ...progress };
    let graduated = false;
    let mastered = false;

    if (progress.status === 'new' || progress.status === 'learning' || !progress.status) {
        // 学习阶段：stage 步进（good/easy 加 1，again/hard 归 0）
        const stage = progress.stage || 0;
        let nextStage = stage;
        if (rating === 'good' || rating === 'easy') {
            nextStage = stage + 1;
        } else if (rating === 'again' || rating === 'hard') {
            nextStage = 0;
        }

        // 学习阶段内的词也写 s/d/due（interval 由 FSRS 计算），但 status 保持 'learning'
        next = applyFsrs(progress, grade);

        if (nextStage >= settings.newWordSteps) {
            // 达到学习步数：毕业进入复习阶段
            next = { ...next, status: 'review', stage: nextStage };
            graduated = true;
        } else {
            next = { ...next, status: 'learning', stage: nextStage };
        }
    } else {
        // 复习阶段：FSRS 调度
        // 红线保护：graduated/archived/retired 词不再被 FSRS 调度更新 s/d/due。
        // 正常情况下这些词已被 flashcard-queue 排除，此处为防御性检查，避免误调用破坏生命周期状态。
        const lifecycle = progress.lifecycle
            ?? (progress.status === 'mastered' ? 'graduated' : 'active');
        if (lifecycle === 'active') {
            next = applyFsrs(progress, grade);
        }
        // 非 active 词：保持 s/d/due 不变，仅保留 next = { ...progress }
    }

    // 自动毕业：FSRS stability 超过阈值时置 graduated（只叠加状态，不修改 s/d/due）
    const threshold = graduatedStabilityThreshold ?? DEFAULT_GRADUATED_S;
    if (next.s !== undefined && next.s >= threshold && next.lifecycle !== 'graduated' && next.lifecycle !== 'archived' && next.lifecycle !== 'retired') {
        next.lifecycle = 'graduated';
        next.status = 'mastered';
        mastered = true;
    }

    // 兼容旧掌握判定（reps/ef 阈值）
    if (!mastered && next.status === 'review' && settings.masteredThreshold) {
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

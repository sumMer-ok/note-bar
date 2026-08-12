// FSRS-5 复习调度算法（纯函数模块）
// 本模块移植自 references/obsidian-lexis/main.js 第 94-110 行的 FSRS-5 参考实现，
// 为 Free Spaced Repetition Scheduler v5 官方算法，用于替代原 SM-2 算法。
// 所有公式均严格遵循参考实现，不引入任何依赖。

/** FSRS 评分等级：again=1（遗忘）、hard=2、good=3、easy=4 */
export type FSRSGrade = 1 | 2 | 3 | 4;

/** FSRS-5 默认权重（w0-w18） */
export const FSRS_W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];

/** 记忆衰减指数 */
export const FSRS_DECAY = -0.5;

/** 记忆保留率衰减因子 */
export const FSRS_FACTOR = Math.pow(0.9, 1 / FSRS_DECAY) - 1;

/** 最大间隔天数（约 100 年） */
export const MAX_IVL = 36500;

/** 将难度钳制在 [1, 10] 区间 */
function clampD(d: number): number {
    return Math.min(10, Math.max(1, d));
}

/** 初始稳定性：取权重与 0.1 的较大值 */
export function initStability(grade: FSRSGrade): number {
    return Math.max(0.1, FSRS_W[grade - 1]);
}

/** 初始难度：由权重与评分计算后钳制到 [1, 10] */
export function initDifficulty(grade: FSRSGrade): number {
    return clampD(FSRS_W[4] - Math.exp(FSRS_W[5] * (grade - 1)) + 1);
}

/** 线性阻尼：难度变化随当前难度线性衰减 */
function linearDamping(delta: number, d: number): number {
    return (delta * (10 - d)) / 9;
}

/** 均值回归：难度向初始难度靠拢（w7 为回归强度） */
function meanReversion(init: number, cur: number): number {
    return FSRS_W[7] * init + (1 - FSRS_W[7]) * cur;
}

/** 更新难度：评分后经线性阻尼与均值回归，钳制到 [1, 10] */
export function nextDifficulty(d: number, grade: FSRSGrade): number {
    const delta = -FSRS_W[6] * (grade - 3);
    const dd = d + linearDamping(delta, d);
    return clampD(meanReversion(initDifficulty(4), dd));
}

/** 记忆保留率 R(t, s)：基于经过天数 t 与稳定性 s 计算 */
export function retrievability(tDays: number, s: number): number {
    return Math.pow(1 + (FSRS_FACTOR * tDays) / s, FSRS_DECAY);
}

/** 回忆成功后的新稳定性：hard 乘 w15、easy 乘 w16 作调节 */
export function nextRecallStability(d: number, s: number, r: number, grade: FSRSGrade): number {
    const hard = grade === 2 ? FSRS_W[15] : 1;
    const easy = grade === 4 ? FSRS_W[16] : 1;
    return s * (1 + Math.exp(FSRS_W[8]) * (11 - d) * Math.pow(s, -FSRS_W[9]) * (Math.exp((1 - r) * FSRS_W[10]) - 1) * hard * easy);
}

/** 遗忘后的新稳定性（再次遗忘惩罚） */
export function nextForgetStability(d: number, s: number, r: number): number {
    return FSRS_W[11] * Math.pow(d, -FSRS_W[12]) * (Math.pow(s + 1, FSRS_W[13]) - 1) * Math.exp((1 - r) * FSRS_W[14]);
}

/** 计算复习间隔（天）：默认目标记忆保留率 0.9，结果钳制在 [1, 36500] 并取整 */
export function nextInterval(s: number, targetRetention: number = 0.9): number {
    const ivl = (s / FSRS_FACTOR) * (Math.pow(targetRetention, 1 / FSRS_DECAY) - 1);
    return Math.min(MAX_IVL, Math.max(1, Math.round(ivl)));
}

/** 将天数转换为人类可读的间隔描述（"x 天" / "x 个月" / "x 年"） */
export function humanInterval(days: number): string {
    if (days < 1) return '<1天';
    if (days < 30) return days + '天';
    if (days < 365) return Math.round(days / 30) + '个月';
    return (days / 365).toFixed(1) + '年';
}

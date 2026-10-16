package com.notebar.app.domain

import com.notebar.engine.Entry
import com.notebar.engine.FSRS
import com.notebar.engine.FsrsGrade
import com.notebar.engine.Merge
import com.notebar.engine.ReviewRecord
import com.notebar.engine.StudyProgress
import com.notebar.engine.TimeIso
import java.time.Instant
import java.time.LocalDate

/** 四档评分方向；`label` 既是界面文案也是写进 history 的 quality 值 */
enum class ReviewDirection(val label: String, val grade: FsrsGrade) {
    again("不认识", FsrsGrade.Again),
    hard("模糊", FsrsGrade.Hard),
    good("认识", FsrsGrade.Good),
    easy("太简单", FsrsGrade.Easy);

    /** 对应 iOS `FSRSGrade.label`（写进 history 的 quality 串） */
    val quality: String
        get() = when (this) {
            again -> "again"
            hard -> "hard"
            good -> "good"
            easy -> "easy"
        }
}

/** 一次评分的产物：新进度 + 提示文案，供 UI 与同步层使用 */
data class RatingOutcome(
    val progress: StudyProgress,
    val firstLearnedDate: String?,
    /** 「下次 X 天后」提示 */
    val preview: String,
    val graduated: Boolean,
)

/**
 * 复习 / 学习阶段的评分逻辑。**逐行移植自 `ReviewView.rate(_:)`**，不得"优化"：
 *
 * - FSRS 调度参数与 iOS 一致（elapsedDays 按自然日取整、下限 0）；
 * - 毕业条件：`result.graduated` 为真时**同时**写 `lifecycle = "graduated"` 与
 *   `status = "mastered"`（红线 1，否则电脑端永远不显示「已掌握」）；
 * - `masteredAt` 只在原本为空时写入；
 * - `firstLearnedDate` 只在原本为空时写入；
 * - `history` 走 `Merge.history` 去重合并（上限 50）。
 *
 * 本对象是纯函数，不触碰持久化：落库与 `writeSidecar` 由调用方负责。
 */
object ReviewEngine {

    fun rate(
        entry: Entry,
        direction: ReviewDirection,
        now: Instant = Instant.now(),
        today: LocalDate = FSRS.today(),
    ): RatingOutcome {
        val before = entry.progress
        val grade = direction.grade
        val elapsed = entry.lastReview
            ?.let { TimeIso.parse(it) }
            ?.let { last ->
                val days = java.time.temporal.ChronoUnit.DAYS.between(
                    TimeIso.startOfDay(last),
                    today,
                ).toDouble()
                maxOf(0.0, Math.round(days).toDouble())
            } ?: 0.0

        val result = FSRS.schedule(
            s = entry.s,
            d = entry.d,
            lapses = entry.lapses,
            elapsedDays = elapsed,
            grade = grade,
            today = today,
        )

        val nowString = isoString(now)
        var progress = before
        progress = progress.copy(
            s = result.s,
            d = result.d,
            lapses = result.lapses,
            dueDate = result.dueDate,
            lastReview = nowString,
            history = Merge.history(
                a = entry.history,
                b = listOf(ReviewRecord(date = nowString, quality = direction.quality)),
            ) ?: entry.history,
        )
        if (result.graduated) {
            // 与桌面插件一致：稳定度达到阈值后同时写 lifecycle 和 status
            progress = progress.copy(lifecycle = "graduated", status = "mastered")
            if (progress.masteredAt == null) progress = progress.copy(masteredAt = nowString)
        }

        return RatingOutcome(
            progress = progress,
            firstLearnedDate = entry.firstLearnedDate ?: FSRS.dayString(today),
            preview = "${result.interval} 天后",
            graduated = result.graduated,
        )
    }

    /** 把评分结果写回词条（对应 iOS `entry.progress = progress` + `firstLearnedDate`） */
    fun apply(entry: Entry, outcome: RatingOutcome): Entry =
        entry.withProgress(outcome.progress).let { next ->
            if (next.firstLearnedDate == null) next.copy(firstLearnedDate = outcome.firstLearnedDate)
            else next
        }

    /**
     * 学习阶段记录「不认识」的词（步骤一）。
     * 只记在内存里作为强化环节的输入；顺序 = 作答顺序，且去重。
     * **不写任何复习进度字段。**
     */
    fun trackWeakKey(weakKeys: MutableList<String>, studyKey: String) {
        if (!weakKeys.contains(studyKey)) weakKeys.add(studyKey)
    }

    /**
     * ISO8601 串；对应 iOS `ISO8601DateFormatter().string(from:)`（默认含小数秒、UTC）。
     * engine 的 [TimeIso.nowString] 只支持"此刻"，评分要写注入的时间，故在此单列。
     */
    internal fun isoString(instant: Instant): String =
        java.time.format.DateTimeFormatter.ISO_INSTANT.format(instant)
}

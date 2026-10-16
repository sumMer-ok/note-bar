package com.notebar.engine

import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

/** 评分档位：与 iOS FSRSGrade 的 rawValue 一一对应（1..4） */
enum class FsrsGrade(val rawValue: Int) {
    Again(1), Hard(2), Good(3), Easy(4);

    companion object {
        fun of(raw: Int): FsrsGrade = entries.first { it.rawValue == raw }
    }
}

/**
 * FSRS-5 调度算法。
 *
 * 移植自 NoteBarApp/Engine/FSRS.swift（iOS 端），行为必须逐位一致：
 * 权重、公式、clamp 范围、取整与 due 日期计算方式都照抄，不得"优化"。
 * 正确性由跨端共享的冻结测试向量 tests/fixtures/sync-vectors.json 锁定。
 */
object FSRS {
    val w: DoubleArray = doubleArrayOf(
        0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604,
        0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605,
        2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
    )
    const val decay: Double = -0.5
    val factor: Double = 0.9.pow(1.0 / decay) - 1
    const val maxInterval: Double = 36500.0

    fun clampD(d: Double): Double = min(10.0, max(1.0, d))

    fun initStability(grade: FsrsGrade): Double = max(0.1, w[grade.rawValue - 1])

    fun initDifficulty(grade: FsrsGrade): Double =
        clampD(w[4] - exp(w[5] * (grade.rawValue - 1)) + 1)

    fun nextDifficulty(d: Double, grade: FsrsGrade): Double {
        val delta = -w[6] * (grade.rawValue - 3)
        val damped = d + (delta * (10 - d)) / 9
        val regressed = w[7] * initDifficulty(FsrsGrade.Easy) + (1 - w[7]) * damped
        return clampD(regressed)
    }

    fun retrievability(tDays: Double, s: Double): Double =
        (1 + (factor * tDays) / s).pow(decay)

    fun nextRecallStability(d: Double, s: Double, r: Double, grade: FsrsGrade): Double {
        val hard = if (grade == FsrsGrade.Hard) w[15] else 1.0
        val easy = if (grade == FsrsGrade.Easy) w[16] else 1.0
        return s * (1 + exp(w[8]) * (11 - d) * s.pow(-w[9]) * (exp((1 - r) * w[10]) - 1) * hard * easy)
    }

    fun nextForgetStability(d: Double, s: Double, r: Double): Double =
        w[11] * d.pow(-w[12]) * ((s + 1).pow(w[13]) - 1) * exp((1 - r) * w[14])

    /**
     * 下一个复习间隔（天）。
     * iOS 用 `Int(interval.rounded())`（四舍五入到最近整数，.5 远离零），
     * Kotlin 的 roundToInt 语义相同，故直接对应。
     */
    fun nextInterval(s: Double, targetRetention: Double = 0.9): Int {
        val interval = (s / factor) * (targetRetention.pow(1.0 / decay) - 1)
        return min(maxInterval.toInt(), max(1, interval.roundToInt()))
    }

    fun humanInterval(days: Double): String = when {
        days < 1 -> "<1天"
        days < 30 -> "${days.toInt()}天"
        days < 365 -> "${(days / 30).roundToInt()}个月"
        else -> String.format(Locale.US, "%.1f年", days / 365)
    }

    /** 一次调度的结果（对应 iOS 的元组返回值） */
    data class ScheduleResult(
        val s: Double,
        val d: Double,
        val lapses: Int,
        val interval: Int,
        val dueDate: String,
        val graduated: Boolean,
    )

    /**
     * 调度一次作答。
     *
     * @param today 计算 dueDate 的基准日（默认今天）；单测注入固定日期以保证可重现。
     */
    fun schedule(
        s: Double?,
        d: Double?,
        lapses: Int?,
        elapsedDays: Double,
        grade: FsrsGrade,
        today: LocalDate = LocalDate.now(),
        graduatedThreshold: Double = 30.0,
    ): ScheduleResult {
        var nextS: Double
        var nextD: Double
        var nextLapses = lapses ?: 0
        if (s != null && d != null) {
            val r = retrievability(elapsedDays, s)
            if (grade == FsrsGrade.Again) {
                nextS = nextForgetStability(d, s, r)
                nextLapses += 1
            } else {
                nextS = nextRecallStability(d, s, r, grade)
            }
            nextD = nextDifficulty(d, grade)
        } else {
            nextS = initStability(grade)
            nextD = initDifficulty(grade)
        }
        val interval = nextInterval(nextS)
        val due = today.plusDays(interval.toLong())
        return ScheduleResult(
            s = nextS,
            d = nextD,
            lapses = nextLapses,
            interval = interval,
            dueDate = dayString(due),
            graduated = nextS >= graduatedThreshold,
        )
    }

    /** `YYYY-MM-DD`（对应 iOS dayString） */
    fun dayString(date: LocalDate): String =
        String.format(Locale.US, "%04d-%02d-%02d", date.year, date.monthValue, date.dayOfMonth)

    /** 本地时区的今天（对应 iOS Calendar.current.startOfDay + 取年月日） */
    fun today(zone: ZoneId = ZoneId.systemDefault()): LocalDate = LocalDate.now(zone)
}

package com.notebar.engine

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.temporal.ChronoField

/** 一次复习记录；字段与桌面插件 StudyProgress 的 history 项逐字段对应 */
@Serializable
data class ReviewRecord(
    val date: String,
    val quality: String, // again | hard | good | easy
)

/**
 * 学习进度；与插件 `StudyProgressItem`、iOS `StudyProgress` 逐字段对应。
 *
 * 序列化约定：字段名一律 camelCase，与桌面端 JSON 一致；
 * 所有可空字段缺省即 null，序列化时不得输出 null（见 [SidecarJson] 的 encodeDefaults 设置）。
 */
@Serializable
data class StudyProgress(
    val status: String? = null, // new | learning | review | mastered
    val stage: Int? = null,
    val reps: Int? = null,
    val ef: Double? = null,
    val interval: Int? = null,
    val s: Double? = null,
    val d: Double? = null,
    val lapses: Int? = null,
    val dueDate: String? = null,
    val lastReview: String? = null,
    val history: List<ReviewRecord>? = null,
    val lifecycle: String? = null, // active | graduated | archived | retired
    val pinned: Boolean? = null,
    val masteredAt: String? = null,
    val updatedAt: String? = null,
) {
    /**
     * 兼容旧插件数据：旧进度只有 interval/ef/stage，没有 FSRS 的 s/d。
     * 在本 App 的 FSRS 参数下 interval≈s，据此补齐 s、d 与缺失的 dueDate，
     * 让已学过的词正确落入熟练度分组与复习队列，而不是被当成「新词」。
     *
     * 逐行对应 iOS StudyProgress.withLegacyFieldsDerived()。
     */
    fun withLegacyFieldsDerived(): StudyProgress {
        val status = this.status
        if (s != null) return this
        if (status == null || status == "new") return this

        var p = this
        p = p.copy(
            s = when {
                status == "mastered" -> 30.0
                (interval ?: 0) > 0 -> interval!!.toDouble()
                else -> 1.0
            },
            d = d ?: 5.0,
        )
        if (p.dueDate == null) {
            val last = p.lastReview
            val date = last?.let { Merge.parseDate(it) }
            if (date != null) {
                val days = maxOf(1, p.interval ?: 1)
                p = p.copy(dueDate = FSRS.dayString(date.plusDays(days.toLong())))
            }
        }
        return p
    }
}

/**
 * 边车文件（`<词库名>.nb-sync.json`）结构；与 iOS SidecarFile 逐字段对应。
 */
@Serializable
data class SidecarFile(
    val version: Int,
    val book: String,
    val words: Map<String, StudyProgress>,
    val updatedAt: String,
)

/** 时间工具：与 iOS 使用 ISO8601 的解析口径对齐 */
object TimeIso {
    private val fractional: DateTimeFormatter = DateTimeFormatterBuilder()
        .appendPattern("yyyy-MM-dd'T'HH:mm:ss")
        .appendFraction(ChronoField.NANO_OF_SECOND, 0, 9, true)
        .appendOffsetId()
        .toFormatter()

    private val plain: DateTimeFormatter = DateTimeFormatter.ISO_OFFSET_DATE_TIME

    /** 解析 ISO8601（带/不带小数秒均可），失败返回 null */
    fun parse(value: String?): Instant? {
        if (value == null) return null
        return try {
            Instant.from(fractional.parse(value))
        } catch (_: Exception) {
            try {
                Instant.from(plain.parse(value))
            } catch (_: Exception) {
                null
            }
        }
    }

    /** 本地日期的当天零点（对应 iOS Calendar.current.startOfDay） */
    fun startOfDay(instant: Instant, zone: ZoneId = ZoneId.systemDefault()): LocalDate =
        instant.atZone(zone).toLocalDate()

    fun nowString(): String = DateTimeFormatter.ISO_INSTANT.format(Instant.now())
}

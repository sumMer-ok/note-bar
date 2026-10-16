package com.notebar.engine

import java.time.Instant

/**
 * 进度合并：lastReview 较新者胜 + history 去重合并（上限 50 条）。
 *
 * 逐行移植自 NoteBarApp/Engine/Merge.swift，用于手机端与桌面/iCloud 双向同步时
 * 决定哪一份进度为准。冲突副本命名规则（`<名> 2.nb-sync.json`）一并移植。
 */
object Merge {
    const val historyLimit: Int = 50

    /** 解析 ISO8601 时间串为 epoch 秒；解析失败按 0 处理（与 iOS 一致） */
    fun timeOf(value: String?): Double {
        val instant = TimeIso.parse(value) ?: return 0.0
        return instant.epochSecond.toDouble() + instant.nano / 1_000_000_000.0
    }

    /** 供内部复用的日期解析（保留 iOS 的 fractional → plain 两级回退） */
    internal fun parseDate(value: String): java.time.LocalDate? {
        val instant = TimeIso.parse(value) ?: return null
        return TimeIso.startOfDay(instant)
    }

    /**
     * history 去重合并：
     * 以 `date|quality` 为键去重（同键取时间较新者），按时间升序排列，只保留最近 50 条。
     * 两参数皆空时返回 null（与 iOS 一致，避免产生空数组）。
     */
    fun history(a: List<ReviewRecord>?, b: List<ReviewRecord>?): List<ReviewRecord>? {
        val map = LinkedHashMap<String, ReviewRecord>()
        for (record in (a ?: emptyList()) + (b ?: emptyList())) {
            val key = "${record.date}|${record.quality}"
            val existing = map[key]
            if (existing == null || timeOf(record.date) >= timeOf(existing.date)) {
                map[key] = record
            }
        }
        val sorted = map.values.sortedBy { timeOf(it.date) }
        if (sorted.isEmpty()) return null
        return sorted.takeLast(historyLimit)
    }

    /**
     * 合并两份进度：lastReview 较新者胜，逐个字段用「胜者优先、空则回落败者」的规则，
     * history 走去重合并。
     */
    fun progress(local: StudyProgress?, remote: StudyProgress?): StudyProgress? {
        if (local == null) return remote
        if (remote == null) return local

        val remoteWins = timeOf(remote.lastReview) > timeOf(local.lastReview)
        val winner = if (remoteWins) remote else local
        val loser = if (remoteWins) local else remote

        var merged = loser
        if (winner.s != null) merged = merged.copy(s = winner.s)
        if (winner.d != null) merged = merged.copy(d = winner.d)
        merged = merged.copy(
            status = winner.status ?: loser.status,
            stage = winner.stage ?: loser.stage,
            reps = winner.reps ?: loser.reps,
            ef = winner.ef ?: loser.ef,
            interval = winner.interval ?: loser.interval,
            lapses = winner.lapses ?: loser.lapses,
            dueDate = winner.dueDate ?: loser.dueDate,
            lastReview = winner.lastReview ?: loser.lastReview,
            lifecycle = winner.lifecycle ?: loser.lifecycle,
            pinned = winner.pinned ?: loser.pinned,
            masteredAt = winner.masteredAt ?: loser.masteredAt,
            updatedAt = winner.updatedAt ?: loser.updatedAt,
            history = history(local.history, remote.history),
        )
        return merged
    }

    private val conflictRegex = Regex("^.+ \\d+\\.nb-sync\\.json$")
    private val conflictCapture = Regex("^(.+) \\d+\\.nb-sync\\.json$")

    /** 是否为同步冲突副本（如 `英语词库 2.nb-sync.json`） */
    fun isConflictCopy(name: String): Boolean = conflictRegex.matches(name)

    /** 冲突副本对应的主文件名；非冲突副本返回 null */
    fun conflictBaseName(name: String): String? {
        val m = conflictCapture.matchEntire(name) ?: return null
        val base = m.groupValues[1]
        return "$base.nb-sync.json"
    }
}

package com.notebar.engine

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** 1:1 移植自 iOS NoteBarAppTests/MergeTests.swift */
class MergeTests {

    @Test
    fun lastReviewWinsAndHistoryDedup() {
        val local = StudyProgress(
            s = 10.0,
            lastReview = "2026-08-12T00:00:00.000Z",
            history = listOf(ReviewRecord(date = "2026-08-12T00:00:00.000Z", quality = "good")),
        )
        val remote = StudyProgress(
            s = 99.0,
            lastReview = "2026-08-13T00:00:00.000Z",
            history = listOf(
                ReviewRecord(date = "2026-08-12T00:00:00.000Z", quality = "good"),
                ReviewRecord(date = "2026-08-13T00:00:00.000Z", quality = "again"),
            ),
        )

        val merged = Merge.progress(local = local, remote = remote)!!
        assertEquals(99.0, merged.s)
        assertEquals(2, merged.history?.size)
        assertEquals("again", merged.history?.last()?.quality)
        assertEquals("2026-08-13T00:00:00.000Z", merged.lastReview)
    }

    @Test
    fun historyCappedAt50() {
        val a = (0 until 50).map { i ->
            ReviewRecord(date = Instant.ofEpochSecond(i.toLong()).toString(), quality = "good")
        }
        val b = listOf(ReviewRecord(date = "2026-08-14T00:00:00.000Z", quality = "hard"))
        val merged = Merge.history(a = a, b = b)!!
        assertEquals(50, merged.size)
        assertEquals("hard", merged.last().quality)
    }

    @Test
    fun conflictCopyNaming() {
        assertTrue(Merge.isConflictCopy("英语词库 2.nb-sync.json"))
        assertEquals("英语词库.nb-sync.json", Merge.conflictBaseName("英语词库 2.nb-sync.json"))
        assertFalse(Merge.isConflictCopy("英语词库.nb-sync.json"))
    }

    @Test
    fun legacyProgressDerivesFsrsFields() {
        // 旧插件进度：只有 interval/ef，没有 s/d
        val legacy = StudyProgress(
            status = "review",
            interval = 14,
            ef = 2.5,
            lastReview = "2026-08-13T09:22:23.219Z",
        )
        val derived = legacy.withLegacyFieldsDerived()
        assertEquals(14.0, derived.s)
        assertEquals(5.0, derived.d)
        assertEquals("2026-08-27", derived.dueDate?.take(10), "dueDate 应为 lastReview + interval 天")

        // 已有 s 的进度不动
        val modern = StudyProgress(status = "review", s = 7.7, d = 4.2)
        val kept = modern.withLegacyFieldsDerived()
        assertEquals(7.7, kept.s)
        assertEquals(4.2, kept.d)

        // 新词不动
        val fresh = StudyProgress(status = "new")
        assertEquals(null, fresh.withLegacyFieldsDerived().s)

        // mastered 直接落到毕业稳定度
        val mastered = StudyProgress(status = "mastered", interval = 30)
        assertEquals(30.0, mastered.withLegacyFieldsDerived().s)
    }

    /** 双边为空时不产生空数组（与 iOS 一致） */
    @Test
    fun historyReturnsNullWhenBothEmpty() {
        assertEquals(null, Merge.history(a = null, b = null))
        assertEquals(null, Merge.history(a = emptyList(), b = emptyList()))
    }

    /** lastReview 相同（或都缺失）时本地获胜，不得被远端旧值覆盖 */
    @Test
    fun localWinsOnTieOrMissingTimestamp() {
        val local = StudyProgress(status = "review", s = 5.0, lastReview = "2026-08-12T00:00:00.000Z")
        val remote = StudyProgress(status = "learning", s = 1.0, lastReview = "2026-08-12T00:00:00.000Z")
        val merged = Merge.progress(local = local, remote = remote)!!
        assertEquals(5.0, merged.s)
        assertEquals("review", merged.status)
    }
}

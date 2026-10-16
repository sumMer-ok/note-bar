package com.notebar.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** 1:1 移植自 iOS NoteBarAppTests/StudyQueueTests.swift */
class StudyQueueTests {

    private fun entry(
        word: String = "apple",
        book: String = "Words/Test.canvas",
        firstLearnedDate: String? = null,
        dueDate: String? = null,
        status: String? = null,
        lifecycle: String? = null,
        addedDate: String? = null,
        s: Double? = null,
    ): Entry = Entry(
        studyKey = "$book:$word",
        book = book,
        source = book,
        nodeId = word,
        word = word,
        aliases = emptyList(),
        definition = "释义",
        firstLearnedDate = firstLearnedDate,
        dueDate = dueDate,
        status = status,
        lifecycle = lifecycle,
        addedDate = addedDate,
        s = s,
    )

    @Test
    fun unlearnedWordIsNotReviewable() {
        // 没有任何进度字段 = 桌面 studyProgress 无记录 → 新词，不在复习
        val entry = entry(firstLearnedDate = null, dueDate = null, s = null)
        assertFalse(StudyQueue.isReviewable(entry, today = "2026-08-17"))
        assertTrue(StudyQueue.isLearnable(entry))
    }

    @Test
    fun learnedDueWordIsReviewable() {
        // 只要同步带来了进度（此处 dueDate）就应进入复习，与是否在手机上点过学习无关
        val entry = entry(firstLearnedDate = null, dueDate = "2026-08-16", s = 5.0)
        assertTrue(StudyQueue.isReviewable(entry, today = "2026-08-17"))
        assertFalse(StudyQueue.isLearnable(entry))
    }

    @Test
    fun learnedFutureWordIsNotReviewable() {
        val entry = entry(firstLearnedDate = null, dueDate = "2026-08-20", s = 5.0)
        assertFalse(StudyQueue.isReviewable(entry, today = "2026-08-17"))
    }

    @Test
    fun masteredWordIsExcluded() {
        val mastered = entry(firstLearnedDate = null, dueDate = "2026-08-16", status = "mastered", s = 40.0)
        assertFalse(StudyQueue.isReviewable(mastered, today = "2026-08-17"))
        assertFalse(StudyQueue.isLearnable(mastered))

        val graduated = entry(firstLearnedDate = null, dueDate = "2026-08-16", lifecycle = "graduated", s = 40.0)
        assertFalse(StudyQueue.isReviewable(graduated, today = "2026-08-17"))
    }

    @Test
    fun progressWithoutDueDateCountsAsDue() {
        // 与桌面一致：有进度但无到期日（如 learning 阶段）视为今日到期
        val learning = entry(firstLearnedDate = null, dueDate = null, status = "learning")
        assertTrue(StudyQueue.isReviewable(learning, today = "2026-08-17"))
    }

    @Test
    fun dictationMatchFiltersByBookAndDates() {
        val dated = entry(book = "Words/A.canvas", addedDate = "2026-08-10")
        assertTrue(StudyQueue.dictationMatch(dated, books = setOf("Words/A.canvas"), dates = setOf("2026-08-10")))
        assertFalse(StudyQueue.dictationMatch(dated, books = setOf("Words/B.canvas"), dates = setOf("2026-08-10")))
        assertFalse(StudyQueue.dictationMatch(dated, books = setOf("Words/A.canvas"), dates = setOf("2026-08-11")))
        assertTrue(StudyQueue.dictationMatch(dated, books = emptySet(), dates = emptySet()))

        val undated = entry(book = "Words/A.canvas", addedDate = null)
        assertTrue(
            StudyQueue.dictationMatch(undated, books = setOf("Words/A.canvas"), dates = setOf(StudyQueue.undatedLabel)),
        )
    }

    /** 词库显示名：去目录与 .canvas 后缀 */
    @Test
    fun bookDisplayNameStripsDirectoryAndExtension() {
        assertEquals("Test", entry(book = "Words/Test.canvas").bookDisplayName)
        assertEquals("Common Law", entry(book = "Words/Common Law.canvas").bookDisplayName)
    }
}

package com.notebar.app.domain

import com.notebar.engine.Entry
import com.notebar.engine.ReinforceDraft
import com.notebar.engine.StudyProgress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

/**
 * 复习会话（含不熟词强化两阶段）的行为口径。
 *
 * 钉死的红线：
 * 1. 毕业时**同时**写 lifecycle 与 status（否则电脑端不显示「已掌握」）；
 * 2. 「认识」不写 graduation，`firstLearnedDate` 只在首次学习时写；
 * 3. 强化环节**只走内存状态机**，不动 s/d/lapses/dueDate/lastReview/history/lifecycle/status/masteredAt；
 * 4. 仅学习模式触发强化；复习模式不触发；
 * 5. 草稿字段白名单不扩张。
 */
class ReviewSessionTest {

    private val today = LocalDate.of(2026, 8, 20)
    private val now = Instant.parse("2026-08-20T10:00:00Z")

    private fun entry(
        word: String,
        s: Double? = null,
        d: Double? = null,
        dueDate: String? = null,
        lastReview: String? = null,
        status: String? = null,
        firstLearnedDate: String? = null,
    ) = Entry(
        studyKey = "en:word:$word",
        book = "Words/a.canvas",
        source = "Words/a.canvas",
        nodeId = "n-$word",
        word = word,
        s = s,
        d = d,
        dueDate = dueDate,
        lastReview = lastReview,
        status = status,
        firstLearnedDate = firstLearnedDate,
    )

    private fun learnSession(entries: List<Entry>) = ReviewSessionState(
        mode = ReviewMode.learn,
        books = setOf("Words/a.canvas"),
        initialQueue = entries,
        reinforceEntries = entries.associateBy { it.studyKey },
    )

    // ------------------------------------------------------------- 评分与推进

    @Test
    fun ratingAdvancesOnlyAfterAdvanceIsCalled() {
        val session = learnSession(listOf(entry("apple")))
        assertNotNull(session.rate(ReviewDirection.good, now, today))
        assertEquals(0, session.index)
        session.advance()
        assertEquals(1, session.index)
        assertTrue(session.isQueueFinished)
    }

    @Test
    fun goodRatingDoesNotGraduateOnFirstReview() {
        val session = learnSession(listOf(entry("apple")))
        val result = session.rate(ReviewDirection.good, now, today)!!
        assertNull(result.updated.lifecycle)
        assertNull(result.updated.status)
        assertFalse(result.outcome.graduated)
    }

    @Test
    fun graduatedRatingWritesBothLifecycleAndStatus() {
        // 构造一次必然毕业的评分：s 已接近阈值，且给「太简单」
        val session = learnSession(listOf(entry("apple", s = 29.0, d = 5.0, lastReview = "2026-08-19T00:00:00Z")))
        val result = session.rate(ReviewDirection.easy, now, today)!!
        assertTrue(result.outcome.graduated)
        assertEquals("graduated", result.updated.lifecycle)
        assertEquals("mastered", result.updated.status)
        // 注意：Entry 没有 masteredAt 字段（与 iOS Entry 一致，iOS 的 progress setter 同样不搬这一项）。
        // masteredAt 只存在于传给 writeSidecar 的那份 StudyProgress 上。
        assertNotNull(result.outcome.progress.masteredAt)
        assertNull(result.updated.progress.masteredAt)
    }

    @Test
    fun firstLearnedDateIsWrittenOnlyOnce() {
        val first = learnSession(listOf(entry("apple")))
        val r1 = first.rate(ReviewDirection.good, now, today)!!
        assertEquals("2026-08-20", r1.updated.firstLearnedDate)

        val again = learnSession(listOf(entry("apple", firstLearnedDate = "2026-07-01")))
        val r2 = again.rate(ReviewDirection.good, now, today)!!
        assertEquals("2026-07-01", r2.updated.firstLearnedDate)
    }

    @Test
    fun ratingWritesLastReviewDueDateAndHistory() {
        val session = learnSession(listOf(entry("apple")))
        val result = session.rate(ReviewDirection.good, now, today)!!
        assertEquals("2026-08-20T10:00:00Z", result.updated.lastReview)
        assertNotNull(result.updated.dueDate)
        assertEquals(1, result.updated.history?.size)
        assertEquals("good", result.updated.history!!.first().quality)
        assertEquals("${result.outcome.let { it.progress.dueDate }}", result.updated.dueDate)
    }

    @Test
    fun historyIsAppendedToExistingRecords() {
        // 已有历史 + 本次评分 → 追加而不是覆盖（走 Merge.history 去重合并）
        val existing = listOf(
            com.notebar.engine.ReviewRecord("2026-08-01T00:00:00Z", "again"),
            com.notebar.engine.ReviewRecord("2026-08-10T00:00:00Z", "good"),
        )
        val session = learnSession(
            listOf(entry("apple", s = 3.0, d = 5.0, lastReview = "2026-08-10T00:00:00Z").copy(history = existing)),
        )
        val result = session.rate(ReviewDirection.hard, now, today)!!
        assertEquals(3, result.updated.history?.size)
        assertEquals(
            listOf("again", "good", "hard"),
            result.updated.history!!.map { it.quality },
        )
    }

    @Test
    fun undoRevertsHistoryAsWellAsProgress() {
        val existing = listOf(com.notebar.engine.ReviewRecord("2026-08-10T00:00:00Z", "good"))
        val base = entry("apple", s = 3.0, d = 5.0, lastReview = "2026-08-10T00:00:00Z")
            .copy(history = existing)
        val session = learnSession(listOf(base))

        session.rate(ReviewDirection.again, now, today)
        assertEquals(1, session.weakKeys.size)

        val undone = session.undo()!!
        assertEquals(existing, undone.second.history)
        assertEquals(base, session.queue[0])
    }

    @Test
    fun reRatingSameCardAccumulatesHistoryInPlace() {
        // iOS 对同一张卡就地改对象，撤回后再评应基于恢复后的状态；
        // 连续评分（不撤回）则在同一对象上累积。
        val session = learnSession(listOf(entry("apple")))
        session.rate(ReviewDirection.good, now, today)
        // 不 advance，直接再评一次（等价于同一对象被二次评分）
        val second = session.rate(ReviewDirection.hard, now.plusSeconds(3600), today)!!
        assertEquals(2, second.updated.history?.size)
        assertEquals(listOf("good", "hard"), second.updated.history!!.map { it.quality })
    }

    @Test
    fun undoRestoresPreviousProgressAndRewindsIndex() {
        val session = learnSession(listOf(entry("apple"), entry("banana")))
        val result = session.rate(ReviewDirection.good, now, today)!!
        session.advance()
        assertEquals(1, session.index)

        val undone = session.undo()!!
        assertEquals(result.original, undone.first)
        assertNull(undone.second.s)
        assertEquals(0, session.index)
        assertFalse(session.canUndo)
    }

    @Test
    fun undoReturnsNullWhenNothingToUndo() {
        val session = learnSession(listOf(entry("apple")))
        assertNull(session.undo())
    }

    @Test
    fun previewShowsIntervalInDays() {
        val session = learnSession(listOf(entry("apple")))
        session.rate(ReviewDirection.good, now, today)
        assertTrue(session.preview!!.endsWith(" 天后"))
    }

    // ------------------------------------------------------- 强化环节自动进入

    @Test
    fun learnModeEntersReinforceWhenWeakWordsExist() {
        val session = learnSession(listOf(entry("apple"), entry("banana")))
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        session.rate(ReviewDirection.good, now, today)
        session.advance()
        assertTrue(session.isReinforcing)
        assertEquals(listOf("en:word:apple"), session.reinforce!!.seed)
    }

    @Test
    fun learnModeDoesNotEnterReinforceWhenAllKnown() {
        val session = learnSession(listOf(entry("apple"), entry("banana")))
        session.rate(ReviewDirection.good, now, today)
        session.advance()
        session.rate(ReviewDirection.good, now, today)
        session.advance()
        assertFalse(session.isReinforcing)
    }

    @Test
    fun reviewModeNeverEntersReinforce() {
        val session = ReviewSessionState(
            mode = ReviewMode.review,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(entry("apple", s = 3.0, d = 5.0, lastReview = "2026-08-01T00:00:00Z")),
            reinforceEntries = emptyMap(),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        assertFalse(session.isReinforcing)
    }

    @Test
    fun weakKeysAreDeduplicatedAndOrdered() {
        val session = learnSession(listOf(entry("apple"), entry("banana"), entry("cherry")))
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        session.rate(ReviewDirection.good, now, today)
        session.advance()
        assertEquals(listOf("en:word:apple", "en:word:banana"), session.reinforce!!.seed)
    }

    @Test
    fun weakWordsMissingFromIndexAreFilteredOut() {
        val entries = listOf(entry("apple"), entry("banana"))
        // apple 仍在索引里，banana 已从词库删除
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = entries,
            reinforceEntries = mapOf("en:word:apple" to entries[0]),
        )
        // 两个词都被判「不认识」，但只有 apple 能取到卡片
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        assertEquals(listOf("en:word:apple"), session.reinforce!!.seed)
    }

    @Test
    fun noReinforceWhenEveryWeakWordWasDeleted() {
        val entries = listOf(entry("apple"))
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = entries,
            reinforceEntries = emptyMap(),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        // 取不到任何弱词卡片 → 不进入强化环节，直接停在结束页
        assertFalse(session.isReinforcing)
    }

    // ----------------------------------------------------- 强化环节的红线行为

    @Test
    fun reinforceAnswerNeverTouchesStudyProgressFields() {
        val weak = entry("apple").copy(
            s = 4.5, d = 6.0, lapses = 2, dueDate = "2026-09-01",
            lastReview = "2026-08-10T00:00:00Z", lifecycle = "active", status = "review",
        )
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        val before: StudyProgress = session.reinforceEntries[weak.studyKey]!!.progress
        val beforeEntry: Entry = session.reinforceEntries[weak.studyKey]!!

        // 连续答「不认识」（一直重排，不会 finished，因此索引不被清空）
        repeat(6) { session.answerReinforce(known = false) }
        // 再答一次「认识」结束本词（但队列里还有后续轮次时仍会继续呈现）
        repeat(2) { session.answerReinforce(known = true) }
        while (session.isReinforcing) session.answerReinforce(known = true)

        val after = beforeEntry.progress
        assertEquals(before, after)
        assertNull(session.reinforce)
        // 索引在结束后被清空，证明强化环节只维护自己的循环状态
        assertTrue(session.reinforceEntries.isEmpty())
        assertEquals(before, after)
        // 逐字段再确认一遍（防止 progress 视图漏字段）
        assertEquals(4.5, after.s!!, 1e-9)
        assertEquals(6.0, after.d!!, 1e-9)
        assertEquals(2, after.lapses)
        assertEquals("2026-09-01", after.dueDate)
        assertEquals("2026-08-10T00:00:00Z", after.lastReview)
        assertEquals("active", after.lifecycle)
        assertEquals("review", after.status)
        assertNull(after.masteredAt)
    }

    @Test
    fun reinforceEventuallyFinishesWhenAllKnown() {
        val weak = entry("apple")
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()

        session.answerReinforce(known = false)
        assertTrue(session.isReinforcing)
        session.answerReinforce(known = true)
        assertFalse(session.isReinforcing)
        assertNotNull(session.reinforceSummary)
        assertEquals(1, session.reinforceSummary!!.wordCount)
    }

    @Test
    fun reinforceCountsSeenAcrossRounds() {
        val weak = entry("apple")
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()

        session.answerReinforce(known = false)
        assertEquals(1, session.reinforce!!.seenCount("en:word:apple"))
        session.answerReinforce(known = false)
        // 第二轮再次呈现，seen 继续累加（同一单词多轮重复出现的计数）
        assertEquals(2, session.reinforce!!.seenCount("en:word:apple"))
    }

    @Test
    fun stuckFeedbackAppearsAfterThresholdWrongStreak() {
        val weak = entry("apple")
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()

        var stuck = false
        repeat(3) {
            val feedback = session.answerReinforce(known = false)
            if (feedback?.kind == com.notebar.engine.ReinforceFeedback.Kind.Stuck) stuck = true
        }
        assertTrue("连续答错达标时应给出 Stuck 提示", stuck)
    }

    @Test
    fun passWordManuallyRemovesItFromQueueWithoutTouchingProgress() {
        val weak = entry("apple").copy(s = 2.0)
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()

        val entryBefore = session.reinforceEntries[weak.studyKey]!!
        assertTrue(session.passCurrentWordManually())
        assertFalse(session.isReinforcing)
        // 放行只动队列，词条的进度字段原样不变
        assertEquals(2.0, entryBefore.s!!, 1e-9)
        assertNull(entryBefore.lifecycle)
    }

    @Test
    fun answerLimitHaltsAndCannotBeBypassed() {
        val weak = entry("apple")
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()

        val limit = session.reinforce!!.answerLimit
        var sawLimit = false
        repeat(limit + 5) {
            val feedback = session.answerReinforce(known = false)
            if (feedback?.kind == com.notebar.engine.ReinforceFeedback.Kind.LimitReached) sawLimit = true
        }
        assertTrue(sawLimit)
        // 暂停后队列不再被消耗
        val frozen = session.reinforce!!.totalAnswers
        session.answerReinforce(known = false)
        assertEquals(frozen, session.reinforce!!.totalAnswers)
    }

    @Test
    fun continueAfterLimitExtendsBudgetAndResumes() {
        val weak = entry("apple")
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        val limit = session.reinforce!!.answerLimit
        repeat(limit) { session.answerReinforce(known = false) }
        assertTrue(session.reinforce!!.isHalted)

        session.continueAfterLimit()
        assertFalse(session.reinforce!!.isHalted)
        assertTrue(session.reinforce!!.answerLimit > limit)
    }

    // ------------------------------------------------------------- 草稿契约

    @Test
    fun draftSnapshotContainsOnlyLoopState() {
        val weak = entry("apple").copy(s = 4.5, d = 6.0, lapses = 2, dueDate = "2026-09-01", status = "review")
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()

        val draft = session.draftSnapshot("2026-08-20T10:00:00Z")!!
        assertEquals(listOf("en:word:apple"), draft.weakKeys)
        assertEquals(listOf("en:word:apple"), draft.currentRound)
        assertEquals(1, draft.round)
        assertEquals(0, draft.totalAnswers)
        assertEquals(listOf("Words/a.canvas"), draft.books)
        assertEquals("2026-08-20T10:00:00Z", draft.updatedAt)
        assertTrue(draft.isResumable)
    }

    @Test
    fun partialDraftIsSavedWhenExitingMidLearnWithWeakWords() {
        val session = learnSession(listOf(entry("apple"), entry("banana")))
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        // 提前退出：还没走完正常阶段
        val draft = session.partialDraftSnapshot("2026-08-20T10:00:00Z")!!
        assertEquals(listOf("en:word:apple"), draft.weakKeys)
    }

    @Test
    fun partialDraftIsNullWhenNoWeakWordsOrFinished() {
        val session = learnSession(listOf(entry("apple")))
        session.rate(ReviewDirection.good, now, today)
        session.advance()
        assertNull(session.partialDraftSnapshot())
    }

    @Test
    fun partialDraftIsNullForReviewMode() {
        val session = ReviewSessionState(
            mode = ReviewMode.review,
            books = emptySet(),
            initialQueue = listOf(entry("apple", s = 2.0)),
        )
        session.rate(ReviewDirection.again, now, today)
        assertNull(session.partialDraftSnapshot())
    }

    @Test
    fun draftSnapshotIsNullAfterReinforceFinishesSoDraftGetsCleared() {
        // 强化全部通过后会话被清空 → draftSnapshot() 返回 null
        // → 首页不应再出现「继续强化」入口（对应 iOS finishReinforce 的 clearReinforceDraft）
        val weak = entry("apple")
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        assertNotNull(session.draftSnapshot())

        session.answerReinforce(known = true)
        assertFalse(session.isReinforcing)
        assertNull(session.draftSnapshot())
    }

    @Test
    fun draftSnapshotIsNullAfterManualPassClearsQueue() {
        val weak = entry("apple")
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = listOf(weak),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        session.passCurrentWordManually()
        assertNull(session.draftSnapshot())
    }

    @Test
    fun restoreReinforceRebuildsSessionFromDraft() {
        val draft = ReinforceDraft(
            weakKeys = listOf("en:word:apple"),
            currentRound = listOf("en:word:apple"),
            nextRound = emptyList(),
            round = 2,
            totalAnswers = 3,
            tallies = emptyMap(),
            books = listOf("Words/a.canvas"),
            answerLimit = 50,
            updatedAt = "2026-08-20T10:00:00Z",
        )
        val weak = entry("apple")
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = setOf("Words/a.canvas"),
            initialQueue = emptyList(),
            reinforceEntries = mapOf(weak.studyKey to weak),
        )
        assertTrue(session.restoreReinforce(draft))
        assertEquals(2, session.reinforce!!.round)
        assertEquals(3, session.reinforce!!.totalAnswers)
        assertEquals("en:word:apple", session.reinforce!!.current)
    }

    @Test
    fun restoreReinforceRejectsEmptyDraft() {
        val draft = ReinforceDraft(
            weakKeys = emptyList(),
            currentRound = emptyList(),
            nextRound = emptyList(),
            round = 1,
            totalAnswers = 5,
            tallies = emptyMap(),
            books = emptyList(),
            answerLimit = 50,
            updatedAt = "2026-08-20T10:00:00Z",
        )
        val session = ReviewSessionState(
            mode = ReviewMode.learn,
            books = emptySet(),
            initialQueue = emptyList(),
        )
        assertFalse(session.restoreReinforce(draft))
        assertFalse(session.isReinforcing)
    }

    // -------------------------------------------------------------- 再学一组

    @Test
    fun startAnotherGroupExcludesPreviousKeys() {
        val a = entry("apple")
        val b = entry("banana")
        val session = learnSession(listOf(a, b))
        session.startAnotherGroup(listOf(a, b), 20, "2026-08-20")
        // 两个都用过且没有更多新词 → 退化为重复（与 iOS 一致）
        assertTrue(session.queue.isNotEmpty())
        assertEquals(0, session.index)
    }

    @Test
    fun startAnotherGroupPicksFreshWordsWhenAvailable() {
        val a = entry("apple")
        val b = entry("banana")
        val session = learnSession(listOf(a))
        session.startAnotherGroup(listOf(a, b), 20, "2026-08-20")
        assertEquals(listOf("banana"), session.queue.map { it.word })
    }

    @Test
    fun startAnotherGroupClearsReinforceState() {
        val a = entry("apple")
        val session = learnSession(listOf(a))
        session.rate(ReviewDirection.again, now, today)
        session.advance()
        assertTrue(session.isReinforcing)
        session.startAnotherGroup(listOf(a), 20, "2026-08-20")
        assertFalse(session.isReinforcing)
        assertNull(session.reinforceSummary)
    }
}

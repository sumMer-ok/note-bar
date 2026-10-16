package com.notebar.engine

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 「本组不熟词强化」环节的验收用例。
 * 1:1 移植自 iOS NoteBarAppTests/ReinforceSessionTests.swift（18 条）。
 * 全部针对纯逻辑状态机，不依赖任何框架，因此可在单测里完整驱动。
 */
class ReinforceSessionTests {

    /** 把一段作答序列喂给会话，返回每次反馈 */
    private fun answer(
        session: ReinforceSession<String>,
        decisions: List<ReinforceDecision>,
    ): List<ReinforceFeedback<String>> = decisions.map { session.answer(it) }

    // MARK: - 场景一：不熟词集合为空 → 跳过强化

    @Test
    fun emptyWeakSetIsFinishedImmediately() {
        val session = ReinforceSession<String>(weakWords = emptyList())
        assertTrue(session.isFinished)
        assertNull(session.current)
        assertEquals(0, session.remainingCount)
        assertEquals(1, session.round)
        assertEquals(ReinforceFeedback.Kind.Finished, session.answer(ReinforceDecision.known).kind)
        assertFalse(session.draftSnapshot().isResumable)
    }

    // MARK: - 场景二：只呈现不熟词，且保持作答顺序

    @Test
    fun weakWordsKeepAnswerOrderAndDeduplicate() {
        val session = ReinforceSession<String>(weakWords = listOf("c", "a", "c", "b"))
        assertEquals(listOf("c", "a", "b"), session.seed, "顺序 = 正常学习阶段的作答顺序，重复项去重")
        assertEquals("c", session.current)
        assertEquals(3, session.remainingCount)
    }

    // MARK: - 场景三：入队顺序与循环终止条件

    @Test
    fun unknownIsRequeuedAtEndOfRoundInAnswerOrder() {
        // 第 1 轮 [a,b,c]：a 不认识、b 认识、c 不认识 → 下一轮必须是 [a,c]（按作答顺序追加）
        val session = ReinforceSession<String>(weakWords = listOf("a", "b", "c"))
        val feedback = answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.known, ReinforceDecision.unknown))
        assertEquals(
            listOf(ReinforceFeedback.Kind.Advanced, ReinforceFeedback.Kind.Advanced, ReinforceFeedback.Kind.Advanced),
            feedback.map { it.kind },
        )
        assertEquals(2, session.round, "本轮走完后进入第 2 轮")
        assertEquals(listOf("a", "c"), session.currentRound.toList())
        assertEquals("a", session.current)
        assertEquals(emptyList(), session.nextRound.toList(), "提升为当前轮后 nextRound 必须清空")
    }

    @Test
    fun finishesOnlyWhenEveryWordIsKnown() {
        val session = ReinforceSession<String>(weakWords = listOf("a", "b", "c"))
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.known, ReinforceDecision.unknown))
        val feedback = answer(session, listOf(ReinforceDecision.known, ReinforceDecision.known))
        assertEquals(ReinforceFeedback.Kind.Finished, feedback.last().kind)
        assertTrue(session.isFinished)
        assertNull(session.current)
        assertEquals(0, session.remainingCount)
        assertEquals(2, session.round)
        assertEquals(5, session.totalAnswers)
    }

    @Test
    fun unknownAtEndOfRoundDoesNotFinishSession() {
        val session = ReinforceSession<String>(weakWords = listOf("a", "b"))
        // 本轮最后一题仍答「不认识」→ 不能误判为完成
        val feedback = answer(session, listOf(ReinforceDecision.known, ReinforceDecision.unknown))
        assertEquals(ReinforceFeedback.Kind.Advanced, feedback.last().kind)
        assertFalse(session.isFinished)
        assertEquals(listOf("b"), session.currentRound.toList())
        assertEquals(2, session.round)
    }

    @Test
    fun singleWordRepeatsUntilKnown() {
        // 边界：整组只有 1 个不熟词且连续答错 → 每轮重新出现，直到答对
        val session = ReinforceSession<String>(weakWords = listOf("only"))
        val kinds = answer(
            session,
            listOf(
                ReinforceDecision.unknown,
                ReinforceDecision.unknown,
                ReinforceDecision.unknown,
                ReinforceDecision.known,
            ),
        ).map { it.kind }
        assertEquals(4, session.round)
        assertNull(session.current)
        assertTrue(session.isFinished)
        assertEquals(4, session.seenCount(of = "only"))
        assertEquals(3, session.unknownCount(of = "only"))
        assertEquals(ReinforceFeedback.Kind.Finished, kinds.last())
    }

    // MARK: - 场景三边界：全部不认识不得死循环

    @Test
    fun allUnknownHaltsAtSafetyLimitInsteadOfLoopingForever() {
        val session = ReinforceSession<String>(weakWords = listOf("a"), answerLimit = 6)
        val kinds = (0 until 6).map { session.answer(ReinforceDecision.unknown).kind }

        assertEquals(ReinforceFeedback.Kind.LimitReached, kinds.last(), "第 6 次作答必须回报触及上限")
        assertTrue(session.isHalted)
        assertEquals(6, session.totalAnswers)

        // 暂停期间继续调用 answer：队列、计数、轮次全部不变
        val before = listOf(
            session.currentRound.toList(),
            session.nextRound.toList(),
            session.round,
            session.totalAnswers,
        )
        repeat(50) { session.answer(ReinforceDecision.unknown) }
        assertEquals(before[0], session.currentRound.toList())
        assertEquals(before[1], session.nextRound.toList())
        assertEquals(before[2], session.round)
        assertEquals(before[3], session.totalAnswers, "暂停后不得再累加作答，避免无限循环")
        assertTrue(session.isHalted)
    }

    @Test
    fun extendLimitLetsUserContinueAfterHalting() {
        val session = ReinforceSession<String>(weakWords = listOf("a"), answerLimit = 3)
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.unknown, ReinforceDecision.unknown))
        assertTrue(session.isHalted)

        session.extendAnswerLimit(by = 2)
        assertFalse(session.isHalted)
        assertEquals(ReinforceFeedback.Kind.Finished, session.answer(ReinforceDecision.known).kind)
        assertTrue(session.isFinished)
    }

    @Test
    fun passManuallyResolvesStuckWord() {
        // 用户在「卡住了」提示里选择「标记为认识」→ 该词从两个队列中移除
        val session = ReinforceSession<String>(weakWords = listOf("a", "b"), answerLimit = 100)
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.unknown))
        assertEquals(listOf("a", "b"), session.currentRound.toList())
        session.passManually("a")
        assertEquals(listOf("b"), session.currentRound.toList())
        assertEquals(emptyList(), session.nextRound.toList())
        session.passManually("b")
        assertTrue(session.isFinished)
    }

    // MARK: - 场景三：连续答错提示与多轮重复计数

    @Test
    fun stuckHintFiresOncePerStreak() {
        val session = ReinforceSession<String>(weakWords = listOf("a"), answerLimit = 100)
        assertEquals(ReinforceFeedback.Kind.Advanced, session.answer(ReinforceDecision.unknown).kind) // streak 1
        assertEquals(ReinforceFeedback.Kind.Advanced, session.answer(ReinforceDecision.unknown).kind) // streak 2
        assertEquals(ReinforceFeedback.Kind.Stuck, session.answer(ReinforceDecision.unknown).kind) // streak 3 = 阈值
        repeat(4) {
            assertEquals(
                ReinforceFeedback.Kind.Advanced,
                session.answer(ReinforceDecision.unknown).kind,
                "同一次连错内不应反复提示",
            )
        }
    }

    @Test
    fun wrongStreakResetsAfterKnown() {
        val session = ReinforceSession<String>(weakWords = listOf("a"), answerLimit = 100)
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.unknown))
        val feedback = session.answer(ReinforceDecision.known)
        assertEquals(ReinforceFeedback.Kind.Finished, feedback.kind)
        assertEquals(0, feedback.wrongStreak)
        assertEquals(0, session.tally["a"]?.wrongStreak)
    }

    @Test
    fun perWordCountersAccumulateAcrossRounds() {
        val session = ReinforceSession<String>(weakWords = listOf("a", "b"), answerLimit = 100)
        // 第 1 轮：a 错、b 对；第 2 轮：a 错；第 3 轮：a 对
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.known))
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.known))
        assertEquals(3, session.seenCount(of = "a"), "同一单词多轮重复应累计呈现次数")
        assertEquals(2, session.unknownCount(of = "a"))
        assertEquals(1, session.tally["a"]?.known)
        assertEquals(1, session.seenCount(of = "b"), "已通过的词不再出现，计数停在第 1 轮")
        assertEquals(4, session.totalAnswers)
    }

    // MARK: - 场景四：完成后统计

    @Test
    fun summaryReportsAnswerCountAndHardestWords() {
        val session = ReinforceSession<String>(weakWords = listOf("a", "b"), answerLimit = 100)
        answer(
            session,
            listOf(
                ReinforceDecision.unknown,
                ReinforceDecision.unknown,
                ReinforceDecision.unknown,
                ReinforceDecision.known,
            ),
        )
        val summary = session.summary
        assertEquals(2, summary.wordCount)
        assertEquals(4, summary.totalAnswers)
        assertEquals(3, summary.rounds)
        assertEquals(listOf("a", "b"), summary.hardestWords, "按答错次数降序，a 错 2 次在前")
    }

    // MARK: - 边界：中途退出与恢复

    @Test
    fun draftRoundTripRestoresQueueRoundsAndCounters() {
        val session = ReinforceSession<String>(
            weakWords = listOf("a", "b", "c"),
            books = listOf("Words/A.canvas"),
            answerLimit = 100,
        )
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.known, ReinforceDecision.unknown))

        val draft = session.draftSnapshot()
        val restored = ReinforceSession.resuming(draft)
        assertNotNull(restored)
        assertEquals(session.currentRound.toList(), restored!!.currentRound.toList())
        assertEquals(session.round, restored.round)
        assertEquals(session.totalAnswers, restored.totalAnswers)
        assertEquals(session.seenCount("a"), restored.seenCount("a"))
        assertEquals(listOf("Words/A.canvas"), restored.books)
        assertEquals(2, draft.remainingCount)

        // 恢复后继续作答，结果应与「从未退出」完全一致
        assertEquals(restored.answer(ReinforceDecision.known).kind, session.answer(ReinforceDecision.known).kind)
        assertEquals(restored.answer(ReinforceDecision.known).kind, session.answer(ReinforceDecision.known).kind)
        assertTrue(restored.isFinished)
        assertTrue(session.isFinished)
    }

    @Test
    fun draftSurvivesEncodeDecode() {
        val session = ReinforceSession<String>(weakWords = listOf("a", "b"), answerLimit = 100)
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.known))
        val data = NoteBarJson.instance.encodeToString(ReinforceDraft.serializer(), session.draftSnapshot())
        val draft = NoteBarJson.instance.decodeFromString(ReinforceDraft.serializer(), data)
        val restored = ReinforceSession.resuming(draft)
        assertEquals(listOf("a"), restored?.currentRound?.toList())
        assertEquals(2, restored?.round)
        assertEquals(1, restored?.unknownCount("a"))
    }

    @Test
    fun draftIsNotResumableWhenQueueIsEmpty() {
        val done = ReinforceSession<String>(weakWords = listOf("a"))
        done.answer(ReinforceDecision.known)
        val draft = done.draftSnapshot()
        assertFalse(draft.isResumable)
        assertNull(ReinforceSession.resuming(draft), "空队列草稿不应恢复出空的强化环节")
    }

    @Test
    fun restoredDraftKeepsHaltedState() {
        // 触及上限时退出，恢复后必须仍处于暂停态，否则「全部不认识」会绕过上限继续循环
        val session = ReinforceSession<String>(weakWords = listOf("a"), answerLimit = 3)
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.unknown, ReinforceDecision.unknown))
        assertTrue(session.isHalted)
        val restored = ReinforceSession.resuming(session.draftSnapshot())
        assertEquals(true, restored?.isHalted)
        assertEquals(ReinforceFeedback.Kind.LimitReached, restored!!.answer(ReinforceDecision.unknown).kind)
    }

    // MARK: - 场景五（红线）：强化环节不写复习进度

    @Test
    fun draftPayloadNeverContainsStudyProgressFields() {
        // 强化环节只允许持久化「本环节循环判定状态」。
        // 一旦这里出现任何复习进度字段，就等于把强化判定写进了掌握度 / 下次复习时间。
        val session = ReinforceSession<String>(weakWords = listOf("a", "b"), answerLimit = 100)
        answer(session, listOf(ReinforceDecision.unknown, ReinforceDecision.known, ReinforceDecision.unknown))
        val data = NoteBarJson.instance.encodeToString(ReinforceDraft.serializer(), session.draftSnapshot())
        val payload = kotlinx.serialization.json.Json.parseToJsonElement(data).jsonObject

        val allowed = setOf(
            "weakKeys", "currentRound", "nextRound", "round", "totalAnswers",
            "tallies", "books", "answerLimit", "updatedAt",
        )
        assertEquals(allowed, payload.keys, "草稿 JSON 的键必须恰好是这 9 个")

        val forbidden = listOf(
            "dueDate", "lastReview", "history", "lapses", "status", "stage",
            "reps", "ef", "interval", "lifecycle", "masteredAt", "pinned", "firstLearnedDate",
        )
        for (field in forbidden) {
            assertFalse(payload.keys.contains(field), "草稿不得包含复习进度字段 $field")
        }

        // 每个词的计数也只允许出现在本环节的四个维度上
        val tallies = payload.getValue("tallies").jsonObject
        assertTrue(tallies.isNotEmpty())
        for ((_, tally) in tallies) {
            assertEquals(
                setOf("seen", "known", "unknown", "wrongStreak"),
                tally.jsonObject.keys,
            )
        }
    }
}

package com.notebar.app.data

import com.notebar.engine.ReinforceDraft
import com.notebar.engine.ReinforceSession
import com.notebar.engine.ReinforceTally
import com.notebar.engine.ReinforceDecision
import com.notebar.engine.TimeIso
import com.notebar.engine.draftSnapshot
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 强化草稿的**字段白名单**契约（红线 3）。
 *
 * 草稿只允许保存本环节的循环判定状态；一旦出现任何 `StudyProgress` / sidecar 字段，
 * 强化环节就会事实上变成"另一种复习进度"，破坏「判定不写进度」的保证。
 * 这类回归极其隐蔽，因此用序列化键集合 + 逐字段值断言双重钉死。
 */
class ReinforceDraftCodecTest {

    /**
     * 复习进度字段。注意 `updatedAt` 被排除：`StudyProgress.updatedAt` 与
     * `ReinforceDraft.updatedAt` 是**同名不同义**（前者是进度更新时间，后者是本环节
     * 草稿的保存时间），草稿带这个键不构成"写入了复习进度"。
     * 判定与 sidecar 字段重叠时以值断言（见 ReviewSessionTest 的红线用例）为准。
     */
    private val studyProgressFields = setOf(
        "status", "stage", "reps", "ef", "interval", "s", "d", "lapses",
        "dueDate", "lastReview", "history", "lifecycle", "pinned", "masteredAt",
    )

    private fun draft(
        currentRound: List<String> = listOf("en:word:apple", "en:word:banana"),
        nextRound: List<String> = listOf("en:word:banana"),
    ) = ReinforceDraft(
        weakKeys = listOf("en:word:apple", "en:word:banana"),
        currentRound = currentRound,
        nextRound = nextRound,
        round = 2,
        totalAnswers = 7,
        tallies = mapOf(
            "en:word:apple" to ReinforceTally(seen = 3, known = 1, unknown = 2, wrongStreak = 0),
        ),
        books = listOf("Words/a.canvas"),
        answerLimit = 50,
        updatedAt = "2026-08-20T10:00:00Z",
    )

    @Test
    fun encodedKeysAreExactlyTheAllowedWhitelist() {
        val raw = ReinforceDraftCodec.encode(draft())
        val keys = (Json.parseToJsonElement(raw) as JsonObject).keys
        assertEquals(ReinforceDraftCodec.allowedKeys, keys)
    }

    @Test
    fun payloadNeverContainsStudyProgressFields() {
        val raw = ReinforceDraftCodec.encode(draft())
        val keys = (Json.parseToJsonElement(raw) as JsonObject).keys
        val leaked = keys.intersect(studyProgressFields)
        assertTrue("草稿里出现了复习进度字段：$leaked", leaked.isEmpty())
        // 再确认一遍：草稿里的 updatedAt 是本环节草稿时间，不是进度时间
        assertEquals("2026-08-20T10:00:00Z", (Json.parseToJsonElement(raw).jsonObject["updatedAt"]!! as JsonPrimitive).content)
    }

    @Test
    fun tallyPayloadNeverContainsStudyProgressFields() {
        val raw = ReinforceDraftCodec.encodeTally(ReinforceTally(seen = 1, known = 1))
        val keys = (Json.parseToJsonElement(raw) as JsonObject).keys
        assertEquals(ReinforceDraftCodec.allowedTallyKeys, keys)
        val leaked = keys.intersect(studyProgressFields)
        assertTrue("计数里出现了复习进度字段：$leaked", leaked.isEmpty())
    }

    @Test
    fun roundTripPreservesLoopState() {
        val original = draft()
        assertEquals(original, ReinforceDraftCodec.decode(ReinforceDraftCodec.encode(original)))
    }

    @Test
    fun decodeReturnsNullOnGarbage() {
        assertNull(ReinforceDraftCodec.decode("{not json"))
        assertNull(ReinforceDraftCodec.decode(null))
        assertNull(ReinforceDraftCodec.decode(""))
    }

    @Test
    fun isResumableIsFalseWhenBothRoundsEmpty() {
        val empty = draft(currentRound = emptyList(), nextRound = emptyList())
        assertFalse(empty.isResumable)
        assertTrue(draft().isResumable)
    }

    @Test
    fun remainingCountIsDeduplicatedAcrossRounds() {
        val d = draft(currentRound = listOf("a", "b"), nextRound = listOf("b", "c"))
        assertEquals(3, d.remainingCount)
    }

    @Test
    fun snapshotFromLiveSessionKeepsCounters() {
        val session = ReinforceSession(weakWords = listOf("a", "b"), books = listOf("Words/a.canvas"))
        session.answer(ReinforceDecision.unknown)
        session.answer(ReinforceDecision.known)
        val draft = session.draftSnapshot()

        val restored = ReinforceSession.resuming(ReinforceDraftCodec.decode(
            ReinforceDraftCodec.encode(draft),
        )!!)!!
        assertEquals(session.totalAnswers, restored.totalAnswers)
        assertEquals(session.round, restored.round)
        assertEquals(session.seenCount("a"), restored.seenCount("a"))
        assertEquals(session.unknownCount("a"), restored.unknownCount("a"))
        assertEquals(session.answerLimit, restored.answerLimit)
    }

    @Test
    fun timestampUsesIso8601LikeIos() {
        val now = TimeIso.nowString()
        assertTrue("时间串应为 ISO8601：$now", TimeIso.parse(now) != null)
    }

    @Test
    fun unknownFieldsInStoredDraftAreIgnoredNotFatal() {
        val raw = """
            {"weakKeys":["a"],"currentRound":["a"],"nextRound":[],"round":1,
             "totalAnswers":2,"tallies":{},"books":[],"answerLimit":50,
             "updatedAt":"2026-08-20T10:00:00Z","futureField":{"nested":1}}
        """.trimIndent()
        val decoded = ReinforceDraftCodec.decode(raw)
        assertEquals(listOf("a"), decoded!!.weakKeys)
        assertEquals(2, decoded.totalAnswers)
    }
}

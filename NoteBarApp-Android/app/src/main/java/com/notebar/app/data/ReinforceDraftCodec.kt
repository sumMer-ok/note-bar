package com.notebar.app.data

import com.notebar.engine.ReinforceDraft
import com.notebar.engine.ReinforceTally
import com.notebar.engine.TimeIso
import kotlinx.serialization.json.Json

/**
 * 强化草稿的持久化编解码。
 *
 * 红线（红线 3）：草稿的字段白名单**不得扩张**——它只能包含本环节的循环判定状态
 * （weakKeys / currentRound / nextRound / round / totalAnswers / tallies / books /
 * answerLimit / updatedAt），与 `StudyProgress` / sidecar 的复习进度字段零交集。
 * 该白名单由 `ReinforceDraftCodecTest` 与 `ReinforceDraftPayloadNeverContainsStudyProgressFields`
 * 两条测试共同钉死。
 *
 * 时间戳沿用 engine 的 ISO8601 口径（[TimeIso.nowString]），与 iOS
 * `ISO8601DateFormatter().string(from: Date())` 一致。
 */
object ReinforceDraftCodec {

    private val json = Json {
        encodeDefaults = true
        explicitNulls = false
        ignoreUnknownKeys = true
    }

    fun encode(draft: ReinforceDraft): String = json.encodeToString(ReinforceDraft.serializer(), draft)

    fun decode(raw: String?): ReinforceDraft? {
        if (raw.isNullOrBlank()) return null
        return runCatching { json.decodeFromString(ReinforceDraft.serializer(), raw) }.getOrNull()
    }

    /** 草稿允许出现的 JSON 键（用于测试断言白名单没有扩张） */
    val allowedKeys: Set<String> = setOf(
        "weakKeys", "currentRound", "nextRound", "round", "totalAnswers",
        "tallies", "books", "answerLimit", "updatedAt",
    )

    /** 单条计数允许出现的 JSON 键 */
    val allowedTallyKeys: Set<String> = setOf("seen", "known", "unknown", "wrongStreak")

    /** 序列化一条计数，供测试核对键集合 */
    fun encodeTally(tally: ReinforceTally): String = json.encodeToString(ReinforceTally.serializer(), tally)
}

package com.notebar.engine

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * studyKey 冻结向量测试（与 iOS/桌面端共用同一份 sync-vectors.json）。
 * 覆盖 NFKC 全角转半角、Unicode 小写（İ）、中文 concept、phrase 等边界。
 */
class StudyKeyVectorTests {

    private fun loadVectors(): List<Triple<String, String?, String?>> {
        val stream = javaClass.getResourceAsStream("/sync-vectors.json")
            ?: error("找不到测试向量 /sync-vectors.json")
        val root = Json.parseToJsonElement(stream.readBytes().decodeToString()).jsonObject
        return root.getValue("studyKeys").jsonArray.map { element ->
            val obj = element.jsonObject
            val input = obj.getValue("input").jsonObject
            val word = input.getValue("word").jsonPrimitive.content
            val language = input["language"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
            val type = input["type"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
            Triple(word, language, type)
        }
    }

    private fun loadExpected(): List<String> {
        val stream = javaClass.getResourceAsStream("/sync-vectors.json")!!
        val root = Json.parseToJsonElement(stream.readBytes().decodeToString()).jsonObject
        return root.getValue("studyKeys").jsonArray.map { it.jsonObject.getValue("expected").jsonPrimitive.content }
    }

    @Test
    fun frozenVectors() {
        val inputs = loadVectors()
        val expected = loadExpected()
        assertTrue(inputs.isNotEmpty())

        inputs.forEachIndexed { index, (word, language, type) ->
            val key = StudyKey.build(word = word, language = language, type = type)
            assertEquals(expected[index], key, "输入：word=$word language=$language type=$type")
        }
    }

    @Test
    fun canvasFallbackKey() {
        assertEquals(
            "English/words.canvas:abcd",
            StudyKey.canvas(source = "English/words.canvas", nodeId = "abcd"),
        )
    }

    /** 空文本与纯标点在规范化后为空 → 不生成 key */
    @Test
    fun blankWordProducesNullKey() {
        assertEquals(null, StudyKey.build(word = "   ", language = "en", type = null))
        assertEquals(null, StudyKey.build(word = "!!!", language = "en", type = null))
    }
}

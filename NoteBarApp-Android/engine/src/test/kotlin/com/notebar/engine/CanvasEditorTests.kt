package com.notebar.engine

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** 1:1 移植自 iOS NoteBarAppTests/CanvasEditorTests.swift（4 条）+ 文件格式保真边界 */
class CanvasEditorTests {

    @Test
    fun parseTemplate() {
        val json = """
        {"nodes":[
          {"id":"n1","type":"text","x":0,"y":0,"width":260,"height":120,"text":"hello\n*hi, hey*\n\n你好，问候"}
        ],"edges":[]}
        """.trimIndent()
        val words = CanvasEditor.parseWords(data = json, source = "English/words.canvas")
        assertEquals(1, words.size)
        assertEquals("hello", words[0].word)
        assertEquals(listOf("hi", "hey"), words[0].aliases)
        assertEquals("你好，问候", words[0].definition)
    }

    @Test
    fun addWordCreatesTodayGroupAndPreservesUnknownFields() {
        val root = NoteBarJson.instance.parseToJsonElement(
            """{"nodes":[],"edges":[],"futureField":{"keep":true}}""",
        ).jsonObject

        val (updated, nodeId) = CanvasEditor.addWord(
            root = root,
            word = "world",
            definition = "世界",
            aliases = listOf("globe"),
            color = "2",
            cardWidth = 260.0,
            cardHeight = 120.0,
        )

        assertEquals(16, nodeId.length)
        val nodes = updated.getValue("nodes").jsonArray.map { it.jsonObject }
        val group = nodes.first { it["type"]?.jsonPrimitive?.content == "group" }
        assertEquals(CanvasEditor.todayLabel(), group["label"]?.jsonPrimitive?.content)
        val textNode = nodes.first { it["type"]?.jsonPrimitive?.content == "text" }
        assertEquals("world\n*globe*\n\n世界", textNode["text"]?.jsonPrimitive?.content)
        // 未知顶层字段必须原样保留（跨端契约的关键护栏）
        assertEquals(true, updated.getValue("futureField").jsonObject.getValue("keep").jsonPrimitive.boolean)
    }

    @Test
    fun updateAndDeleteWord() {
        val root = NoteBarJson.instance.parseToJsonElement(
            """{"nodes":[{"id":"n1","type":"text","text":"old","x":0,"y":0}],"edges":[]}""",
        ).jsonObject

        val updated = CanvasEditor.updateWord(
            root = root, nodeId = "n1", word = "new", definition = "新", aliases = listOf("n"),
        )
        assertNotNull(updated)
        assertEquals(
            "new\n*n*\n\n新",
            updated.getValue("nodes").jsonArray[0].jsonObject["text"]?.jsonPrimitive?.content,
        )

        val deleted = CanvasEditor.deleteWord(root = updated, nodeId = "n1")
        assertNotNull(deleted)
        assertEquals(0, deleted.getValue("nodes").jsonArray.size)

        // 找不到 id 时返回 null（对应 iOS 返回 false），不得静默改写文件
        assertNull(CanvasEditor.updateWord(root, "missing", "x", "", emptyList()))
        assertNull(CanvasEditor.deleteWord(root, "missing"))
    }

    @Test
    fun masteredDetectionFromGroupAndColor() {
        val json = """
        {"nodes":[
          {"id":"g1","type":"group","label":"Mastered","x":0,"y":0,"width":300,"height":200},
          {"id":"n1","type":"text","x":10,"y":10,"width":50,"height":30,"text":"alpha\n\n释义A"},
          {"id":"n2","type":"text","x":100,"y":10,"width":50,"height":30,"text":"beta\n\n释义B","color":"4"},
          {"id":"n3","type":"text","x":10,"y":250,"width":50,"height":30,"text":"gamma\n\n释义C"}
        ],"edges":[]}
        """.trimIndent()
        val words = CanvasEditor.parseWords(data = json, source = "Words/x.canvas")
        val byId = words.associateBy { it.nodeId }
        assertEquals(true, byId.getValue("n1").mastered)
        assertEquals(true, byId.getValue("n2").mastered)
        assertEquals(false, byId.getValue("n3").mastered)
    }

    /** `已掌握` 中文分组与日期分组的 addedDate 提取 */
    @Test
    fun parsesChineseMasteredGroupAndAddedDate() {
        val json = """
        {"nodes":[
          {"id":"g1","type":"group","label":"已掌握","x":0,"y":0,"width":300,"height":200},
          {"id":"g2","type":"group","label":"2026-08-10","x":0,"y":200,"width":300,"height":200},
          {"id":"n1","type":"text","x":10,"y":10,"width":50,"height":30,"text":"alpha\n\n释义A"},
          {"id":"n2","type":"text","x":10,"y":210,"width":50,"height":30,"text":"beta\n\n释义B"}
        ],"edges":[]}
        """.trimIndent()
        val byId = CanvasEditor.parseWords(json).associateBy { it.nodeId }
        assertEquals(true, byId.getValue("n1").mastered)
        assertEquals(false, byId.getValue("n2").mastered)
        assertEquals("2026-08-10", byId.getValue("n2").addedDate)
    }

    /** 词条文本的首行 `# 标题` 与 Markdown 强调标记需被剥掉 */
    @Test
    fun stripsHeadingAndMarkdownFromWordLine() {
        val json = """{"nodes":[{"id":"n1","type":"text","x":0,"y":0,"text":"## **Apple**\n\n苹果"}],"edges":[]}"""
        val words = CanvasEditor.parseWords(json)
        assertEquals("apple", words[0].word)
    }

    /** 分组内的词条应按 2 列自动排布（第 2 个词在第二列） */
    @Test
    fun addWordLaysOutTwoColumns() {
        var root: JsonObject = NoteBarJson.instance.parseToJsonElement("""{"nodes":[],"edges":[]}""").jsonObject
        val (r1, _) = CanvasEditor.addWord(root, "a", "甲", emptyList(), null, 260.0, 120.0)
        val (r2, _) = CanvasEditor.addWord(r1, "b", "乙", emptyList(), null, 260.0, 120.0)
        val texts = r2.getValue("nodes").jsonArray.map { it.jsonObject }
            .filter { it["type"]?.jsonPrimitive?.content == "text" }
        assertEquals(2, texts.size)
        val x1 = texts[0]["x"]!!.jsonPrimitive.content.toDouble()
        val y1 = texts[0]["y"]!!.jsonPrimitive.content.toDouble()
        val x2 = texts[1]["x"]!!.jsonPrimitive.content.toDouble()
        val y2 = texts[1]["y"]!!.jsonPrimitive.content.toDouble()
        assertTrue(x2 > x1, "第 2 个词应在第二列")
        assertEquals(y1, y2, "同一行 y 应相同")
    }
}

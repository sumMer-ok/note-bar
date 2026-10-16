package com.notebar.engine

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.SecureRandom
import java.time.LocalDate
import java.util.Locale

/**
 * Obsidian `.canvas` 词库的解析与编辑。
 *
 * 逐函数移植自 NoteBarApp/Models/CanvasEditor.swift。**文件格式是 Android 端与桌面插件的
 * 唯一共享契约**，因此这里不引入任何自定义 schema：读到的 JSON 原样保留（未知字段、
 * 边数组、任何后续版本新增的键都不得丢弃），只改必须改的 nodes。
 *
 * 与 iOS 的差异（语言所限，非语义差异）：kotlinx.serialization 的 JsonObject 不可变，
 * 所以读写改成「传入 root、返回新 root」，语义与 Swift 的 inout 字典一致。
 */
object CanvasEditor {

    /** 16 位十六进制随机节点 id（对应 iOS randomHexId） */
    fun randomHexId(): String {
        val bytes = ByteArray(8)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { String.format(Locale.US, "%02x", it) }
    }

    /** 今天的日期分组标签 `YYYY-MM-DD`（对应 iOS todayLabel） */
    fun todayLabel(date: LocalDate = LocalDate.now()): String =
        String.format(Locale.US, "%04d-%02d-%02d", date.year, date.monthValue, date.dayOfMonth)

    /**
     * 解析 Canvas 中的词条。
     *
     * @param source 词库相对路径（仅用于报错定位，与 iOS 签名保持一致）
     */
    fun parseWords(data: String, source: String = ""): List<ParsedWord> {
        val root = NoteBarJson.instance.parseToJsonElement(data).jsonObject
        val nodes = (root["nodes"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
        val groups = nodes.filter { it.string("type") == "group" }
        val masteredGroup = groups.firstOrNull { node ->
            val label = node.string("label")
            label == "Mastered" || label == "已掌握"
        }
        val dateGroupRegex = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        val dateGroups = groups.filter { node ->
            val label = node.string("label") ?: return@filter false
            dateGroupRegex.matches(label)
        }

        val words = ArrayList<ParsedWord>()
        for (node in nodes) {
            val type = node.string("type") ?: continue
            val id = node.string("id") ?: continue
            val text: String = when (type) {
                "text" -> node.string("text") ?: ""
                "file" -> node.string("file") ?: ""
                else -> continue
            }
            val parsed = parseText(text) ?: continue
            var addedDate: String? = null
            for (group in dateGroups) {
                if (nodeInGroup(node, group)) addedDate = group.string("label")
            }
            var mastered = false
            if (masteredGroup != null && nodeInGroup(node, masteredGroup)) mastered = true
            if (node.string("color") == "4") mastered = true
            words.add(
                ParsedWord(
                    nodeId = id,
                    word = parsed.word,
                    aliases = parsed.aliases,
                    definition = parsed.definition,
                    color = node.string("color"),
                    addedDate = addedDate,
                    mastered = mastered,
                ),
            )
        }
        return words
    }

    /**
     * 新增词条：复用（或新建）今天的日期分组，返回新的 root 与新建的 nodeId。
     * 对应 iOS `addWord(data:inout...) -> String`。
     */
    fun addWord(
        root: JsonObject,
        word: String,
        definition: String,
        aliases: List<String>,
        color: String?,
        cardWidth: Double,
        cardHeight: Double,
    ): Pair<JsonObject, String> {
        val nodes = ArrayList<JsonElement>(
            (root["nodes"] as? JsonArray)?.toList() ?: emptyList(),
        )
        val nodeId = randomHexId()

        var group = nodes.filterIsInstance<JsonObject>()
            .firstOrNull { it.string("type") == "group" && it.string("label") == todayLabel() }
        if (group == null) {
            val maxX = nodes.filterIsInstance<JsonObject>()
                .filter { it.string("type") == "group" }
                .maxOfOrNull { (it.double("x") ?: 0.0) + (it.double("width") ?: 0.0) } ?: 0.0
            val newGroup = JsonObject(
                mapOf(
                    "id" to JsonPrimitive(randomHexId()),
                    "type" to JsonPrimitive("group"),
                    "x" to JsonPrimitive(if (nodes.isEmpty()) 0.0 else maxX + 40),
                    "y" to JsonPrimitive(0.0),
                    "width" to JsonPrimitive(48 + cardWidth),
                    "height" to JsonPrimitive(48 + cardHeight),
                    "label" to JsonPrimitive(todayLabel()),
                ),
            )
            nodes.add(newGroup)
            group = newGroup
        }
        val targetGroup = group!!

        val members = nodes.filterIsInstance<JsonObject>()
            .filter { it.string("type") != "group" && nodeInGroup(it, targetGroup) }
        val index = members.size
        val col = index % 2
        val row = index / 2
        val gx = targetGroup.double("x") ?: 0.0
        val gy = targetGroup.double("y") ?: 0.0

        val text = buildNodeText(word, definition, aliases)

        val node = LinkedHashMap<String, JsonElement>()
        node["id"] = JsonPrimitive(nodeId)
        node["type"] = JsonPrimitive("text")
        node["x"] = JsonPrimitive(gx + 24 + col * (cardWidth + 12))
        node["y"] = JsonPrimitive(gy + 24 + row * (cardHeight + 12))
        node["width"] = JsonPrimitive(cardWidth)
        node["height"] = JsonPrimitive(cardHeight)
        node["text"] = JsonPrimitive(text)
        if (color != null) node["color"] = JsonPrimitive(color)
        nodes.add(JsonObject(node))

        return withNodes(root, nodes) to nodeId
    }

    /** 更新词条文本；找不到 nodeId 返回 null（对应 iOS 返回 false） */
    fun updateWord(
        root: JsonObject,
        nodeId: String,
        word: String,
        definition: String,
        aliases: List<String>,
    ): JsonObject? {
        val nodes = (root["nodes"] as? JsonArray)?.toList() ?: return null
        val i = nodes.indexOfFirst { (it as? JsonObject)?.string("id") == nodeId }
        if (i < 0) return null
        val existing = nodes[i].jsonObject
        val updated = LinkedHashMap(existing)
        updated["text"] = JsonPrimitive(buildNodeText(word, definition, aliases))
        val mutable = ArrayList(nodes)
        mutable[i] = JsonObject(updated)
        return withNodes(root, mutable)
    }

    /** 删除词条；找不到 nodeId 返回 null（对应 iOS 返回 false） */
    fun deleteWord(root: JsonObject, nodeId: String): JsonObject? {
        val nodes = (root["nodes"] as? JsonArray)?.toList() ?: return null
        val i = nodes.indexOfFirst { (it as? JsonObject)?.string("id") == nodeId }
        if (i < 0) return null
        val mutable = ArrayList(nodes)
        mutable.removeAt(i)
        return withNodes(root, mutable)
    }

    // MARK: - 内部

    /** 替换 root 的 nodes，其余键（含未知字段、edges）原样保留 */
    private fun withNodes(root: JsonObject, nodes: List<JsonElement>): JsonObject {
        val map = LinkedHashMap(root)
        map["nodes"] = JsonArray(nodes)
        return JsonObject(map)
    }

    /** 节点文本：词 + 斜体别名 + 空行 + 释义（与桌面三段式契约一致） */
    private fun buildNodeText(word: String, definition: String, aliases: List<String>): String {
        val sb = StringBuilder(word)
        if (aliases.isNotEmpty()) sb.append("\n*").append(aliases.joinToString(", ")).append("*")
        if (definition.isNotEmpty()) sb.append("\n\n").append(definition)
        return sb.toString()
    }

    private data class ParsedText(val word: String, val aliases: List<String>, val definition: String)

    /** 解析节点文本：首行为词、`*...*` 行为别名、其余为释义（对应 iOS parseText） */
    private fun parseText(text: String): ParsedText? {
        val lines = text.split("\n").toMutableList()
        while (lines.isNotEmpty() && lines.first().trim() == "") lines.removeAt(0)
        var word = lines.firstOrNull()?.trim() ?: return null
        if (word.isEmpty()) return null
        word = word.replace(Regex("^#+\\s*"), "")
        word = stripMarkdown(word)
        if (word.isEmpty()) return null
        lines.removeAt(0)

        var aliases: List<String> = emptyList()
        val definitionLines = ArrayList<String>()
        var seenDefinition = false
        for (line in lines) {
            val t = line.trim()
            if (!seenDefinition &&
                t.startsWith("*") && t.endsWith("*") &&
                !t.startsWith("**") && !t.endsWith("**") && t.length > 2
            ) {
                aliases = t.drop(1).dropLast(1).split(",")
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
            } else if (t.isNotEmpty()) {
                seenDefinition = true
                definitionLines.add(t)
            } else if (seenDefinition) {
                definitionLines.add(t)
            }
        }
        return ParsedText(word.lowercase(), aliases, definitionLines.joinToString("\n").trim('\n'))
    }

    /** 去掉常见 Markdown 强调标记（对应 iOS stripMarkdown） */
    private fun stripMarkdown(s: String): String = s
        .replace(Regex("\\*\\*(.*?)\\*\\*"), "$1")
        .replace(Regex("\\*(.*?)\\*"), "$1")
        .replace(Regex("__(.*?)__"), "$1")
        .replace(Regex("`(.*?)`"), "$1")
        .trim()

    /** 节点中心点是否落在分组矩形内（对应 iOS nodeInGroup） */
    private fun nodeInGroup(node: JsonObject, group: JsonObject): Boolean {
        val nx = node.double("x") ?: 0.0
        val ny = node.double("y") ?: 0.0
        val nw = node.double("width") ?: 200.0
        val nh = node.double("height") ?: 60.0
        val gx = group.double("x") ?: 0.0
        val gy = group.double("y") ?: 0.0
        val gw = group.double("width") ?: 0.0
        val gh = group.double("height") ?: 0.0
        val cx = nx + nw / 2
        val cy = ny + nh / 2
        return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.double(key: String): Double? =
        (this[key] as? JsonPrimitive)?.doubleOrNull
}

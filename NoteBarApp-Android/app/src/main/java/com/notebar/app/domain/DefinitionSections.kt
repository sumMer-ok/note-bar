package com.notebar.app.domain

import com.notebar.app.data.DefinitionModule

/** 解析出的一个释义分节；对应 iOS `ParsedDefinitionModule` */
data class ParsedDefinitionModule(
    val module: DefinitionModule,
    val headerLine: String?,
    val content: String,
)

/** 一个模块的展示内容；对应 iOS `DefinitionSections.modules` 的返回元组 */
data class DefinitionSection(
    val module: DefinitionModule,
    val content: String,
    val headerLine: String?,
)

/**
 * Canvas 释义里 `--- 标题 ---` 分节的解析与序列化。
 *
 * 逐行移植自 `NoteBarApp/Models/DefinitionSections.swift`：
 * 四个模块（词典释义 / 法律词典释义 / AI 释义 / 自定义笔记）的归并顺序、
 * 标题写法（`--- Black's Law Dictionary ---` 等）、以及"重新序列化时能保留
 * 原分节顺序与标题写法，桌面端可直接解析"的约定都照抄，不得"优化"。
 */
object DefinitionSections {

    /** `^\s*---\s*(.+?)\s*---(.*)$` */
    private val headerRegex = Regex("^\\s*---\\s*(.+?)\\s*---(.*)$")

    fun parse(raw: String): List<ParsedDefinitionModule> {
        val modules = ArrayList<ParsedDefinitionModule>()
        var currentHeader: String? = null
        var buffer = ArrayList<String>()

        fun flush() {
            val content = buffer.joinToString("\n").trim()
            if (content.isNotEmpty() || currentHeader != null) {
                modules.add(
                    ParsedDefinitionModule(
                        module = moduleKey(currentHeader),
                        headerLine = currentHeader,
                        content = content,
                    ),
                )
            }
            buffer = ArrayList()
        }

        for (line in raw.split("\n")) {
            val parsed = headerAndTrailing(line)
            if (parsed != null) {
                flush()
                currentHeader = parsed.first
                if (parsed.second.isNotEmpty()) buffer.add(parsed.second)
            } else {
                buffer.add(line)
            }
        }
        flush()
        return modules
    }

    /** 合并同类 section，按给定顺序返回；空内容的模块被跳过 */
    fun modules(
        raw: String,
        order: List<DefinitionModule> = DefinitionModule.allCases,
    ): List<DefinitionSection> {
        val parsed = parse(raw)
        val result = ArrayList<DefinitionSection>()
        for (key in order) {
            val matches = parsed.filter { it.module == key }
            if (matches.isEmpty()) continue
            val content = matches.map { it.content }.filter { it.isNotEmpty() }.joinToString("\n\n")
            if (content.isEmpty()) continue
            result.add(DefinitionSection(key, content, matches.firstNotNullOfOrNull { it.headerLine }))
        }
        return result
    }

    fun content(raw: String, module: DefinitionModule): String =
        modules(raw).firstOrNull { it.module == module }?.content ?: ""

    /**
     * 更新某个模块并重新序列化。
     *
     * 注意 [order] 只影响**已有分节的去重收敛**，序列化仍按解析出的原始顺序输出，
     * 与 iOS 一致（iOS 的 `update` 也不重排）。
     */
    fun update(raw: String, module: DefinitionModule, content: String): String {
        val parsed = parse(raw).toMutableList()
        val trimmed = content.trim()

        var updated = false
        for (index in parsed.indices) {
            if (parsed[index].module != module) continue
            if (!updated) {
                val current = parsed[index]
                parsed[index] = if (current.headerLine == null && module != DefinitionModule.dictionary) {
                    ParsedDefinitionModule(module, canonicalHeader(module), trimmed)
                } else {
                    current.copy(content = trimmed)
                }
                updated = true
            } else {
                parsed[index] = parsed[index].copy(content = "")
            }
        }
        if (!updated && trimmed.isNotEmpty()) {
            parsed.add(
                ParsedDefinitionModule(
                    module = module,
                    headerLine = if (module == DefinitionModule.dictionary) null else canonicalHeader(module),
                    content = trimmed,
                ),
            )
        }
        return serialize(parsed)
    }

    /** 按规范顺序（词典→法律→AI→笔记）序列化整份释义，供保存时使用 */
    fun serializeCanonical(
        raw: String,
        contents: Map<DefinitionModule, String>,
        order: List<DefinitionModule> = DefinitionModule.allCases,
    ): String {
        var definition = raw
        for (module in order) {
            definition = update(definition, module, contents[module] ?: "")
        }
        return definition
    }

    private fun headerAndTrailing(line: String): Pair<String, String>? {
        val match = headerRegex.matchEntire(line) ?: return null
        return match.groupValues[1].trim() to match.groupValues[2].trim()
    }

    /** 对应 iOS `moduleKey(for:)` 的关键字判定（含 Black's 的 "black" 与中文「法律」） */
    private fun moduleKey(header: String?): DefinitionModule {
        if (header == null) return DefinitionModule.dictionary
        val lower = header.lowercase()
        if (lower.contains("black") || lower.contains("法律")) return DefinitionModule.legal
        if (lower.contains("ai")) return DefinitionModule.ai
        if (lower.contains("笔记")) return DefinitionModule.notes
        if (lower.contains("词典") || lower.contains("已有释义")) return DefinitionModule.dictionary
        return DefinitionModule.notes
    }

    private fun canonicalHeader(module: DefinitionModule): String = when (module) {
        DefinitionModule.legal -> "Black's Law Dictionary"
        DefinitionModule.ai -> "AI 释义"
        DefinitionModule.notes -> "自定义笔记"
        DefinitionModule.dictionary -> "词典释义"
    }

    private fun serialize(parsed: List<ParsedDefinitionModule>): String {
        val parts = ArrayList<String>()
        for (item in parsed) {
            val content = item.content.trim()
            if (content.isEmpty()) continue
            val header = item.headerLine
            parts.add(if (header != null) "--- $header ---\n$content" else content)
        }
        return parts.joinToString("\n\n")
    }
}

/**
 * 音标提取：优先英式「英/ ... /」，其次美式「美/ ... /」。
 * 逐行移植自 iOS `PhoneticExtractor`。
 */
object PhoneticExtractor {
    private val patterns = listOf(
        Regex("英/\\s*([^/]+?)\\s*/"),
        Regex("美/\\s*([^/]+?)\\s*/"),
    )

    fun phonetic(definition: String): String? {
        for (pattern in patterns) {
            val value = pattern.find(definition)?.groupValues?.get(1)?.trim()
            if (!value.isNullOrEmpty()) return value
        }
        return null
    }
}

/**
 * 有道 TTS 链接拼装。逐行移植自 iOS `AppState.ttsURL(word:us:)`：
 * 先对单词做 URL 编码，再替换 `{{word}}` / `{{type}}` / `{{accent}}` 三个占位符。
 */
object TtsUrl {
    fun build(template: String, word: String, us: Boolean = true): String {
        val encoded = encodeQueryValue(word)
        return template
            .replace("{{word}}", encoded)
            .replace("{{type}}", if (us) "2" else "1")
            .replace("{{accent}}", if (us) "us" else "uk")
    }

    /**
     * 对应 Swift `addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)`：
     * 保留 query 允许的字符，其余按 UTF-8 百分号编码。
     */
    private fun encodeQueryValue(value: String): String {
        val allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/? "
        val out = StringBuilder()
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val ch = byte.toInt().toChar()
            if (byte >= 0 && allowed.contains(ch)) {
                out.append(ch)
            } else {
                out.append('%').append("%02X".format(byte.toInt() and 0xFF))
            }
        }
        return out.toString()
    }
}

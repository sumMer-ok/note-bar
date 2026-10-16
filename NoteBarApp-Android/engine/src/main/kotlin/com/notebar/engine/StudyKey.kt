package com.notebar.engine

import java.text.Normalizer

/**
 * 词条进度键（studyKey）的生成规则。
 *
 * 移植自 NoteBarApp/Engine/StudyKey.swift，必须与 JS 端 normalizeStudyText 口径一致：
 * NFKC → trim → 空白折叠 → 去首尾标点/符号 → 小写。
 *
 * 正确性由跨端共享的冻结测试向量锁定（含全角转半角、İ 的 Unicode 小写等边界）。
 */
object StudyKey {

    /** NFKC 规范化（Swift 的 applyingTransform(.init(rawValue: "NFKC")) 对应 Java 的 NFKC） */
    private fun nfkc(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFKC)

    /**
     * 文本规范化：NFKC → trim → 空白折叠 → 去首尾标点/符号 → 小写。
     *
     * 说明：iOS 用 `lowercased()`（Unicode 默认小写，与 locale 无关），
     * Kotlin 的 `lowercase()` 同样是 locale 无关的 Unicode 默认映射，故直接对应。
     */
    fun normalizeText(value: String): String {
        var s = nfkc(value).trim()
        s = s.replace(Regex("\\s+"), " ")
        s = s.trim { it.isPunctuationOrSymbol() }
        return s.lowercase()
    }

    fun normalizeLanguage(language: String?): String {
        val s = nfkc(language ?: "und").trim().lowercase()
        return if (s.isEmpty()) "und" else s
    }

    fun inferType(word: String, language: String?): String {
        val text = normalizeText(word)
        if (normalizeLanguage(language).startsWith("zh")) return "concept"
        if (Regex("[\\s-]").containsMatchIn(text)) return "phrase"
        return "word"
    }

    fun build(word: String, language: String?, type: String?): String? {
        val text = normalizeText(word)
        if (text.isEmpty()) return null
        val lang = normalizeLanguage(language)
        val kind = type ?: inferType(word, language)
        return "$lang:$kind:$text"
    }

    /** Canvas 普通节点的进度键（桌面回退规则 `source:nodeId`） */
    fun canvas(source: String, nodeId: String): String = "$source:$nodeId"

    /**
     * 判断是否为「首尾标点或符号」。
     *
     * iOS 用 `CharacterSet.punctuationCharacters.union(.symbols)`。Kotlin 没有等价 API，
     * 这里按 Unicode 通用类别实现：P* = 标点（Pc/Pd/Ps/Pe/Pi/Pf/Po），
     * S* = 符号（Sm/Sc/Sk/So）。覆盖测试向量里的 `!`、`，` 等实际用例。
     */
    private fun Char.isPunctuationOrSymbol(): Boolean {
        return when (Character.getType(this)) {
            Character.CONNECTOR_PUNCTUATION.toInt(),
            Character.DASH_PUNCTUATION.toInt(),
            Character.START_PUNCTUATION.toInt(),
            Character.END_PUNCTUATION.toInt(),
            Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
            Character.FINAL_QUOTE_PUNCTUATION.toInt(),
            Character.OTHER_PUNCTUATION.toInt(),
            Character.MATH_SYMBOL.toInt(),
            Character.CURRENCY_SYMBOL.toInt(),
            Character.MODIFIER_SYMBOL.toInt(),
            Character.OTHER_SYMBOL.toInt(),
            -> true

            else -> false
        }
    }
}

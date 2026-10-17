package com.notebar.app.ui.screens

import com.notebar.app.data.DefinitionModule
import com.notebar.app.data.Settings
import com.notebar.app.services.DictionaryEntry
import com.notebar.app.services.legalCorrectionPrompt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 编辑页 AI / 词典判定层的口径测试。
 *
 * 每一条都对着 iOS 源码写，而不是对着实现写：
 * - 按钮可见性 / 文案：`WordDetailView.swift` 的 `if module == .ai || module == .legal || module == .notes`
 *   与 `Label(module == .legal ? "AI 纠正" : "AI 生成", ...)`；
 * - 拦截顺序：`generate(_:)` 里先 `word.trim()` 判空，再对 legal 判正文；
 * - 提示词与句子的取值：`aiConfig` / `notesAIConfig` / legal 临时 Config；
 * - 别名回填条件：`aliases.trimmingCharacters(in: .whitespaces).isEmpty`（只去空格与制表符，不含换行）；
 * - 成功文案：`module == .legal ? "法律词典释义已纠正" : "\(module.rawValue)已生成"`。
 */
class WordEditAiActionsTest {

    private val modules = DefinitionModule.allCases

    // ---- 按钮可见性 ----

    @Test
    fun generateButtonHiddenOnlyOnDictionary() {
        assertEquals(false, WordEditAiActions.showsGenerateButton(DefinitionModule.dictionary))
        assertEquals(true, WordEditAiActions.showsGenerateButton(DefinitionModule.legal))
        assertEquals(true, WordEditAiActions.showsGenerateButton(DefinitionModule.ai))
        assertEquals(true, WordEditAiActions.showsGenerateButton(DefinitionModule.notes))
    }

    @Test
    fun buttonLabelIsCorrectOnlyForLegal() {
        assertEquals("AI 纠正", WordEditAiActions.generateButtonLabel(DefinitionModule.legal))
        assertEquals("AI 生成", WordEditAiActions.generateButtonLabel(DefinitionModule.ai))
        // notes 在 iOS 里也是「AI 生成」，只有 legal 是纠正
        assertEquals("AI 生成", WordEditAiActions.generateButtonLabel(DefinitionModule.notes))
        assertEquals("AI 生成", WordEditAiActions.generateButtonLabel(DefinitionModule.dictionary))
    }

    // ---- 生成前拦截 ----

    @Test
    fun emptyWordBlocksEveryModule() {
        val empty = emptyMap<DefinitionModule, String>()
        modules.forEach { module ->
            assertEquals(
                WordEditAiActions.EMPTY_WORD_MESSAGE,
                WordEditAiActions.blockedMessage(module, "", empty),
            )
        }
    }

    @Test
    fun whitespaceOnlyWordIsStillEmpty() {
        val empty = emptyMap<DefinitionModule, String>()
        listOf(" ", "\t", "\n", "   \n\t ").forEach { word ->
            assertEquals(
                WordEditAiActions.EMPTY_WORD_MESSAGE,
                WordEditAiActions.blockedMessage(DefinitionModule.ai, word, empty),
            )
        }
    }

    @Test
    fun legalNeedsNonEmptyBodyButOthersDoNot() {
        val empty = emptyMap<DefinitionModule, String>()
        assertEquals(
            WordEditAiActions.LEGAL_EMPTY_MESSAGE,
            WordEditAiActions.blockedMessage(DefinitionModule.legal, "contract", empty),
        )
        // legal 正文只有空白也算空
        assertEquals(
            WordEditAiActions.LEGAL_EMPTY_MESSAGE,
            WordEditAiActions.blockedMessage(
                DefinitionModule.legal,
                "contract",
                mapOf(DefinitionModule.legal to "  \n "),
            ),
        )
        // 其余模块不检查正文
        assertNull(WordEditAiActions.blockedMessage(DefinitionModule.ai, "contract", empty))
        assertNull(WordEditAiActions.blockedMessage(DefinitionModule.notes, "contract", empty))
        assertNull(WordEditAiActions.blockedMessage(DefinitionModule.dictionary, "contract", empty))
    }

    @Test
    fun wordIsCheckedBeforeLegalBody() {
        // 单词和 legal 正文同时为空时，iOS 先报「请先输入单词」
        assertEquals(
            WordEditAiActions.EMPTY_WORD_MESSAGE,
            WordEditAiActions.blockedMessage(
                DefinitionModule.legal,
                "  ",
                mapOf(DefinitionModule.legal to ""),
            ),
        )
    }

    @Test
    fun legalPassesWhenBodyPresent() {
        assertNull(
            WordEditAiActions.blockedMessage(
                DefinitionModule.legal,
                "indemnity",
                mapOf(DefinitionModule.legal to "赔偿条款"),
            ),
        )
    }

    // ---- 送进提示词的句子 ----

    @Test
    fun sentenceIsOnlySentForLegal() {
        val contents = mapOf(
            DefinitionModule.legal to "赔偿条款原文",
            DefinitionModule.ai to "AI 释义旧值",
            DefinitionModule.notes to "笔记旧值",
            DefinitionModule.dictionary to "词典旧值",
        )
        assertEquals(
            "赔偿条款原文",
            WordEditAiActions.sentenceFor(DefinitionModule.legal, contents),
        )
        // 非 legal 一律空串，避免把已有释义当例句再送回去
        assertEquals("", WordEditAiActions.sentenceFor(DefinitionModule.ai, contents))
        assertEquals("", WordEditAiActions.sentenceFor(DefinitionModule.notes, contents))
        assertEquals("", WordEditAiActions.sentenceFor(DefinitionModule.dictionary, contents))
    }

    @Test
    fun sentenceForLegalIsNotTrimmed() {
        val contents = mapOf(DefinitionModule.legal to "  原文带空白  ")
        assertEquals("  原文带空白  ", WordEditAiActions.sentenceFor(DefinitionModule.legal, contents))
    }

    @Test
    fun missingLegalBodyYieldsEmptySentence() {
        assertEquals("", WordEditAiActions.sentenceFor(DefinitionModule.legal, emptyMap()))
    }

    // ---- 提示词选择 ----

    @Test
    fun promptIsPickedPerModule() {
        val settings = Settings(aiNotesPrompt = "NOTES_PROMPT")
        val assetPrompt = "ASSET_PROMPT"
        assertEquals(
            assetPrompt,
            WordEditAiActions.promptFor(DefinitionModule.ai, settings, assetPrompt),
        )
        assertEquals(
            legalCorrectionPrompt,
            WordEditAiActions.promptFor(DefinitionModule.legal, settings, assetPrompt),
        )
        assertEquals(
            "NOTES_PROMPT",
            WordEditAiActions.promptFor(DefinitionModule.notes, settings, assetPrompt),
        )
        assertEquals(
            "",
            WordEditAiActions.promptFor(DefinitionModule.dictionary, settings, assetPrompt),
        )
    }

    @Test
    fun aiConfigKeepsSameEndpointAndOnlySwapsPrompt() {
        val settings = Settings(
            aiApiUrl = "https://example.test/v1/chat/completions",
            aiApiKey = "sk-test",
            aiModel = "gpt-4o-mini",
            aiExtraParams = "{\"temperature\":0}",
            aiNotesPrompt = "NOTES_PROMPT",
        )
        val configs = listOf(
            DefinitionModule.ai,
            DefinitionModule.legal,
            DefinitionModule.notes,
        ).map { WordEditAiActions.aiConfig(it, settings, "ASSET_PROMPT") }

        configs.forEach { config ->
            assertEquals(settings.aiApiUrl, config.apiUrl)
            assertEquals(settings.aiApiKey, config.apiKey)
            assertEquals(settings.aiModel, config.model)
            assertEquals(settings.aiExtraParams, config.extraParams)
        }
        assertEquals(listOf("ASSET_PROMPT", legalCorrectionPrompt, "NOTES_PROMPT"), configs.map { it.prompt })
    }

    // ---- 别名回填 ----

    @Test
    fun aliasesFilledOnlyForAiWhenEmpty() {
        assertTrue(WordEditAiActions.shouldFillAliases(DefinitionModule.ai, "", listOf("a")))
        assertTrue(WordEditAiActions.shouldFillAliases(DefinitionModule.ai, "  \t ", listOf("a")))
        // 已有别名不动
        assertFalse(WordEditAiActions.shouldFillAliases(DefinitionModule.ai, "existing", listOf("a")))
        // 只有空格与制表符算空，换行不算（与 iOS `.whitespaces` 一致）
        assertFalse(WordEditAiActions.shouldFillAliases(DefinitionModule.ai, "\n", listOf("a")))
        // 结果为空不回填
        assertFalse(WordEditAiActions.shouldFillAliases(DefinitionModule.ai, "", emptyList()))
        // 非 ai 模块一律不回填
        assertFalse(WordEditAiActions.shouldFillAliases(DefinitionModule.legal, "", listOf("a")))
        assertFalse(WordEditAiActions.shouldFillAliases(DefinitionModule.notes, "", listOf("a")))
    }

    @Test
    fun aliasesTextJoinsWithCommaSpace() {
        assertEquals("a, b, c", WordEditAiActions.aliasesText(listOf("a", "b", "c")))
        assertEquals("only", WordEditAiActions.aliasesText(listOf("only")))
        assertEquals("", WordEditAiActions.aliasesText(emptyList()))
    }

    // ---- 成功文案与颜色判定 ----

    @Test
    fun successMessageMatchesIosWording() {
        assertEquals("法律词典释义已纠正", WordEditAiActions.successMessage(DefinitionModule.legal))
        assertEquals("AI 释义已生成", WordEditAiActions.successMessage(DefinitionModule.ai))
        assertEquals("自定义笔记已生成", WordEditAiActions.successMessage(DefinitionModule.notes))
    }

    @Test
    fun successColorDetectsBothSuffixes() {
        modules.forEach { module ->
            assertTrue(
                "${module.label} 的成功文案应判为成功",
                WordEditAiActions.isSuccessMessage(WordEditAiActions.successMessage(module)),
            )
        }
        assertFalse(WordEditAiActions.isSuccessMessage(WordEditAiActions.EMPTY_WORD_MESSAGE))
        assertFalse(WordEditAiActions.isSuccessMessage(WordEditAiActions.LEGAL_EMPTY_MESSAGE))
        assertFalse(WordEditAiActions.isSuccessMessage("HTTP 401"))
        assertFalse(WordEditAiActions.isSuccessMessage(WordEditAiActions.DICTIONARY_MISS_MESSAGE))
    }

    // ---- 本地词典填充 ----

    @Test
    fun dictionaryContentPutsPhoneticFirstThenNumberedDefinitions() {
        val entry = DictionaryEntry(
            phonetic = "/ˈkɒntrækt/",
            definitions = listOf("n. 合同", "v. 收缩"),
            aliases = emptyList(),
        )
        assertEquals(
            "/ˈkɒntrækt/\n1. n. 合同\n2. v. 收缩",
            WordEditAiActions.dictionaryContent(entry),
        )
    }

    @Test
    fun dictionaryContentOmitsMissingPhonetic() {
        val entry = DictionaryEntry(
            phonetic = null,
            definitions = listOf("n. 合同"),
            aliases = emptyList(),
        )
        assertEquals("1. n. 合同", WordEditAiActions.dictionaryContent(entry))
    }

    @Test
    fun dictionaryFillIsNullForMissAndForEmptyEntry() {
        assertNull(WordEditAiActions.dictionaryFill(null))
        assertNull(
            WordEditAiActions.dictionaryFill(
                DictionaryEntry(phonetic = null, definitions = emptyList(), aliases = emptyList()),
            ),
        )
    }

    @Test
    fun dictionaryFillReturnsContentWhenHit() {
        val entry = DictionaryEntry(
            phonetic = "/test/",
            definitions = listOf("测试"),
            aliases = emptyList(),
        )
        val fill = WordEditAiActions.dictionaryFill(entry)
        assertNotNull(fill)
        assertEquals("/test/\n1. 测试", fill)
    }

    @Test
    fun dictionaryMessageDistinguishesMissFromHit() {
        assertEquals(
            WordEditAiActions.DICTIONARY_FILLED_MESSAGE,
            WordEditAiActions.dictionaryMessage("1. 命中"),
        )
        assertEquals(
            WordEditAiActions.DICTIONARY_MISS_MESSAGE,
            WordEditAiActions.dictionaryMessage(null),
        )
    }

    // ---- 无 AI 路径时的兜底 ----

    @Test
    fun unknownErrorMessageIsNonBlank() {
        assertTrue(WordEditAiActions.UNKNOWN_ERROR_MESSAGE.isNotBlank())
    }
}

package com.notebar.app.ui.screens

import com.notebar.app.data.DefinitionModule
import com.notebar.app.data.Settings
import com.notebar.app.services.AIConfig
import com.notebar.app.services.AIDefinitionResult
import com.notebar.app.services.DictionaryEntry
import com.notebar.app.services.fetchDefinition
import com.notebar.app.services.legalCorrectionPrompt

/**
 * 编辑页 AI / 词典能力的注入点。
 *
 * 之所以把三件事拆成一个显式对象而不是在 Composable 里直接 new：
 * 单测是 JVM 单元测试，没有 Android Context、也不该打真网；
 * 接线层（`WordEditScreen`）只负责把状态传进这些函数，判定逻辑全部留在 [WordEditAiActions]。
 *
 * 默认实现走真实服务（[fetchDefinition] + 生产词典），
 * 与 iOS `WordDetailView` 调用 `AIDefinitionService` 的路径一致。
 */
class WordEditAiRuntime(
    val config: (DefinitionModule) -> AIConfig,
    val fetch: suspend (word: String, sentence: String, config: AIConfig) -> AIDefinitionResult,
    val dictionary: (String) -> DictionaryEntry?,
) {
    companion object {
        /** 生产接线：设置项 + 提示词资产 + 本地词典查询器。 */
        fun of(
            settings: Settings,
            assetPrompt: String,
            dictionary: (String) -> DictionaryEntry? = { null },
        ): WordEditAiRuntime = WordEditAiRuntime(
            config = { module -> WordEditAiActions.aiConfig(module, settings, assetPrompt) },
            fetch = { word, sentence, config -> fetchDefinition(word, sentence, config) },
            dictionary = dictionary,
        )
    }
}

/**
 * 编辑页「AI 生成 / AI 纠正 / 查词典」的纯判定层。
 *
 * 逐条对齐 iOS `WordDetailView.generate(_:)`（`NoteBarApp/Views/WordDetailView.swift:168-217`）：
 * - 按钮只出现在 ai / legal / notes 三个模块上（dictionary 没有）；
 * - 单词为空先拦；legal 正文为空再拦（提示「法律释义为空，请先填写再纠正」）；
 * - 提示词按模块取：ai 用资产提示词、legal 用 `legalCorrectionPrompt`、notes 用设置里的 `aiNotesPrompt`；
 * - 只有 legal 把 legal 正文当 `sentence` 送进提示词，其余模块送空串；
 * - 成功后只有「模块是 ai 且别名输入框为空」才回填别名；
 * - 成功文案：legal 固定「法律词典释义已纠正」，其余是「<模块名>已生成」。
 *
 * 这里全部是纯函数，不碰 Compose、不碰复习进度字段（红线）。
 */
object WordEditAiActions {

    /** iOS `Label(module == .legal ? "AI 纠正" : "AI 生成", systemImage: "sparkles")` */
    const val GENERATE_LABEL: String = "AI 生成"
    const val CORRECT_LABEL: String = "AI 纠正"

    /** iOS `messageByModule[module] = "请先输入单词"` */
    const val EMPTY_WORD_MESSAGE: String = "请先输入单词"

    /** iOS `messageByModule[module] = "法律释义为空，请先填写再纠正"` */
    const val LEGAL_EMPTY_MESSAGE: String = "法律释义为空，请先填写再纠正"

    /** iOS `messageByModule[module] = module == .legal ? "法律词典释义已纠正" : "\(module.rawValue)已生成"` 的 legal 分支 */
    const val LEGAL_DONE_MESSAGE: String = "法律词典释义已纠正"

    /** 成功文案后缀，用于判定消息颜色（iOS 用 `contains("已生成") || contains("已纠正")`） */
    const val GENERATED_SUFFIX: String = "已生成"
    const val CORRECTED_SUFFIX: String = "已纠正"

    /** 查词典：命中 / 未命中（桌面 `autoFillFromDictionary` 的 `new Notice('已从本地词库自动填充')` 与静默失败） */
    const val DICTIONARY_FILLED_MESSAGE: String = "已从本地词库填充"
    const val DICTIONARY_MISS_MESSAGE: String = "词典里没有这个词"

    /** 未预期异常的兜底文案（iOS 走 `error.localizedDescription`，正常不会到这里） */
    const val UNKNOWN_ERROR_MESSAGE: String = "生成失败，请稍后重试"

    /** 本地已落库、但画布这次没写成（未配同步目录 / 文件被外部移走）：提示待回推，不拦退出 */
    const val LOCAL_ONLY_MESSAGE: String =
        "已保存到本机，但词库文件这次没写成；下次同步会重新回推"

    /** 保存连本地都没写进去时的兜底文案 */
    const val SAVE_FAILED_MESSAGE: String = "保存失败，请稍后重试"

    /** iOS：`if module == .ai || module == .legal || module == .notes` 才显示生成按钮。 */
    fun showsGenerateButton(module: DefinitionModule): Boolean = when (module) {
        DefinitionModule.ai, DefinitionModule.legal, DefinitionModule.notes -> true
        DefinitionModule.dictionary -> false
    }

    /** 按钮文案：legal 是「AI 纠正」，其余是「AI 生成」。 */
    fun generateButtonLabel(module: DefinitionModule): String =
        if (module == DefinitionModule.legal) CORRECT_LABEL else GENERATE_LABEL

    /**
     * 生成前的拦截。返回 null 表示放行。
     *
     * 顺序与 iOS 一致：先判空单词（对所有模块），再判 legal 正文为空（仅 legal）。
     */
    fun blockedMessage(
        module: DefinitionModule,
        word: String,
        contents: Map<DefinitionModule, String>,
    ): String? {
        if (word.trim().isEmpty()) return EMPTY_WORD_MESSAGE
        if (module == DefinitionModule.legal &&
            contents[DefinitionModule.legal].orEmpty().trim().isEmpty()
        ) {
            return LEGAL_EMPTY_MESSAGE
        }
        return null
    }

    /**
     * 送进提示词的 `{{sentence}}`。
     *
     * iOS：`let sentence = module == .legal ? (contents[.legal] ?? "") : ""`。
     */
    fun sentenceFor(module: DefinitionModule, contents: Map<DefinitionModule, String>): String =
        if (module == DefinitionModule.legal) contents[DefinitionModule.legal].orEmpty() else ""

    /**
     * 按模块取提示词：
     * - ai → 资产 `ai-definition-prompt.txt`（iOS `loadPrompt()`）；
     * - legal → [legalCorrectionPrompt]；
     * - notes → 设置里的 `aiNotesPrompt`（iOS `settings.notesAIConfig`）；
     * - dictionary → 空串（不会用到）。
     */
    fun promptFor(module: DefinitionModule, settings: Settings, assetPrompt: String): String =
        when (module) {
            DefinitionModule.ai -> assetPrompt
            DefinitionModule.legal -> legalCorrectionPrompt
            DefinitionModule.notes -> settings.aiNotesPrompt
            DefinitionModule.dictionary -> ""
        }

    /**
     * 组装 [AIConfig]。
     *
     * iOS 三个分支都是同一份 `apiUrl / apiKey / model / extraParams`，只有 `prompt` 不同
     * （`aiConfig` / `notesAIConfig` / legal 的临时 Config）。
     */
    fun aiConfig(module: DefinitionModule, settings: Settings, assetPrompt: String): AIConfig =
        AIConfig(
            apiUrl = settings.aiApiUrl,
            apiKey = settings.aiApiKey,
            model = settings.aiModel,
            extraParams = settings.aiExtraParams,
            prompt = promptFor(module, settings, assetPrompt),
        )

    /**
     * 是否回填别名。
     *
     * iOS：`if module == .ai, aliases.trimmingCharacters(in: .whitespaces).isEmpty, !result.aliases.isEmpty`。
     * 注意只看 `.whitespaces`（不含换行），与 iOS 逐字一致。
     */
    fun shouldFillAliases(
        module: DefinitionModule,
        currentAliases: String,
        resultAliases: List<String>,
    ): Boolean = module == DefinitionModule.ai &&
        currentAliases.trim(' ', '\t').isEmpty() &&
        resultAliases.isNotEmpty()

    /** 别名回填文本：iOS `result.aliases.joined(separator: ", ")`。 */
    fun aliasesText(aliases: List<String>): String = aliases.joinToString(", ")

    /**
     * 成功文案。
     *
     * iOS：`module == .legal ? "法律词典释义已纠正" : "\(module.rawValue)已生成"`，
     * 而 `rawValue` 在 Android 侧就是 [DefinitionModule.label]（「AI 释义」/「自定义笔记」）。
     */
    fun successMessage(module: DefinitionModule): String =
        if (module == DefinitionModule.legal) LEGAL_DONE_MESSAGE else module.label + GENERATED_SUFFIX

    /** 消息是成功（绿）还是失败（红）：iOS 用 `contains("已生成") || contains("已纠正")`。 */
    fun isSuccessMessage(message: String): Boolean =
        message.contains(GENERATED_SUFFIX) || message.contains(CORRECTED_SUFFIX)

    /**
     * 词典命中后写入「词典释义」模块的正文。
     *
     * 格式对齐桌面 `autoFillFromDictionary` → `formatDefinitions`：释义按 `1. ` `2. ` 编号、换行连接；
     * 音标（桌面 `DictionaryLookupResult.phonetic`，对应 JSON 的 `p`）存在时放在首行。
     * 桌面不写音标进正文（它只用于列表展示），这里按任务要求把 phonetic 一并写入。
     */
    fun dictionaryContent(entry: DictionaryEntry): String {
        val lines = mutableListOf<String>()
        val phonetic = entry.phonetic?.trim().orEmpty()
        if (phonetic.isNotEmpty()) lines += phonetic
        entry.definitions.forEachIndexed { index, definition ->
            lines += "${index + 1}. ${definition.trim()}"
        }
        return lines.joinToString("\n")
    }

    /**
     * 词典命中时要写入的正文；未命中或命中但无可用正文时返回 null。
     *
     * 桌面口径：`definitions.length === 0 && aliases.length === 0` 视为未命中。
     */
    fun dictionaryFill(entry: DictionaryEntry?): String? {
        if (entry == null) return null
        val content = dictionaryContent(entry)
        return content.ifBlank { null }
    }

    /** 查词典的结果文案。 */
    fun dictionaryMessage(fill: String?): String =
        if (fill == null) DICTIONARY_MISS_MESSAGE else DICTIONARY_FILLED_MESSAGE
}

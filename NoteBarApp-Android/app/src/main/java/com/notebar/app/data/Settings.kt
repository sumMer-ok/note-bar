package com.notebar.app.data

import com.notebar.app.sync.BaiduPanConfig
import com.notebar.app.sync.BaiduPanSettings
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 应用设置。逐字段对应 iOS `AppState.Settings`（含默认值与解码回退规则）。
 *
 * 序列化口径同样对齐 iOS：字段名 camelCase、缺省值与原版一致，
 * 并且保留旧版 `forceDarkMode` 布尔开关 → `appearance` 的迁移路径。
 *
 * [baiduPan] 是 Phase 4b 新增的百度网盘通道配置，对应桌面端的 `settings.baiduPan`
 * （同一份语义、同一个 JSON 键名，见 [BaiduPanConfig.SETTINGS_KEY]）。
 */
@Serializable
data class Settings(
    val autoPronounce: Boolean = true,
    val appearance: Appearance = Appearance.system,
    val dailyNewWordLimit: Int = DEFAULT_NEW_WORD_LIMIT,
    val dailyReviewLimit: Int = DEFAULT_REVIEW_LIMIT,
    val dictationPerSession: Int = DEFAULT_DICTATION_PER_SESSION,
    val dictationAutoAdvance: Boolean = true,
    val ttsTemplate: String = DEFAULT_TTS_TEMPLATE,
    val definitionOrder: List<DefinitionModule> = DefinitionModule.allCases,
    val aiApiUrl: String = DEFAULT_AI_API_URL,
    val aiApiKey: String = "",
    val aiModel: String = "gpt-4o-mini",
    val aiExtraParams: String = "{}",
    val aiNotesPrompt: String = DEFAULT_AI_NOTES_PROMPT,
    val defaultBooks: List<String> = emptyList(),
    val pinnedBooks: List<String> = emptyList(),
    val baiduPan: BaiduPanSettings = BaiduPanSettings(),
) {
    enum class Appearance(val storageValue: String) {
        system("system"),
        light("light"),
        dark("dark");

        /** 对应 iOS `Appearance.title` */
        val title: String
            get() = when (this) {
                system -> "跟随系统"
                light -> "日间"
                dark -> "暗夜"
            }

        companion object {
            fun fromStorage(raw: String?): Appearance =
                entries.firstOrNull { it.storageValue == raw } ?: system
        }
    }

    companion object {
        /** 红线：新词上限固定 20（与桌面插件语义一致） */
        const val DEFAULT_NEW_WORD_LIMIT = 20
        const val DEFAULT_REVIEW_LIMIT = 50
        const val DEFAULT_DICTATION_PER_SESSION = 20
        const val DEFAULT_TTS_TEMPLATE =
            "https://dict.youdao.com/dictvoice?audio={{word}}&type=2"
        const val DEFAULT_AI_API_URL = "https://api.openai.com/v1"

        /** 对应 iOS `aiNotesPrompt` 的默认值（原文照抄） */
        const val DEFAULT_AI_NOTES_PROMPT =
            "你是一个英语学习助手。请针对单词 \"{{word}}\"（上下文句子，可能为空：{{sentence}}）写一段简短的自定义笔记，帮助记忆，包含：1）一个贴近真实语境的例句；2）词根词缀拆解（如有）；3）一个联想记忆技巧。只输出纯文本，不要 markdown 标题、不要 JSON。"
    }
}

/** 释义模块；对应 iOS `DefinitionModule`（rawValue 就是界面文案与存储键） */
@Serializable
enum class DefinitionModule(val label: String) {
    @SerialName("词典释义")
    dictionary("词典释义"),

    @SerialName("法律词典释义")
    legal("法律词典释义"),

    @SerialName("AI 释义")
    ai("AI 释义"),

    @SerialName("自定义笔记")
    notes("自定义笔记");

    companion object {
        /** 对应 iOS `DefinitionModule.allCases` 的顺序 */
        val allCases: List<DefinitionModule> = listOf(dictionary, legal, ai, notes)

        fun fromLabel(label: String?): DefinitionModule? =
            allCases.firstOrNull { it.label == label }
    }
}

/**
 * 设置的持久化编解码（纯函数，可 JVM 单测）。
 *
 * 与 iOS `Settings.init(from:)` 的差异与对齐：
 * - iOS 用 `decodeIfPresent ?? 默认值` 逐字段兜底；这里把"缺字段 → 默认值"
 *   集中在 [decode] 里显式实现，避免 DataStore 里存了半截设置时整份设置被重置；
 * - iOS 保留旧版 `forceDarkMode` 布尔开关的迁移（`appearance` 缺失时读它）。
 *   这里照搬：老用户升级后仍是暗夜，而不是被悄悄改回跟随系统。
 */
object SettingsCodec {

    private val json = Json {
        encodeDefaults = true
        explicitNulls = false
        ignoreUnknownKeys = true
    }

    private val keys = listOf(
        "autoPronounce", "appearance", "dailyNewWordLimit",
        "dailyReviewLimit", "dictationPerSession", "dictationAutoAdvance", "ttsTemplate",
        "definitionOrder", "aiApiUrl", "aiApiKey", "aiModel", "aiExtraParams",
        "aiNotesPrompt", "defaultBooks", "pinnedBooks",
        // Phase 4b：百度网盘通道配置（键名与桌面端 data.json 一致）
        BaiduPanConfig.SETTINGS_KEY,
    )

    /**
     * 旧版键名（只读，不写回）。`forceDarkMode` 是 iOS 早期版本的「暗夜模式」布尔开关，
     * 迁移到 `appearance` 后不再写出，避免两处真相。
     */
    private val legacyKeys = listOf("forceDarkMode")

    fun encode(settings: Settings): String = json.encodeToString(Settings.serializer(), settings)

    /**
     * 解码设置。任何字段缺失都回落到 iOS 的默认值；整份 JSON 不可解析时返回默认 [Settings]。
     *
     * 先走强类型解码（快路径），失败或需要迁移时再走 [decodeLenient] 逐字段兜底。
     * **注意**：`forceDarkMode` 迁移不能只挂在失败分支上——旧数据里
     * `{"forceDarkMode":true}` 对强类型解码是「合法的、只是没写 appearance」，
     * 走快路径会得到 system，把老用户的暗夜设置悄悄改掉。因此迁移条件单独判断。
     */
    fun decode(raw: String?): Settings {
        if (raw.isNullOrBlank()) return Settings()
        val element = runCatching { json.parseToJsonElement(raw) }.getOrNull() ?: return Settings()
        val obj = element as? kotlinx.serialization.json.JsonObject ?: return Settings()

        // 旧版只写了 forceDarkMode、没写 appearance → 必须迁移，不能走快路径
        val needsLegacyMigration = obj.containsKey("forceDarkMode") && !obj.containsKey("appearance")
        if (needsLegacyMigration) return decodeLenient(element)

        return runCatching { json.decodeFromJsonElement(Settings.serializer(), element) }
            .getOrElse {
                // 例如旧版本写入了未知的 appearance 取值：逐字段兜底重解一次
                decodeLenient(element)
            }
    }

    /**
     * 逐字段兜底：对应 iOS 的 `decodeIfPresent(...) ?? 默认值`。
     * 旧版的 `forceDarkMode` 在这里被迁移成 `appearance`。
     */
    private fun decodeLenient(element: kotlinx.serialization.json.JsonElement): Settings {
        val obj = element as? kotlinx.serialization.json.JsonObject ?: return Settings()
        val defaults = Settings()
        fun str(key: String): String? =
            (obj[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content

        fun bool(key: String): Boolean? =
            (obj[key] as? kotlinx.serialization.json.JsonPrimitive)
                ?.takeIf { !it.isString }?.content?.toBooleanStrictOrNull()

        fun int(key: String): Int? =
            (obj[key] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull()

        val appearanceRaw = str("appearance")
        val appearance = if (appearanceRaw != null) {
            Settings.Appearance.fromStorage(appearanceRaw)
        } else {
            // 兼容旧版本只存了「暗夜模式」布尔开关
            if (bool("forceDarkMode") == true) Settings.Appearance.dark else Settings.Appearance.system
        }

        return Settings(
            autoPronounce = bool("autoPronounce") ?: defaults.autoPronounce,
            appearance = appearance,
            dailyNewWordLimit = int("dailyNewWordLimit") ?: defaults.dailyNewWordLimit,
            dailyReviewLimit = int("dailyReviewLimit") ?: defaults.dailyReviewLimit,
            dictationPerSession = int("dictationPerSession") ?: defaults.dictationPerSession,
            dictationAutoAdvance = bool("dictationAutoAdvance") ?: defaults.dictationAutoAdvance,
            ttsTemplate = str("ttsTemplate") ?: defaults.ttsTemplate,
            definitionOrder = decodeOrder(obj) ?: defaults.definitionOrder,
            aiApiUrl = str("aiApiUrl") ?: defaults.aiApiUrl,
            aiApiKey = str("aiApiKey") ?: defaults.aiApiKey,
            aiModel = str("aiModel") ?: defaults.aiModel,
            aiExtraParams = str("aiExtraParams") ?: defaults.aiExtraParams,
            aiNotesPrompt = str("aiNotesPrompt") ?: defaults.aiNotesPrompt,
            defaultBooks = decodeStringList(obj, "defaultBooks") ?: defaults.defaultBooks,
            pinnedBooks = decodeStringList(obj, "pinnedBooks") ?: defaults.pinnedBooks,
            // 网盘配置：缺失/类型不对时回落默认值，未知字段由 BaiduPanConfig 原样保留
            baiduPan = BaiduPanConfig.normalize(obj[BaiduPanConfig.SETTINGS_KEY]),
        )
    }

    private fun decodeStringList(
        obj: kotlinx.serialization.json.JsonObject,
        key: String,
    ): List<String>? {
        val array = obj[key] as? kotlinx.serialization.json.JsonArray ?: return null
        return array.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
    }

    private fun decodeOrder(obj: kotlinx.serialization.json.JsonObject): List<DefinitionModule>? {
        val labels = decodeStringList(obj, "definitionOrder") ?: return null
        val modules = labels.mapNotNull { DefinitionModule.fromLabel(it) }
        return modules.ifEmpty { null }
    }

    /** 供单测断言"设置键集合"的稳定快照 */
    fun knownKeys(): List<String> = keys

    /** 供单测断言"旧版键名"用的稳定快照 */
    fun legacyKeyNames(): List<String> = legacyKeys
}

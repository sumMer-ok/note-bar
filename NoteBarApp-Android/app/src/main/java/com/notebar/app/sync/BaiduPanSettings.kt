package com.notebar.app.sync

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 百度网盘同步配置。逐字段对应桌面端 `BaiduPanSettings`（`src/hiwords/utils/types.ts`）
 * 与 `defaultBaiduPanSettings()`（`src/sync/baidu-pan-config.ts`）。
 *
 * ## 「只增不改」与未知字段保留
 * 桌面端 `ensureBaiduPanSettings` 明确承诺：旧配置缺字段时补齐，**已有字段与未知字段一律不动**。
 * Kotlin 的 `@Serializable` 默认会把不认识的键吃掉（`ignoreUnknownKeys` 只是忽略，重新编码即丢失），
 * 那等于 Android 单方面破坏「跨端共享同一份配置语义」这一既有数据模型。
 * 因此这里用 [BaiduPanSettingsSerializer] 手写编解码：已知字段强类型读写，其余键原样存回 [extra]，
 * 序列化时再摊平回同一个 JSON 对象（未知键绝不覆盖已知字段）。
 *
 * 与桌面端 `dir` 的默认值一致：`NoteBar`（实际路径 `/apps/NoteBar/`）。
 */
@Serializable(with = BaiduPanSettingsSerializer::class)
data class BaiduPanSettings(
    /** 是否启用百度网盘同步（设置页开关）；关闭时用本地目录后端 */
    val enabled: Boolean = false,
    /** 应用 AppKey（凭证，绝不写日志） */
    val appKey: String = "",
    /** 应用 SecretKey（凭证，绝不写日志） */
    val secretKey: String = "",
    /** OAuth access_token（凭证，绝不写日志） */
    val accessToken: String = "",
    /** OAuth refresh_token（一次性，刷新后必须保存新的） */
    val refreshToken: String = "",
    /** access_token 过期时间戳（毫秒）；0 表示未知/未授权 */
    val expiresAt: Long = 0L,
    /** 网盘内应用沙箱下的目录名，默认 NoteBar（实际路径 `/apps/<dir>/Words/`） */
    val dir: String = BaiduPanConfig.DEFAULT_DIR,
    /** 本类不认识的键（桌面端日后新增的字段、其他端的扩展键）。序列化时原样写回。 */
    val extra: Map<String, JsonElement> = emptyMap(),
) {
    /** 沙箱根路径：`/apps/<dir>` */
    val sandboxRoot: String get() = BaiduPanConfig.sandboxRoot(dir)

    /** 词库与边车目录：`/apps/<dir>/Words` */
    val wordsDir: String get() = BaiduPanConfig.wordsDir(dir)

    /** 是否具备完整的 OAuth 凭证（仅本地判断，不发请求） */
    val isConfigured: Boolean get() = appKey.isNotBlank() && secretKey.isNotBlank()
}

/**
 * 手写编解码：已知字段强类型、未知字段保留（见 [BaiduPanSettings] 的类注释）。
 *
 * 反序列化对每个字段都按「类型不对视为缺失 → 回落到默认值」处理，
 * 与桌面端 `normalizeBaiduPanSettings` 的 `asString` / `asFiniteTimestamp` 同口径。
 */
internal object BaiduPanSettingsSerializer : KSerializer<BaiduPanSettings> {

    override val descriptor: SerialDescriptor =
        buildClassSerialDescriptor("com.notebar.app.sync.BaiduPanSettings")

    override fun serialize(encoder: Encoder, value: BaiduPanSettings) {
        val jsonEncoder = encoder as? JsonEncoder
            ?: error("BaiduPanSettings 只能编码为 JSON")
        jsonEncoder.encodeSerializableValue(
            JsonObject.serializer(),
            BaiduPanConfig.toJsonObject(value),
        )
    }

    override fun deserialize(decoder: Decoder): BaiduPanSettings {
        val jsonDecoder = decoder as? JsonDecoder
            ?: error("BaiduPanSettings 只能从 JSON 解码")
        return BaiduPanConfig.normalize(jsonDecoder.decodeJsonElement() as? JsonObject)
    }
}

/**
 * 配置默认值、沙箱路径推导与「只增不改」补齐（纯函数，可 JVM 单测）。
 *
 * 对应桌面端 `src/sync/baidu-pan-config.ts`：本对象是它在 Android 上的等价物。
 */
object BaiduPanConfig {

    /** 网盘沙箱内默认目录名：实际路径为 `/apps/<dir>/Words/` */
    const val DEFAULT_DIR = "NoteBar"

    /** 网盘内词库与边车的子目录（相对应用沙箱根） */
    const val WORDS_SUBDIR = "Words"

    /** access_token 有效期（秒）；百度网盘文档为 30 天 */
    const val TOKEN_TTL_SECONDS = 30L * 24 * 60 * 60

    /** 续期提前量：剩余不足 5 分钟即视为过期，避免边界上打出 401 */
    const val TOKEN_EXPIRY_SKEW_MS = 5L * 60 * 1000

    /** 承载本配置的 JSON 键名（桌面端 data.json 与 Android 设置 JSON 同用该键） */
    const val SETTINGS_KEY = "baiduPan"

    /** 已知字段名（顺序即写盘顺序，与桌面端 `defaultBaiduPanSettings` 一致） */
    internal val KNOWN_KEYS = listOf(
        "enabled", "appKey", "secretKey", "accessToken", "refreshToken", "expiresAt", "dir",
    )

    private val json = Json { ignoreUnknownKeys = true }

    /** 默认配置（每次返回新对象，避免调用方互相污染） */
    fun defaults(): BaiduPanSettings = BaiduPanSettings()

    /**
     * 应用沙箱根路径：`/apps/<dir>`。
     *
     * 百度网盘开放平台的未过审应用只能读写自己应用目录下的路径，
     * 越界会被服务端拒绝（errno 20020 / -7），客户端也会在本地先做一次校验。
     */
    fun sandboxRoot(dir: String?): String {
        val cleaned = (dir ?: "").trim().trim('/')
        return "/apps/${if (cleaned.isEmpty()) DEFAULT_DIR else cleaned}"
    }

    /** 网盘内词库与边车所在目录：`/apps/<dir>/Words` */
    fun wordsDir(dir: String?): String = "${sandboxRoot(dir)}/$WORDS_SUBDIR"

    /**
     * 从任意 JSON 值规整出完整配置；未知键进 [BaiduPanSettings.extra]，**不丢弃**。
     * 与桌面端 `normalizeBaiduPanSettings` 同语义：类型不对按缺失处理，`dir` 为空白则用默认值。
     * 非 JSON 对象（含 null）一律回落到默认配置。
     */
    fun normalize(raw: JsonElement?): BaiduPanSettings {
        val obj = raw as? JsonObject ?: return defaults()
        val extra = LinkedHashMap<String, JsonElement>()
        for ((key, value) in obj) {
            if (key !in KNOWN_KEYS) extra[key] = value
        }
        return BaiduPanSettings(
            enabled = strictBooleanOf(obj["enabled"]) ?: false,
            appKey = stringOf(obj["appKey"]) ?: "",
            secretKey = stringOf(obj["secretKey"]) ?: "",
            accessToken = stringOf(obj["accessToken"]) ?: "",
            refreshToken = stringOf(obj["refreshToken"]) ?: "",
            expiresAt = timestampOf(obj["expiresAt"]) ?: 0L,
            dir = stringOf(obj["dir"])?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_DIR,
            extra = extra,
        )
    }

    /**
     * 摊平成待写盘的 JSON 对象：已知字段在前，未知字段在后；未知键**绝不覆盖**已知字段
     * （否则配置里历史残留的 `"dir"` 之类会把真值劫持掉）。
     */
    fun toJsonObject(value: BaiduPanSettings): JsonObject {
        val out = LinkedHashMap<String, JsonElement>()
        out["enabled"] = JsonPrimitive(value.enabled)
        out["appKey"] = JsonPrimitive(value.appKey)
        out["secretKey"] = JsonPrimitive(value.secretKey)
        out["accessToken"] = JsonPrimitive(value.accessToken)
        out["refreshToken"] = JsonPrimitive(value.refreshToken)
        out["expiresAt"] = JsonPrimitive(value.expiresAt)
        out["dir"] = JsonPrimitive(value.dir)
        for ((key, element) in value.extra) {
            if (key !in out) out[key] = element
        }
        return JsonObject(out)
    }

    fun encodeToString(value: BaiduPanSettings): String =
        json.encodeToString(BaiduPanSettings.serializer(), value)

    fun decodeFromString(raw: String?): BaiduPanSettings? {
        if (raw.isNullOrBlank()) return null
        return runCatching { json.decodeFromString(BaiduPanSettings.serializer(), raw) }.getOrNull()
    }

    /**
     * 就地把整份设置 JSON 里的 `baiduPan` 补齐为完整合法配置，并报告是否需要写回。
     * 对应桌面端 `ensureBaiduPanSettings(settings, saved)` 的 `{ changed, value }`。
     *
     * 三条约束（与桌面端逐条对齐）：
     * 1. **只增不改**：已有合法值原样保留，未知字段（含未知顶层键）都不丢弃；
     * 2. **只填空缺/非法值**：缺失字段、类型不对的字段、空白 `dir`；
     * 3. **只在发生变化时写回**：磁盘形态已完整时返回 `changed = false`，
     *    避免每次启动都刷盘；旧配置完全没有 `baiduPan` 时补写一次（对应 `onDiskMissing`）。
     *
     * 原文为空或不是合法 JSON 时**原样返回且 changed = false**：调用方绝不能拿一份
     * 空/损坏的设置去覆盖磁盘（那会丢掉用户全部设置）。
     */
    fun ensureInSettingsJson(raw: String?): EnsureResult {
        val text = raw
        if (text.isNullOrBlank()) return EnsureResult(text ?: "", false)
        val root = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
            ?: return EnsureResult(text, false)

        val current = root[SETTINGS_KEY]
        val patched = toJsonObject(normalize(current))
        if (patched == current) return EnsureResult(text, false)

        val out = LinkedHashMap(root)
        out[SETTINGS_KEY] = patched
        return EnsureResult(json.encodeToString(JsonObject.serializer(), JsonObject(out)), true)
    }

    /** [ensureInSettingsJson] 的结果：补齐后的整份设置 JSON + 是否需要写回 */
    data class EnsureResult(val json: String, val changed: Boolean)

    // ------------------------------------------------------------- 解析小工具

    /** 只有真正的 JSON 布尔才算数（对应桌面端 `source.enabled === true` 的严格性） */
    private fun strictBooleanOf(element: JsonElement?): Boolean? {
        val primitive = element as? JsonPrimitive ?: return null
        if (primitive.isString) return null
        return primitive.content.toBooleanStrictOrNull()
    }

    /** 只有 JSON 字符串才算数（对应桌面端 `asString`） */
    private fun stringOf(element: JsonElement?): String? {
        val primitive = element as? JsonPrimitive ?: return null
        return if (primitive.isString) primitive.content else null
    }

    /** 非负有限时间戳（对应桌面端 `asFiniteTimestamp`） */
    private fun timestampOf(element: JsonElement?): Long? {
        val primitive = element as? JsonPrimitive ?: return null
        if (primitive.isString) return null
        val value = primitive.content.toLongOrNull()
            ?: primitive.content.toDoubleOrNull()?.takeIf { it.isFinite() }?.toLong()
            ?: return null
        return if (value >= 0) value else null
    }
}

package com.notebar.app.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 百度网盘配置的默认值与「只增不改」迁移。
 *
 * 与桌面端 `src/sync/baidu-pan-config.ts` + `tests/sync/baidu-pan-config.test.ts` 逐条对照。
 * 核心承诺：旧配置缺字段时补齐；**已有字段与未知字段一律不动**——
 * 那是对桌面端 `ensureBaiduPanSettings` 承诺的跨端兑现。
 */
class BaiduPanConfigTest {

    private val json = Json { ignoreUnknownKeys = true }

    // ---------------------------------------------------------------- 默认值

    @Test
    fun defaultsMatchDesktopConfig() {
        val defaults = BaiduPanConfig.defaults()
        assertFalse(defaults.enabled)
        assertEquals("", defaults.appKey)
        assertEquals("", defaults.secretKey)
        assertEquals("", defaults.accessToken)
        assertEquals("", defaults.refreshToken)
        assertEquals(0L, defaults.expiresAt)
        assertEquals("NoteBar", defaults.dir)
        assertEquals(emptyMap<String, kotlinx.serialization.json.JsonElement>(), defaults.extra)
    }

    @Test
    fun defaultDirIsNoteBarLikeDesktop() {
        assertEquals("NoteBar", BaiduPanConfig.DEFAULT_DIR)
        assertEquals("Words", BaiduPanConfig.WORDS_SUBDIR)
        assertEquals(30L * 24 * 60 * 60, BaiduPanConfig.TOKEN_TTL_SECONDS)
        assertEquals(5L * 60 * 1000, BaiduPanConfig.TOKEN_EXPIRY_SKEW_MS)
    }

    @Test
    fun sandboxRootAndWordsDirFollowDirSetting() {
        assertEquals("/apps/NoteBar", BaiduPanConfig.sandboxRoot("NoteBar"))
        assertEquals("/apps/NoteBar/Words", BaiduPanConfig.wordsDir("NoteBar"))
        // 前后斜杠与空白都被规整掉
        assertEquals("/apps/MyApp", BaiduPanConfig.sandboxRoot("/MyApp/"))
        assertEquals("/apps/MyApp", BaiduPanConfig.sandboxRoot("  MyApp  "))
        // 空白目录回落到默认值（对应桌面端 normalizeBaiduPanSettings 的 dir 兜底）
        assertEquals("/apps/NoteBar", BaiduPanConfig.sandboxRoot("   "))
        assertEquals("/apps/NoteBar", BaiduPanConfig.sandboxRoot(null))
    }

    @Test
    fun sandboxRootAccessorsOnSettingsMatchConfig() {
        val pan = BaiduPanSettings(dir = "OtherApp")
        assertEquals("/apps/OtherApp", pan.sandboxRoot)
        assertEquals("/apps/OtherApp/Words", pan.wordsDir)
    }

    // ------------------------------------------------------------ 规范化

    @Test
    fun normalizeFillsMissingFieldsWithDefaults() {
        val pan = BaiduPanConfig.normalize(JsonObject(emptyMap()))
        assertEquals(BaiduPanConfig.defaults(), pan)
        // null / 非对象一律回落默认配置（对应桌面端 normalizeBaiduPanSettings 的 `source = {}`）
        assertEquals(BaiduPanConfig.defaults(), BaiduPanConfig.normalize(null))
        assertEquals(
            BaiduPanConfig.defaults(),
            BaiduPanConfig.normalize(kotlinx.serialization.json.JsonArray(emptyList())),
        )
    }

    @Test
    fun normalizeTreatsWrongTypesAsMissing() {
        // 与桌面端 `asString` / `asFiniteTimestamp` 同口径：类型不对 = 缺失
        val raw = JsonObject(
            mapOf(
                "enabled" to JsonPrimitive("true"), // 字符串不是布尔
                "appKey" to JsonPrimitive(123),
                "expiresAt" to JsonPrimitive("not-a-number"),
                "dir" to JsonPrimitive(42),
            ),
        )
        val pan = BaiduPanConfig.normalize(raw)
        assertFalse(pan.enabled)
        assertEquals("", pan.appKey)
        assertEquals(0L, pan.expiresAt)
        assertEquals("NoteBar", pan.dir)
    }

    @Test
    fun normalizeKeepsUnknownFields() {
        val raw = json.parseToJsonElement(
            """{"enabled":true,"appKey":"k","futureField":"keep-me","nested":{"a":1}}""",
        ).jsonObject
        val pan = BaiduPanConfig.normalize(raw)
        assertTrue(pan.enabled)
        assertEquals("k", pan.appKey)
        assertEquals(setOf("futureField", "nested"), pan.extra.keys)
        // 未知字段必须原样往返（不是「忽略」，而是「保留」）
        val roundTrip = BaiduPanConfig.encodeToString(pan)
        assertTrue("未知字段被吃掉：$roundTrip", roundTrip.contains("keep-me"))
        assertTrue(roundTrip.contains("\"a\":1"))
    }

    @Test
    fun roundTripPreservesAllKnownFields() {
        val original = BaiduPanSettings(
            enabled = true,
            appKey = "app-key",
            secretKey = "secret-key",
            accessToken = "access-token",
            refreshToken = "refresh-token",
            expiresAt = 1_763_000_000_000L,
            dir = "MyApp",
        )
        val decoded = BaiduPanConfig.decodeFromString(BaiduPanConfig.encodeToString(original))
        assertEquals(original, decoded)
    }

    @Test
    fun unknownKeyNeverOverridesKnownField() {
        // 恶意/历史残留的 extra 里带 dir，不得劫持真值
        val pan = BaiduPanSettings(dir = "Good", extra = mapOf("dir" to JsonPrimitive("Bad")))
        val flat = BaiduPanConfig.toJsonObject(pan)
        assertEquals("Good", (flat["dir"] as JsonPrimitive).content)
        assertEquals("/apps/Good", BaiduPanConfig.normalize(flat).sandboxRoot)
    }

    // ------------------------------------------------- 「只增不改」补齐

    @Test
    fun ensureAddsBaiduPanWhenMissingEntirely() {
        val saved = """{"dailyNewWordLimit":25,"aiModel":"gpt-4o"}"""
        val result = BaiduPanConfig.ensureInSettingsJson(saved)
        assertTrue("旧配置没有 baiduPan 时必须补写一次", result.changed)

        val root = json.parseToJsonElement(result.json).jsonObject
        // 既有字段一字不改
        assertEquals(25, (root["dailyNewWordLimit"] as JsonPrimitive).content.toInt())
        assertEquals("gpt-4o", (root["aiModel"] as JsonPrimitive).content)
        // 新增一份完整的默认配置
        val pan = BaiduPanConfig.normalize(root["baiduPan"])
        assertEquals(BaiduPanConfig.defaults(), pan)
    }

    @Test
    fun ensureIsNoOpWhenAlreadyComplete() {
        val complete = BaiduPanConfig.encodeToString(BaiduPanSettings())
        val saved = """{"dailyNewWordLimit":20,"baiduPan":$complete}"""
        val result = BaiduPanConfig.ensureInSettingsJson(saved)
        assertFalse("形态已完整时不得刷盘", result.changed)
        assertEquals(saved, result.json)
    }

    @Test
    fun ensureFillsOnlyMissingFieldsAndKeepsExistingValues() {
        val saved = """{"baiduPan":{"enabled":true,"appKey":"kept-key","dir":"Custom","futureFlag":7}}"""
        val result = BaiduPanConfig.ensureInSettingsJson(saved)
        assertTrue(result.changed)

        val pan = BaiduPanConfig.normalize(json.parseToJsonElement(result.json).jsonObject["baiduPan"])
        // 已有字段原样保留
        assertTrue(pan.enabled)
        assertEquals("kept-key", pan.appKey)
        assertEquals("Custom", pan.dir)
        // 缺失字段被补齐
        assertEquals("", pan.secretKey)
        assertEquals(0L, pan.expiresAt)
        // 未知字段保留
        assertEquals(setOf("futureFlag"), pan.extra.keys)
        assertTrue(result.json.contains("futureFlag"))
    }

    @Test
    fun ensureRepairsIllegalValues() {
        val saved = """{"baiduPan":{"enabled":"yes","expiresAt":-5,"dir":"   "}}"""
        val result = BaiduPanConfig.ensureInSettingsJson(saved)
        assertTrue(result.changed)
        val pan = BaiduPanConfig.normalize(json.parseToJsonElement(result.json).jsonObject["baiduPan"])
        assertFalse(pan.enabled)
        assertEquals(0L, pan.expiresAt)
        assertEquals("NoteBar", pan.dir)
    }

    @Test
    fun ensureNeverDestroysBrokenOrEmptySettings() {
        // 空/损坏的原文绝不能返回一份「补齐后的空设置」——那会把用户全部设置覆盖掉
        for (raw in listOf(null, "", "   ", "{not json", "[1,2,3]")) {
            val result = BaiduPanConfig.ensureInSettingsJson(raw)
            assertFalse("不应声称需要写回：$raw", result.changed)
            assertEquals(raw ?: "", result.json)
        }
    }

    @Test
    fun ensureKeepsUnknownTopLevelKeys() {
        val saved = """{"somethingNew":{"x":1},"baiduPan":{}}"""
        val result = BaiduPanConfig.ensureInSettingsJson(saved)
        assertTrue(result.changed)
        val root = json.parseToJsonElement(result.json).jsonObject
        assertNotNull(root["somethingNew"])
    }

    // ------------------------------------------------------------ 凭证判定

    @Test
    fun isConfiguredRequiresBothKeys() {
        assertFalse(BaiduPanSettings().isConfigured)
        assertFalse(BaiduPanSettings(appKey = "k").isConfigured)
        assertFalse(BaiduPanSettings(secretKey = "s").isConfigured)
        assertFalse(BaiduPanSettings(appKey = "  ", secretKey = "s").isConfigured)
        assertTrue(BaiduPanSettings(appKey = "k", secretKey = "s").isConfigured)
    }

    @Test
    fun settingsKeyMatchesDesktopDataJson() {
        // 桌面端 data.json 用的就是 "baiduPan"，Android 必须同键才能共享语义
        assertEquals("baiduPan", BaiduPanConfig.SETTINGS_KEY)
    }

    @Test
    fun encodedShapeUsesSameFieldNamesAsDesktop() {
        val encoded = json.parseToJsonElement(
            BaiduPanConfig.encodeToString(BaiduPanSettings(enabled = true)),
        ).jsonObject
        assertEquals(
            setOf("enabled", "appKey", "secretKey", "accessToken", "refreshToken", "expiresAt", "dir"),
            encoded.keys,
        )
    }
}

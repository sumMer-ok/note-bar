package com.notebar.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 设置的默认值与迁移。
 *
 * 红线：默认值必须与 iOS `AppState.Settings` 一致（尤其 `dailyNewWordLimit = 20`）。
 * 迁移：旧版只存了 `forceDarkMode` 布尔开关时，必须迁移成 `appearance`，不能悄悄改回「跟随系统」。
 */
class SettingsCodecTest {

    @Test
    fun defaultsMatchIosSettings() {
        val s = Settings()
        assertEquals("跟随系统", s.appearance.title)
        assertEquals(20, s.dailyNewWordLimit)
        assertEquals(50, s.dailyReviewLimit)
        assertEquals(20, s.dictationPerSession)
        assertEquals("https://dict.youdao.com/dictvoice?audio={{word}}&type=2", s.ttsTemplate)
        assertEquals(DefinitionModule.allCases, s.definitionOrder)
        assertEquals("https://api.openai.com/v1", s.aiApiUrl)
        assertEquals("gpt-4o-mini", s.aiModel)
        assertEquals("{}", s.aiExtraParams)
        assertTrue(s.autoPronounce)
        assertTrue(s.dictationAutoAdvance)
        assertEquals(emptyList<String>(), s.defaultBooks)
        assertEquals(emptyList<String>(), s.pinnedBooks)
    }

    @Test
    fun newWordLimitIsTwenty() {
        // 红线：新词上限 20，与桌面插件语义一致
        assertEquals(20, Settings.DEFAULT_NEW_WORD_LIMIT)
        assertEquals(20, Settings().dailyNewWordLimit)
    }

    @Test
    fun roundTripKeepsAllFields() {
        val original = Settings(
            autoPronounce = false,
            appearance = Settings.Appearance.dark,
            dailyNewWordLimit = 33,
            dailyReviewLimit = 77,
            dictationPerSession = 9,
            dictationAutoAdvance = false,
            ttsTemplate = "https://example.com/{{word}}/{{type}}/{{accent}}",
            definitionOrder = listOf(DefinitionModule.ai, DefinitionModule.dictionary),
            aiApiUrl = "https://api.example.com/v1",
            aiApiKey = "sk-secret",
            aiModel = "gpt-4o",
            aiExtraParams = "{\"temperature\":0.1}",
            aiNotesPrompt = "自定义提示词",
            defaultBooks = listOf("Words/a.canvas"),
            pinnedBooks = listOf("Words/b.canvas"),
        )
        val decoded = SettingsCodec.decode(SettingsCodec.encode(original))
        assertEquals(original, decoded)
    }

    @Test
    fun encodingUsesCamelCaseKeysLikeIos() {
        val raw = SettingsCodec.encode(Settings())
        SettingsCodec.knownKeys().forEach { key ->
            assertTrue("缺少设置键 $key", raw.contains("\"$key\""))
        }
    }

    @Test
    fun legacyForceDarkModeIsNeverWrittenBack() {
        // 迁移后只保留 appearance 一处真相，避免下次读回时出现两份冲突来源
        val raw = SettingsCodec.encode(Settings(appearance = Settings.Appearance.dark))
        SettingsCodec.legacyKeyNames().forEach { key ->
            assertFalse("不应写出旧键 $key", raw.contains("\"$key\""))
        }
        assertTrue(raw.contains("\"appearance\""))
    }

    @Test
    fun migrationResultPersistsAsAppearanceOnly() {
        val migrated = SettingsCodec.decode("""{"forceDarkMode":true}""")
        val rewritten = SettingsCodec.encode(migrated)
        assertFalse(rewritten.contains("forceDarkMode"))
        assertEquals(Settings.Appearance.dark, SettingsCodec.decode(rewritten).appearance)
    }

    @Test
    fun oldForceDarkModeMigratesToAppearanceDark() {
        // 旧版本只写过 forceDarkMode: true → 升级后应仍是暗夜
        val legacy = """{"forceDarkMode":true,"dailyNewWordLimit":25}"""
        val decoded = SettingsCodec.decode(legacy)
        assertEquals(Settings.Appearance.dark, decoded.appearance)
        assertEquals(25, decoded.dailyNewWordLimit)
    }

    @Test
    fun oldForceDarkModeFalseMigratesToSystem() {
        val legacy = """{"forceDarkMode":false}"""
        assertEquals(Settings.Appearance.system, SettingsCodec.decode(legacy).appearance)
    }

    @Test
    fun appearanceWinsOverLegacyFlag() {
        // 两个键同时存在时以 appearance 为准（对应 iOS 的 decodeIfPresent 顺序）
        val raw = """{"appearance":"light","forceDarkMode":true}"""
        assertEquals(Settings.Appearance.light, SettingsCodec.decode(raw).appearance)
    }

    @Test
    fun missingFieldsFallBackToDefaultsIndividually() {
        // 只存了一部分字段：其余必须回落到 iOS 默认值，而不是整份重置
        val partial = """{"dailyNewWordLimit":5}"""
        val decoded = SettingsCodec.decode(partial)
        assertEquals(5, decoded.dailyNewWordLimit)
        assertEquals(50, decoded.dailyReviewLimit)
        assertEquals(DefinitionModule.allCases, decoded.definitionOrder)
        assertTrue(decoded.autoPronounce)
    }

    @Test
    fun unknownAppearanceValueFallsBackWithoutLosingOtherFields() {
        val raw = """{"appearance":"neon","dailyReviewLimit":88}"""
        val decoded = SettingsCodec.decode(raw)
        assertEquals(Settings.Appearance.system, decoded.appearance)
        assertEquals(88, decoded.dailyReviewLimit)
    }

    @Test
    fun brokenJsonReturnsDefaults() {
        assertEquals(Settings(), SettingsCodec.decode("{not json"))
        assertEquals(Settings(), SettingsCodec.decode(null))
        assertEquals(Settings(), SettingsCodec.decode(""))
    }

    @Test
    fun definitionModuleLabelsMatchIosRawValues() {
        assertEquals("词典释义", DefinitionModule.dictionary.label)
        assertEquals("法律词典释义", DefinitionModule.legal.label)
        assertEquals("AI 释义", DefinitionModule.ai.label)
        assertEquals("自定义笔记", DefinitionModule.notes.label)
        assertNotNull(DefinitionModule.fromLabel("AI 释义"))
    }

    @Test
    fun appearanceTitlesMatchIos() {
        assertEquals("跟随系统", Settings.Appearance.system.title)
        assertEquals("日间", Settings.Appearance.light.title)
        assertEquals("暗夜", Settings.Appearance.dark.title)
    }

    // ------------------------------------------------------- 百度网盘配置（Phase 4b）

    @Test
    fun baiduPanDefaultsToDisabledNoteBarConfig() {
        // 默认不启用，且沙箱目录名与桌面端一致（/apps/NoteBar/）
        val pan = Settings().baiduPan
        assertFalse(pan.enabled)
        assertEquals("NoteBar", pan.dir)
        assertEquals("/apps/NoteBar", pan.sandboxRoot)
        assertEquals("/apps/NoteBar/Words", pan.wordsDir)
        assertEquals(0L, pan.expiresAt)
        assertEquals("", pan.appKey)
        assertEquals("", pan.secretKey)
    }

    @Test
    fun baiduPanRoundTripsThroughSettingsCodec() {
        val original = Settings(
            baiduPan = com.notebar.app.sync.BaiduPanSettings(
                enabled = true,
                appKey = "app-key",
                secretKey = "secret-key",
                accessToken = "access-token",
                refreshToken = "refresh-token",
                expiresAt = 1_763_000_000_000L,
                dir = "MyApp",
            ),
        )
        val decoded = SettingsCodec.decode(SettingsCodec.encode(original))
        assertEquals(original, decoded)
        assertEquals("/apps/MyApp", decoded.baiduPan.sandboxRoot)
    }

    @Test
    fun missingBaiduPanFallsBackToDefaultsWithoutLosingOtherFields() {
        // 旧版 Android 设置里根本没有 baiduPan：升级后必须补齐默认值，其余字段不受影响
        val decoded = SettingsCodec.decode("""{"dailyNewWordLimit":7,"aiModel":"gpt-4o"}""")
        assertEquals(7, decoded.dailyNewWordLimit)
        assertEquals("gpt-4o", decoded.aiModel)
        assertEquals(com.notebar.app.sync.BaiduPanConfig.defaults(), decoded.baiduPan)
    }

    @Test
    fun unknownFieldsInsideBaiduPanArePreserved() {
        // 跨端共享配置的关键承诺：桌面端日后新增的键不能被 Android 吃掉
        val raw = """
            {"baiduPan":{"enabled":true,"appKey":"k","futureField":"keep-me","nested":{"a":1}}}
        """.trimIndent()
        val pan = SettingsCodec.decode(raw).baiduPan
        assertTrue(pan.enabled)
        assertEquals("k", pan.appKey)
        assertEquals(setOf("futureField", "nested"), pan.extra.keys)

        // 再编码一次，未知字段仍在（不是「忽略」而是「保留」）
        val reencoded = SettingsCodec.encode(SettingsCodec.decode(raw))
        assertTrue("未知字段被吃掉：$reencoded", reencoded.contains("keep-me"))
        assertTrue(reencoded.contains("\"a\":1"))
        assertTrue(reencoded.contains("\"baiduPan\""))
    }

    @Test
    fun baiduPanKeyIsDeclaredInKnownKeys() {
        // 设置页/迁移脚本据此判断「这个键属于本应用」
        assertTrue(SettingsCodec.knownKeys().contains("baiduPan"))
        assertTrue(SettingsCodec.encode(Settings()).contains("\"baiduPan\""))
    }

    @Test
    fun illegalBaiduPanValuesAreRepairedNotCrashing() {
        val raw = """{"baiduPan":{"enabled":"yes","expiresAt":-1,"dir":"   ","appKey":123}}"""
        val pan = SettingsCodec.decode(raw).baiduPan
        assertFalse(pan.enabled)
        assertEquals(0L, pan.expiresAt)
        assertEquals("NoteBar", pan.dir)
        assertEquals("", pan.appKey)
    }

    @Test
    fun brokenBaiduPanDoesNotResetWholeSettings() {
        val raw = """{"dailyReviewLimit":88,"baiduPan":"not-an-object"}"""
        val decoded = SettingsCodec.decode(raw)
        assertEquals(88, decoded.dailyReviewLimit)
        assertEquals(com.notebar.app.sync.BaiduPanConfig.defaults(), decoded.baiduPan)
    }

    @Test
    fun baiduPanCredentialsNeverAppearInLegacyKeys() {
        // 凭证只走 baiduPan 一处真相，不得散落到旧键
        SettingsCodec.legacyKeyNames().forEach { key ->
            assertFalse(SettingsCodec.encode(Settings()).contains("\"$key\""))
        }
    }
}

package com.notebar.app.services

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream

/**
 * 本地中文词典服务口径测试。
 *
 * 与桌面 LocalDictionaryService.lookupSync 对齐：key = word.trim().lowercase()，直查，
 * 只 trim 不去标点；未加载 / 加载失败 / 查无此词一律返回 null。
 * 全部用内联小 JSON，不依赖真实资产（真实资产只做存在性 + 可解析性断言）。
 */
class LocalDictionaryServiceTest {

    private val sampleJson = """
        {
          "apple": {"p": "ˈæpl", "d": ["n. 苹果", "n. 苹果树"], "a": ["apples"]},
          "run": {"d": ["v. 跑"], "a": []},
          "no phonetic": {"d": ["无音标"], "a": []},
          "empty entry": {}
        }
    """.trimIndent()

    /** 统计被打开次数与被读取字节数的 InputStream，用于验证「只解析一次」。 */
    private class CountingInputStream(text: String) : InputStream() {
        private val delegate = ByteArrayInputStream(text.toByteArray(Charsets.UTF_8))
        var readCalls = 0
            private set
        var bytesRead = 0
            private set

        override fun read(): Int {
            readCalls++
            val value = delegate.read()
            if (value >= 0) bytesRead++
            return value
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            readCalls++
            val n = delegate.read(b, off, len)
            if (n > 0) bytesRead += n
            return n
        }
    }

    @Test
    fun lookupHitsEntryIgnoringCase() {
        val service = LocalDictionaryService { ByteArrayInputStream(sampleJson.toByteArray()) }

        val entry = service.lookupSync("ApPlE")

        assertNotNull("大小写混合输入应命中 apple", entry)
        assertEquals("ˈæpl", entry!!.phonetic)
        assertEquals(listOf("n. 苹果", "n. 苹果树"), entry.definitions)
        assertEquals(listOf("apples"), entry.aliases)
    }

    @Test
    fun lookupTrimsSurroundingWhitespace() {
        val service = LocalDictionaryService { ByteArrayInputStream(sampleJson.toByteArray()) }

        val entry = service.lookupSync("  RUN\t\n ")

        assertNotNull("前后空白应被 trim 掉", entry)
        assertEquals(listOf("v. 跑"), entry!!.definitions)
    }

    @Test
    fun lookupReturnsNullForUnknownWord() {
        val service = LocalDictionaryService { ByteArrayInputStream(sampleJson.toByteArray()) }

        assertNull("词不在词典里应返回 null", service.lookupSync("banana"))
        // 只 trim 不去标点：带标点的输入按原样查，查不到就是 null
        assertNull("不去标点", service.lookupSync("apple!"))
        assertNull("空串直接 null", service.lookupSync("   "))
    }

    @Test
    fun lookupParsesOnlyOnce() {
        var openCount = 0
        val stream = CountingInputStream(sampleJson)
        val service = LocalDictionaryService {
            openCount++
            stream
        }

        service.lookupSync("apple")
        service.lookupSync("run")
        service.lookupSync("banana")
        service.wordCount()

        assertEquals("并发/重复查询只应打开并解析一次词典", 1, openCount)
        assertEquals("只应把流读一遍", sampleJson.toByteArray().size, stream.bytesRead)
    }

    @Test
    fun lookupReturnsNullAndDoesNotRetryAfterParseFailure() {
        var openCount = 0
        val service = LocalDictionaryService {
            openCount++
            ByteArrayInputStream("{ not json".toByteArray())
        }

        assertNull(service.lookupSync("apple"))
        assertNull(service.lookupSync("apple"))
        assertEquals("解析失败后不再重试", 0, service.wordCount())
        assertNull(service.lookupSync("run"))

        assertEquals("失败被缓存，只尝试解析一次", 1, openCount)
    }

    @Test
    fun lookupReturnsNullWhenStreamCannotBeOpened() {
        var openCount = 0
        val service = LocalDictionaryService {
            openCount++
            throw IllegalStateException("asset missing")
        }

        assertNull(service.lookupSync("apple"))
        assertNull(service.lookupSync("apple"))

        assertEquals("打不开流也只尝试一次", 1, openCount)
    }

    @Test
    fun wordCountMatchesEntryCount() {
        val service = LocalDictionaryService { ByteArrayInputStream(sampleJson.toByteArray()) }

        assertEquals("样本含 4 个词条", 4, service.wordCount())
        assertEquals("未加载时不应改变已加载结果", 4, service.wordCount())
    }

    @Test
    fun entryWithoutPhoneticOrAliasesIsEmptyNotMissing() {
        val service = LocalDictionaryService { ByteArrayInputStream(sampleJson.toByteArray()) }

        val noPhonetic = service.lookupSync("no phonetic")
        assertNotNull(noPhonetic)
        assertNull("缺 p 字段时 phonetic 为 null", noPhonetic!!.phonetic)

        val empty = service.lookupSync("empty entry")
        assertNotNull(empty)
        assertTrue(empty!!.definitions.isEmpty())
        assertTrue(empty.aliases.isEmpty())
    }

    @Test
    fun realDictionaryAssetExistsAndIsLargeEnough() {
        val file = candidateAssetPaths().firstOrNull { it.isFile }
        assertNotNull(
            "未找到 assets/dictionary.lite.json（cwd=" + File(".").absolutePath + "）",
            file,
        )
        assertTrue(
            "真实词典资产应大于 1MB，实际 " + file!!.length() + " 字节",
            file.length() > 1_000_000L,
        )
    }

    @Test
    fun realDictionaryAssetIsParseableAndLookupWorks() {
        val file = candidateAssetPaths().firstOrNull { it.isFile }
        assertNotNull("未找到 assets/dictionary.lite.json", file)
        val service = LocalDictionaryService { file!!.inputStream() }

        assertTrue("真实词典应解析出大量词条", service.wordCount() > 10_000)
        val apple = service.lookupSync("  Apple ")
        assertNotNull("真实词典应命中 apple", apple)
        assertTrue(apple!!.definitions.isNotEmpty())
    }

    /** Gradle 单测 cwd 通常是模块目录（app/），同时也兼容仓库根目录运行。 */
    private fun candidateAssetPaths(): List<File> = listOf(
        File("src/main/assets/dictionary.lite.json"),
        File("app/src/main/assets/dictionary.lite.json"),
        File("NoteBarApp-Android/app/src/main/assets/dictionary.lite.json"),
    )
}

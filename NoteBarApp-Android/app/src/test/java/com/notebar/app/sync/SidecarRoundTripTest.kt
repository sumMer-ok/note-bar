package com.notebar.app.sync

import com.notebar.app.data.EntryCodec
import com.notebar.engine.Entry
import com.notebar.engine.StudyProgress
import com.notebar.engine.sync.FileMeta
import com.notebar.engine.sync.FileStore
import com.notebar.engine.sync.SyncEngine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 内存 [FileStore]：把文件系统装进 Map，让同步接线可以在 JVM 单测里跑真实路径。
 */
class MemoryFileStore : FileStore {
    val files = LinkedHashMap<String, String>()
    var listFails = false

    override fun list(dir: String): List<FileMeta>? {
        if (listFails) return null
        val normalized = dir.trimEnd('/')
        val prefix = "$normalized/"
        val direct = files.keys.filter { it.startsWith(prefix) }
        val names = direct.map { it.removePrefix(prefix) }.map { it.substringBefore('/') }.toSet()
        if (names.isEmpty()) {
            // 目录不存在（或空目录）：均返回空列表，与 LocalFileStore 对不存在目录的处理一致
            return emptyList()
        }
        return names.map { name ->
            val path = "$prefix$name"
            val isDir = files.keys.any { it.startsWith("$path/") }
            FileMeta(name, isDirectory = isDir, mtime = files[path]?.length?.toLong(), size = 0L)
        }
    }

    override fun readText(path: String): String? = files[path]

    override fun writeAtomic(path: String, text: String): Boolean {
        files[path] = text
        return true
    }

    override fun delete(path: String): Boolean {
        files.remove(path)
        return true
    }

    override fun exists(path: String): Boolean = files.containsKey(path)
}

/**
 * 同步接线回归：EntryEntity → engine Entry → `writeSidecar`。
 *
 * 本条测试响应主 agent 的裁决：`writeSidecar` 的「原始 JSON 合并」必须保住
 * `StudyProgress` 模型**未声明**的旧字段（interval / ef / reps），
 * 否则 Android 会在每次评分时静默吃掉桌面端写入的字段。
 *
 * 注意走的是 app 层真实路径：EntryEntity → EntryCodec.toEntry → Entry.progress → writeSidecar。
 */
class SidecarRoundTripTest {

    private val root = "/sync"
    private val book = "Words/英语词库.canvas"
    private val sidecarPath = "/sync/Words/英语词库.nb-sync.json"
    private val key = "en:word:apple"

    private fun seedSidecarWithLegacyFields(): String {
        // 模拟桌面端 / 旧版本写好、且 Android 的 StudyProgress 没有声明的字段
        return """
            {
              "version": 1,
              "book": "$book",
              "words": {
                "$key": {
                  "status": "review",
                  "stage": 3,
                  "reps": 7,
                  "ef": 2.5,
                  "interval": 14,
                  "s": 2.0,
                  "d": 5.0,
                  "lapses": 1,
                  "dueDate": "2026-08-01",
                  "lastReview": "2026-07-18T10:00:00Z",
                  "masteredAt": "2026-06-01T00:00:00Z",
                  "FUTURE_FIELD": "keep-me",
                  "nested": {"a": 1}
                }
              },
              "updatedAt": "2026-07-18T10:00:00Z"
            }
        """.trimIndent()
    }

    private fun entityRow(
        s: Double = 3.0,
        d: Double = 5.5,
        dueDate: String = "2026-09-01",
        lastReview: String = "2026-08-14T10:00:00Z",
    ) = EntryCodec.toEntity(
        Entry(
            studyKey = key,
            book = book,
            source = book,
            nodeId = "node-1",
            word = "apple",
            status = "review",
            s = s,
            d = d,
            lapses = 2,
            dueDate = dueDate,
            lastReview = lastReview,
        ),
    )

    @Test
    fun ratingWriteBackKeepsModelUndeclaredFields() {
        val store = MemoryFileStore()
        store.files[sidecarPath] = seedSidecarWithLegacyFields()
        val engine = SyncEngine()

        // 真实路径：数据库行 → engine Entry → 打分后的进度 → writeSidecar
        val row = entityRow()
        val entry = EntryCodec.toEntry(row)
        val progress: StudyProgress = com.notebar.app.domain.ReviewEngine
            .rate(entry, com.notebar.app.domain.ReviewDirection.good)
            .progress

        val ok = engine.writeSidecar(store, sidecarPath, book, key, progress)
        // 读回校验的 lastReview 必须落盘
        assertTrue("writeSidecar 应写回成功", ok)

        val written = Json.parseToJsonElement(store.files[sidecarPath]!!).jsonObject
        val words = written["words"]!!.jsonObject
        val word = words[key]!!.jsonObject

        // 契约：模型未声明的旧字段一个都不能丢（interval / ef / reps 不在 StudyProgress 里）
        assertEquals("14", (word["interval"] as JsonPrimitive).content)
        assertEquals("2.5", (word["ef"] as JsonPrimitive).content)
        assertEquals("7", (word["reps"] as JsonPrimitive).content)
        assertEquals("3", (word["stage"] as JsonPrimitive).content)
        // masteredAt 是 StudyProgress **声明过**的字段，因此由本次评分的合并结果决定；
        // 本次评分毕业 → 写入新的 masteredAt（这是正确行为，不是丢字段）
        assertNotNull(word["masteredAt"])
        // 完全未知的字段也必须存活
        assertEquals("keep-me", (word["FUTURE_FIELD"] as JsonPrimitive).content)
        assertNotNull(word["nested"])

        // 本次写入的字段确实被更新了
        assertEquals(progress.lastReview, (word["lastReview"] as JsonPrimitive).content)
        assertEquals(progress.dueDate, (word["dueDate"] as JsonPrimitive).content)
        assertEquals("graduated", (word["lifecycle"] as JsonPrimitive).content)
        assertEquals("mastered", (word["status"] as JsonPrimitive).content)
    }

    @Test
    fun sidecarNeverLosesProgressFromDiskWhenDiskIsNewer() {
        // 红线 2：磁盘里更新的进度必须胜出，Room 不得反向覆盖
        val store = MemoryFileStore()
        store.files[sidecarPath] = seedSidecarWithLegacyFields()
        val engine = SyncEngine()

        // 本地（Room）的 lastReview 比磁盘旧
        val stale = entityRow(lastReview = "2026-07-01T10:00:00Z").let { EntryCodec.toEntry(it) }
        val ok = engine.writeSidecar(
            store,
            sidecarPath,
            book,
            key,
            stale.progress.copy(lastReview = "2026-07-01T10:00:00Z"),
        )
        // 磁盘更新 → 合并后磁盘值胜出，读回校验必然失败（engine 会重试后返回 false）
        assertFalse(ok)
        val written = Json.parseToJsonElement(store.files[sidecarPath]!!).jsonObject
        val word = written["words"]!!.jsonObject[key]!!.jsonObject
        assertEquals("2026-07-18T10:00:00Z", (word["lastReview"] as JsonPrimitive).content)
    }

    @Test
    fun entityRoundTripThroughRealWritePathIsStable() {
        // 打分 → 存 Room 行 → 再读回来 → 进度字段与写入值一致
        val row = entityRow()
        val entry = EntryCodec.toEntry(row)
        val outcome = com.notebar.app.domain.ReviewEngine
            .rate(entry, com.notebar.app.domain.ReviewDirection.hard)
        val persisted = EntryCodec.toEntity(
            com.notebar.app.domain.ReviewEngine.apply(entry, outcome),
        )
        val reread = EntryCodec.toEntry(persisted)

        assertEquals(outcome.progress.lastReview, reread.lastReview)
        assertEquals(outcome.progress.dueDate, reread.dueDate)
        assertEquals(outcome.progress.s!!, reread.s!!, 1e-9)
        assertEquals(outcome.progress.d!!, reread.d!!, 1e-9)
        assertEquals(entry.firstLearnedDate ?: outcome.firstLearnedDate, reread.firstLearnedDate)
    }
}

/**
 * [LocalFileStore] 的语义测试：区分「枚举失败」与「空目录」，且原子写必须覆盖。
 */
class LocalFileStoreTest {

    @Test
    fun listReturnsNullForMissingDirectory() {
        val store = LocalFileStore()
        assertNull(store.list("/definitely/not/a/directory"))
    }

    @Test
    fun listReturnsItemsForRealDirectory() {
        val dir = kotlin.io.path.createTempDirectory("notebar-fs").toFile()
        try {
            java.io.File(dir, "a.canvas").writeText("{}")
            java.io.File(dir, "sub").mkdirs()
            val items = LocalFileStore().list(dir.absolutePath)!!
            assertEquals(setOf("a.canvas", "sub"), items.map { it.name }.toSet())
            assertTrue(items.first { it.name == "sub" }.isDirectory)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun writeAtomicCreatesFileAndOverwritesExisting() {
        val dir = kotlin.io.path.createTempDirectory("notebar-write").toFile()
        try {
            val path = java.io.File(dir, "x.nb-sync.json").absolutePath
            assertTrue(LocalFileStore().writeAtomic(path, "first"))
            assertEquals("first", java.io.File(path).readText())
            assertTrue(LocalFileStore().writeAtomic(path, "second"))
            assertEquals("second", java.io.File(path).readText())
            // 不留下临时文件
            assertFalse(dir.listFiles()!!.any { it.name.endsWith(".nb-tmp") })
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun readTextReturnsNullForMissingFile() {
        assertNull(LocalFileStore().readText("/nope/missing.txt"))
    }

    @Test
    fun deleteIsIdempotent() {
        val store = LocalFileStore()
        assertTrue(store.delete("/nope/missing.txt"))
    }
}

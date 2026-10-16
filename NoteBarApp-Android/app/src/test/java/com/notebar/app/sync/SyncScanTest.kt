package com.notebar.app.sync

import com.notebar.app.data.EntryCodec
import com.notebar.app.domain.ReviewDirection
import com.notebar.app.domain.ReviewEngine
import com.notebar.engine.sync.SyncEngine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 同步扫描的端到端（内存文件系统）回归。
 *
 * 覆盖红线 2 的核心承诺：
 * - `.canvas` / `.nb-sync.json` 是 source of truth；
 * - 合并一律走 `SyncEngine.applyRemote`（内部 `Merge.progress`），
 *   **磁盘里更新的进度必须胜出**，Room 侧的旧值不得反向覆盖；
 * - 本地已编辑但未上传的单词内容必须保留并标记 pendingPush。
 */
class SyncScanTest {

    private val root = "/sync"
    private val canvasPath = "/sync/Words/英语词库.canvas"
    private val sidecarPath = "/sync/Words/英语词库.nb-sync.json"
    private val book = "Words/英语词库.canvas"

    private fun canvasJson(vararg nodes: String): String =
        """{"nodes":[${nodes.joinToString(",")}]}"""

    private fun textNode(id: String, text: String, color: String? = null): String =
        """{"id":"$id","type":"text","text":"$text","x":0,"y":0,"width":200,"height":100""" +
            (if (color != null) ""","color":"$color"""" else "") + "}"

    private fun seedStore(withSidecarProgress: String? = null): MemoryFileStore {
        val store = MemoryFileStore()
        store.files[canvasPath] = canvasJson(
            textNode("n1", "apple\n--- 词典释义 ---\nn. 苹果"),
            textNode("n2", "banana\n--- 词典释义 ---\nn. 香蕉"),
        )
        if (withSidecarProgress != null) {
            store.files[sidecarPath] = withSidecarProgress
        }
        return store
    }

    private fun sidecar(lastReview: String, s: Double = 9.0, dueDate: String = "2026-09-30"): String =
        """{"version":1,"book":"$book","words":{"en:word:apple":{
            "status":"review","s":$s,"d":5.0,"lapses":1,
            "dueDate":"$dueDate","lastReview":"$lastReview"}},
            "updatedAt":"2026-07-18T10:00:00Z"}"""

    @Test
    fun scanCollectsCanvasWordsAndSidecarProgress() {
        val store = seedStore(sidecar("2026-08-01T10:00:00Z"))
        val engine = SyncEngine()

        val result = engine.scan(store, root, engine.logicalPrefixFor(store, root))
        assertEquals(1, result.snapshots.size)
        val snapshot = result.snapshots.first()
        assertEquals(book, snapshot.relative)
        assertEquals(listOf("apple", "banana"), snapshot.words.map { it.word })
        assertNotNull(snapshot.progress["en:word:apple"])
        assertTrue(result.conflicts.isEmpty())
    }

    @Test
    fun logicalPrefixIsWordsWhenRootHasNoCanvasDirectly() {
        val store = seedStore()
        val engine = SyncEngine()
        // 根目录下没有 .canvas（它们在 Words/ 里）→ 前缀应为 Words/
        assertEquals("Words/", engine.logicalPrefixFor(store, root))
    }

    @Test
    fun logicalPrefixIsEmptyWhenRootIsTheWordsDirectory() {
        val store = MemoryFileStore()
        store.files["/words-dir/a.canvas"] = canvasJson(textNode("n1", "apple"))
        val engine = SyncEngine()
        assertEquals("", engine.logicalPrefixFor(store, "/words-dir"))
    }

    @Test
    fun secondScanWithUnchangedMtimesSkipsWork() {
        val store = seedStore(sidecar("2026-08-01T10:00:00Z"))
        val engine = SyncEngine()
        val first = engine.scan(store, root, "Words/")
        assertTrue(first.changed.isNotEmpty())
        val second = engine.scan(store, root, "Words/")
        // mtime 未变 → 不进 changed（对应 iOS 的 lastMtimes 闸门）
        assertTrue(second.changed.isEmpty())
    }

    @Test
    fun remoteProgressWinsWhenDiskIsNewer() {
        // 磁盘 lastReview = 2026-08-01；Room 里的旧值 = 2026-07-01 → 磁盘必须胜出
        val store = seedStore(sidecar("2026-08-01T10:00:00Z", s = 9.0))
        val engine = SyncEngine()

        val staleLocal = com.notebar.engine.Entry(
            studyKey = "en:word:apple",
            book = book,
            source = book,
            nodeId = "n1",
            word = "apple",
            status = "review",
            s = 1.0,
            d = 5.0,
            dueDate = "2026-07-02",
            lastReview = "2026-07-01T10:00:00Z",
        )

        val result = engine.scan(store, root, "Words/")
        val snapshot = result.snapshots.first()
        val applied = engine.applyRemote(
            entry = staleLocal,
            word = snapshot.words.first { it.nodeId == "n1" },
            relative = book,
            remoteProgress = snapshot.progress["en:word:apple"],
        )

        assertEquals("2026-08-01T10:00:00Z", applied.entry.lastReview)
        assertEquals(9.0, applied.entry.s!!, 1e-9)
        assertEquals("2026-09-30", applied.entry.dueDate)
    }

    @Test
    fun localNewerProgressIsNotOverwrittenByDisk() {
        val store = seedStore(sidecar("2026-07-01T10:00:00Z", s = 1.0))
        val engine = SyncEngine()

        val freshLocal = com.notebar.engine.Entry(
            studyKey = "en:word:apple",
            book = book,
            source = book,
            nodeId = "n1",
            word = "apple",
            status = "review",
            s = 20.0,
            d = 5.0,
            dueDate = "2026-12-01",
            lastReview = "2026-08-20T10:00:00Z",
        )

        val result = engine.scan(store, root, "Words/")
        val applied = engine.applyRemote(
            entry = freshLocal,
            word = result.snapshots.first().words.first { it.nodeId == "n1" },
            relative = book,
            remoteProgress = result.snapshots.first().progress["en:word:apple"],
        )
        // 本地更新 → 本地值保留
        assertEquals("2026-08-20T10:00:00Z", applied.entry.lastReview)
        assertEquals(20.0, applied.entry.s!!, 1e-9)
    }

    @Test
    fun locallyEditedTextIsPreservedAndMarkedForPush() {
        val store = seedStore(sidecar("2026-08-01T10:00:00Z"))
        val engine = SyncEngine()

        // 本地已编辑（localEditedAt 非空）且与磁盘释义不同
        val edited = com.notebar.engine.Entry(
            studyKey = "en:word:apple",
            book = book,
            source = book,
            nodeId = "n1",
            word = "apple",
            definition = "本地新释义",
            localEditedAt = "2026-08-21T08:30:00Z",
        )

        val result = engine.scan(store, root, "Words/")
        val applied = engine.applyRemote(
            entry = edited,
            word = result.snapshots.first().words.first { it.nodeId == "n1" },
            relative = book,
            remoteProgress = result.snapshots.first().progress["en:word:apple"],
        )
        assertTrue(applied.pendingPush)
        assertEquals("本地新释义", applied.entry.definition)
    }

    @Test
    fun cleanLocalTextIsOverwrittenByDisk() {
        val store = seedStore(sidecar("2026-08-01T10:00:00Z"))
        val engine = SyncEngine()

        // 没有 localEditedAt → 允许磁盘内容覆盖本地
        val clean = com.notebar.engine.Entry(
            studyKey = "en:word:apple",
            book = book,
            source = book,
            nodeId = "n1",
            word = "apple",
            definition = "旧释义",
        )
        val result = engine.scan(store, root, "Words/")
        val applied = engine.applyRemote(
            entry = clean,
            word = result.snapshots.first().words.first { it.nodeId == "n1" },
            relative = book,
            remoteProgress = null,
        )
        assertTrue(applied.entry.definition.contains("苹果"))
        assertTrue(!applied.pendingPush)
    }

    @Test
    fun newRemoteWordCreatesEntryWithLegacyFieldsDerived() {
        val store = seedStore()
        val store2 = MemoryFileStore().also {
            it.files[canvasPath] = store.files[canvasPath]!!
            // 旧数据：只有 interval，没有 s/d → 必须补齐，否则会被当成新词
            it.files[sidecarPath] = """{"version":1,"book":"$book","words":{
                "en:word:apple":{"status":"review","interval":14,"lastReview":"2026-08-01T10:00:00Z"}},
                "updatedAt":"2026-08-01T10:00:00Z"}"""
        }
        val engine = SyncEngine()
        val result = engine.scan(store2, root, "Words/")
        val snapshot = result.snapshots.first()
        val applied = engine.applyRemote(
            entry = null,
            word = snapshot.words.first { it.nodeId == "n1" },
            relative = book,
            remoteProgress = snapshot.progress["en:word:apple"],
        )
        // interval=14 → s=14.0（withLegacyFieldsDerived）
        assertEquals(14.0, applied.entry.s!!, 1e-9)
        assertEquals(5.0, applied.entry.d!!, 1e-9)
        assertNotNull(applied.entry.dueDate)
    }

    @Test
    fun ratingThenWriteSidecarKeepsLegacyFieldsAndUnknownKeys() {
        val store = MemoryFileStore()
        store.files[canvasPath] = canvasJson(textNode("n1", "apple"))
        store.files[sidecarPath] = """{"version":1,"book":"$book","words":{
            "en:word:apple":{"status":"review","stage":2,"reps":5,"ef":2.4,"interval":10,
            "s":1.0,"d":5.0,"lapses":1,"dueDate":"2026-07-01",
            "lastReview":"2026-07-01T10:00:00Z","UNKNOWN_KEY":"keep"}},
            "updatedAt":"2026-07-01T10:00:00Z"}"""

        val engine = SyncEngine()
        val scan = engine.scan(store, root, "Words/")
        val snapshot = scan.snapshots.first()
        val remote = snapshot.progress["en:word:apple"]!!

        // 用磁盘进度补 legacy 字段后建 Entry，再评分
        val entry = com.notebar.engine.Entry(
            studyKey = "en:word:apple",
            book = book,
            source = book,
            nodeId = "n1",
            word = "apple",
        ).withProgress(remote.withLegacyFieldsDerived())

        val outcome = ReviewEngine.rate(entry, ReviewDirection.good)
        val ok = engine.writeSidecar(store, sidecarPath, book, "en:word:apple", outcome.progress)
        assertTrue(ok)

        val written = Json.parseToJsonElement(store.files[sidecarPath]!!).jsonObject
        val word = written["words"]!!.jsonObject["en:word:apple"]!!.jsonObject
        // 模型未声明的旧字段与未知键全部存活
        assertEquals("2", (word["stage"] as JsonPrimitive).content)
        assertEquals("5", (word["reps"] as JsonPrimitive).content)
        assertEquals("2.4", (word["ef"] as JsonPrimitive).content)
        assertEquals("10", (word["interval"] as JsonPrimitive).content)
        assertEquals("keep", (word["UNKNOWN_KEY"] as JsonPrimitive).content)
        // 本次评分写入的字段被更新
        assertEquals(outcome.progress.lastReview, (word["lastReview"] as JsonPrimitive).content)
    }

    @Test
    fun scanFailsGracefullyWhenDirectoryUnreadable() {
        val store = MemoryFileStore().also { it.listFails = true }
        val engine = SyncEngine()
        val result = engine.scan(store, root, "Words/")
        assertEquals(com.notebar.engine.sync.SyncStatus.SCAN_FAILED, result.status.message)
        assertTrue(result.snapshots.isEmpty())
    }

    @Test
    fun conflictCopyIsDetectedAndNotTreatedAsABook() {
        val store = MemoryFileStore()
        store.files[canvasPath] = canvasJson(textNode("n1", "apple"))
        store.files["/sync/Words/英语词库 2.canvas"] = canvasJson(textNode("n9", "apple"), textNode("n8", "cherry"))

        val engine = SyncEngine()
        val result = engine.scan(store, root, "Words/")
        assertEquals(1, result.snapshots.size)
        assertEquals(1, result.conflicts.size)
        val conflict = result.conflicts.first()
        assertEquals("canvas", conflict.kind.rawValue)
        assertTrue(conflict.changedWords.contains("cherry"))
    }

    @Test
    fun pruneMissingBooksKeepsOnlyCurrentBooks() {
        val engine = SyncEngine()
        val entries = listOf(
            com.notebar.engine.Entry("k1", "Words/a.canvas", "Words/a.canvas", "n1", "a"),
            com.notebar.engine.Entry("k2", "Words/gone.canvas", "Words/gone.canvas", "n2", "b"),
        )
        val kept = engine.pruneMissingBooks(entries, setOf("Words/a.canvas"))
        assertEquals(listOf("k1"), kept.map { it.studyKey })
        // currentBooks 为空时不做清理（避免目录暂不可读时误清空）
        assertEquals(entries, engine.pruneMissingBooks(entries, emptySet()))
    }

    @Test
    fun physicalPathNeverNestsWordsDirectory() {
        val engine = SyncEngine()
        val path = engine.physicalPath(
            root = root,
            logicalPrefix = "Words/",
            logical = book,
            suffix = ".nb-sync.json",
            replacingExtension = ".canvas",
        )
        assertEquals(sidecarPath, path)
        // 选的是 Words 目录本身时落在 root 下，不会写成 Words/Words
        val p2 = engine.physicalPath(
            root = "/words-dir",
            logicalPrefix = "",
            logical = "a.canvas",
            suffix = ".nb-sync.json",
            replacingExtension = ".canvas",
        )
        assertEquals("/words-dir/a.nb-sync.json", p2)
    }

    @Test
    fun entityFromScanRoundTripsThroughRoomShape() {
        val store = seedStore(sidecar("2026-08-01T10:00:00Z"))
        val engine = SyncEngine()
        val snapshot = engine.scan(store, root, "Words/").snapshots.first()
        val applied = engine.applyRemote(
            entry = null,
            word = snapshot.words.first { it.nodeId == "n1" },
            relative = book,
            remoteProgress = snapshot.progress["en:word:apple"],
        )
        // 落成 Room 行再读回，字段不丢
        val restored = EntryCodec.toEntry(EntryCodec.toEntity(applied.entry))
        assertEquals(applied.entry, restored)
        assertNull(restored.localEditedAt)
    }
}

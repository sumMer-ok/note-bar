package com.notebar.engine.sync

import com.notebar.engine.Entry
import com.notebar.engine.Merge
import com.notebar.engine.NoteBarJson
import com.notebar.engine.SidecarFile
import com.notebar.engine.StudyKey
import com.notebar.engine.StudyProgress
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 用内存假 [FileStore] 驱动 [SyncEngine]，行为对齐 iOS `SyncService`。
 *
 * 覆盖 `NoteBarAppTests/SyncIntegrationTests.swift` 的等价场景（冲突识别与仲裁、
 * 冲突副本的 changedWords、选择 Words 目录本身不写嵌套 Words/Words），
 * 外加扫描 mtime 闸门、本地未上传编辑保护、进度合并、边车读回校验、幂等与清理。
 */
class SyncEngineTests {

    // ================================================================ 假端口

    /**
     * 内存文件系统。语义刻意与 [FileStore] 契约一致：
     * - `list` 对不存在/不可枚举的目录返回 null；
     * - `writeAtomic` 可被注入「声称成功但不落盘」的故障（模拟 iCloud 提供器不提交写入）。
     */
    private class FakeStore : FileStore {
        private val files = LinkedHashMap<String, String>()
        private val dirs = LinkedHashSet<String>()
        private val mtimes = LinkedHashMap<String, Long>()

        /** 写入声称成功但内容不落盘（模拟 iOS 注释里的「iCloud 提供器偶发不提交写入」） */
        var dropWrites = false

        /** 下一次写原子写失败一次（函数式地消耗掉） */
        var failNextWrite = false

        /** 所有 list 调用返回 null（模拟安全作用域失效） */
        var failLists = false

        /** 写入尝试次数，用于验证「失败重试一次」 */
        var writeAttempts = 0
            private set

        /** 直接读原始文本（校验"未知字段是否被保留"这类保真断言用） */
        fun peek(path: String): String? = files[path]

        fun mkdir(path: String) {
            dirs.add(path)
            // 父目录链一并建出来，避免测试里到处 mkdir
            var p = path
            while (true) {
                val i = p.lastIndexOf('/')
                if (i <= 0) break
                p = p.substring(0, i)
                dirs.add(p)
            }
        }

        fun put(path: String, text: String, mtime: Long = 1_000L) {
            mkdir(path.substringBeforeLast('/', ""))
            files[path] = text
            mtimes[path] = mtime
        }

        /** 登记一个 mtime 为 null 的文件（模拟提供者给不出 contentModificationDate） */
        fun putWithoutMtime(path: String, text: String) {
            mkdir(path.substringBeforeLast('/', ""))
            files[path] = text
            mtimes.remove(path)
        }

        fun touch(path: String, mtime: Long) {
            mtimes[path] = mtime
        }

        fun content(path: String): String? = files[path]

        fun removePath(path: String) {
            files.remove(path)
            mtimes.remove(path)
            dirs.remove(path)
        }

        override fun list(dir: String): List<FileMeta>? {
            if (failLists) return null
            if (!dirs.contains(dir)) return null
            val prefix = if (dir.isEmpty()) "" else "$dir/"
            val out = ArrayList<FileMeta>()
            for ((path, text) in files) {
                if (path.startsWith(prefix) && !path.removePrefix(prefix).contains('/')) {
                    out.add(FileMeta(path.substringAfterLast('/'), false, mtimes[path], text.length.toLong()))
                }
            }
            for (path in dirs) {
                if (path.startsWith(prefix) && !path.removePrefix(prefix).contains('/')) {
                    out.add(FileMeta(path.substringAfterLast('/'), true, mtimes[path], 0L))
                }
            }
            return out
        }

        override fun readText(path: String): String? = files[path]

        override fun writeAtomic(path: String, text: String): Boolean {
            writeAttempts++
            if (failNextWrite) {
                failNextWrite = false
                return false
            }
            if (dropWrites) return true // 声称成功，但不落盘
            put(path, text, mtime = (mtimes[path] ?: 0L) + 1)
            return true
        }

        override fun delete(path: String): Boolean {
            files.remove(path)
            mtimes.remove(path)
            return true
        }

        override fun exists(path: String): Boolean = files.containsKey(path) || dirs.contains(path)
    }

    // ============================================================ 测试脚手架

    private val root = "/sync/NoteBar"
    private val wordsDir = "$root/Words"
    private val prefix = "Words/"
    private val engine = SyncEngine()

    /** 一个词的 canvas；id/word/definition 显式给出，便于断言 */
    private fun canvas(vararg words: Triple<String, String, String>): String {
        val nodes = words.joinToString(",") { (id, word, definition) ->
            """{"id":"$id","type":"text","text":"$word\n\n$definition"}"""
        }
        return """{"nodes":[$nodes],"edges":[]}"""
    }

    private fun sidecarJson(book: String, updatedAt: String, words: Map<String, StudyProgress>): String =
        NoteBarJson.instance.encodeToString(
            SidecarFile.serializer(),
            SidecarFile(version = 1, book = book, words = words, updatedAt = updatedAt),
        )

    private fun readSidecar(store: FakeStore, path: String): SidecarFile =
        NoteBarJson.instance.decodeFromString(SidecarFile.serializer(), store.content(path)!!)

    /** 模拟 iOS scan 的词条层：按 changed 快照逐词合并，再按 currentBooks 清理 */
    private fun applyScan(
        store: FakeStore,
        entries: MutableList<Entry>,
        result: SyncScanResult,
    ): List<ApplyRemoteResult> {
        val applied = ArrayList<ApplyRemoteResult>()
        for (snapshot in result.changed) {
            for (word in snapshot.words) {
                val key = StudyKey.canvas(source = snapshot.relative, nodeId = word.nodeId)
                val index = entries.indexOfFirst { it.studyKey == key }
                val existing = if (index >= 0) entries[index] else null
                val r = engine.applyRemote(existing, word, snapshot.relative, snapshot.progress[key])
                applied.add(r)
                if (index >= 0) entries[index] = r.entry else entries.add(r.entry)
            }
        }
        if (result.currentBooks.isNotEmpty()) {
            entries.retainAll { result.currentBooks.contains(it.book) }
        }
        return applied
    }

    private fun seededStore(): FakeStore {
        val store = FakeStore()
        store.mkdir(root)
        store.mkdir(wordsDir)
        store.put("$wordsDir/words.canvas", canvas(Triple("n1", "hello", "你好")))
        return store
    }

    // ============================================================ 1. mtime 闸门

    /** mtime 未变化 → 跳过；canvas 或 sidecar 任一变化 → 处理 */
    @Test
    fun scanSkipsUnchangedBooksAndProcessesChanged() {
        val store = seededStore()
        store.put(
            "$wordsDir/words.nb-sync.json",
            sidecarJson("Words/words.canvas", "2026-08-01T00:00:00Z", emptyMap()),
            mtime = 500L,
        )

        val first = engine.scan(store, root, prefix)
        assertEquals(listOf("Words/words.canvas"), first.changed.map { it.relative })
        assertEquals(1, first.snapshots.size)

        // 完全没动 → 跳过
        val second = engine.scan(store, root, prefix)
        assertTrue(second.changed.isEmpty(), "mtime 未变化时不应重复处理")
        assertEquals(1, second.snapshots.size, "快照仍应产出（用于清理词库列表）")

        // 只动 canvas → 处理
        store.touch("$wordsDir/words.canvas", 2_000L)
        assertEquals(listOf("Words/words.canvas"), engine.scan(store, root, prefix).changed.map { it.relative })

        // 只动边车 → 同样要处理（canvas 与 sidecar 两个 mtime 都参与比对）
        store.touch("$wordsDir/words.canvas", 2_000L)
        store.touch("$wordsDir/words.nb-sync.json", 9_000L)
        assertEquals(listOf("Words/words.canvas"), engine.scan(store, root, prefix).changed.map { it.relative })
    }

    /** 同一轮里每个词库的 mtime 都会落账：第一次扫描后立刻再扫也是跳过 */
    @Test
    fun scanRecordsMtimeBeforeMergeSoRescanIsSkipped() {
        val store = seededStore()
        val a = engine.scan(store, root, prefix)
        assertEquals(1, a.changed.size)
        // 未做任何合并就直接重扫：iOS 先写 lastMtimes 再合并，因此这里也应是跳过
        assertTrue(engine.scan(store, root, prefix).changed.isEmpty())
    }

    /**
     * Swift 可选比较的 `nil == nil → true` 边界：某词库的 canvas 与 sidecar mtime **都为 null**
     * （提供者给不出 contentModificationDate）且此前无记录时，iOS 也会 `continue` 跳过它。
     *
     * 这是有意逐字对齐的行为，不是 bug：不得为了「第一遍必须处理」而改掉它。
     */
    @Test
    fun bookWithAllNullMtimesIsSkippedLikeIosOptionalComparison() {
        val store = FakeStore()
        store.mkdir(root)
        store.mkdir(wordsDir)
        store.putWithoutMtime("$wordsDir/words.canvas", canvas(Triple("n1", "hello", "你好")))

        val first = engine.scan(store, root, prefix)
        assertEquals(1, first.snapshots.size, "快照仍应产出")
        assertNull(first.snapshots.first().canvasMtime)
        assertNull(first.snapshots.first().sidecarMtime)
        assertTrue(first.changed.isEmpty(), "nil == nil 为真 → iOS 与这里都跳过")

        // 一旦 mtime 变为可用值，就该被处理
        store.touch("$wordsDir/words.canvas", 5_000L)
        assertEquals(listOf("Words/words.canvas"), engine.scan(store, root, prefix).changed.map { it.relative })
    }

    /** 目录枚举失败 → 返回 SCAN_FAILED，与 iOS 枚举 nil 时的提示一致 */    @Test
    fun scanReportsFailureWhenDirectoryUnreadable() {
        val store = seededStore()
        store.failLists = true
        val result = engine.scan(store, root, prefix)
        assertEquals(SyncStatus.SCAN_FAILED, result.status.message)
        assertTrue(result.snapshots.isEmpty())
        assertTrue(result.changed.isEmpty())
    }

    /** Words 目录不存在时不是错误：files 为空数组，扫描成功但零词库（对应 iOS 的 else 分支） */
    @Test
    fun missingWordsDirectoryIsNotAFailure() {
        val store = FakeStore()
        store.mkdir(root)
        val result = engine.scan(store, root, prefix)
        assertTrue(result.snapshots.isEmpty())
        assertTrue(result.status.message.startsWith("已连接："))
    }

    // ================================================== 2. 本地未上传编辑保护

    /** 本地有未上传编辑且与云端有差异 → 保留本地、进入待回推，不被云端旧内容覆盖 */
    @Test
    fun localUnpushedEditWinsOverStaleRemote() {
        val snapshot = CanvasSnapshot(
            relative = "Words/words.canvas",
            words = listOf(
                com.notebar.engine.ParsedWord(nodeId = "n1", word = "hello", definition = "云端旧释义"),
            ),
            progress = emptyMap(),
            canvasMtime = 1L,
            sidecarMtime = null,
        )
        val local = Entry(
            studyKey = "Words/words.canvas:n1",
            book = "Words/words.canvas",
            source = "Words/words.canvas",
            nodeId = "n1",
            word = "hello",
            definition = "本地新释义",
            localEditedAt = "2026-08-14T10:00:00Z",
        )

        val result = engine.applyRemote(local, snapshot.words[0], snapshot.relative, null)
        assertTrue(result.pendingPush, "本地未上传编辑应进入待回推")
        assertTrue(result.changed)
        assertEquals("本地新释义", result.entry.definition, "不得被云端旧内容覆盖")
        assertContentEquals(engine.collectPendingPush(listOf(local), snapshot).map { it.studyKey }, listOf(local.studyKey))
    }

    /** localEditedAt 为空（已上传）时，云端内容照常覆盖本地 */
    @Test
    fun pushedEditIsOverwrittenByRemote() {
        val snapshot = CanvasSnapshot(
            relative = "Words/words.canvas",
            words = listOf(com.notebar.engine.ParsedWord(nodeId = "n1", word = "hello", definition = "云端释义")),
            progress = emptyMap(),
            canvasMtime = 1L,
            sidecarMtime = null,
        )
        val local = Entry(
            studyKey = "Words/words.canvas:n1", book = "Words/words.canvas", source = "Words/words.canvas",
            nodeId = "n1", word = "hello", definition = "旧释义", localEditedAt = null,
        )
        val result = engine.applyRemote(local, snapshot.words[0], snapshot.relative, null)
        assertFalse(result.pendingPush)
        assertEquals("云端释义", result.entry.definition)
        // 文本已一致 → 不进待回推
        assertTrue(engine.collectPendingPush(listOf(result.entry), snapshot).isEmpty())
    }

    /**
     * 有 localEditedAt 但文本与云端一致 → 不算冲突（iOS 的先决条件是 textChanged）。
     * 同时 color/addedDate/mastered 位于 if/else 之外，**始终以云端为准**。
     */
    @Test
    fun colorAddedDateMasteredAlwaysFollowRemoteEvenWithPendingEdit() {
        val snapshot = CanvasSnapshot(
            relative = "Words/words.canvas",
            words = listOf(
                com.notebar.engine.ParsedWord(
                    nodeId = "n1", word = "hello", definition = "同样释义",
                    color = "4", addedDate = "2026-08-02", mastered = true,
                ),
            ),
            progress = emptyMap(),
            canvasMtime = 1L,
            sidecarMtime = null,
        )
        val local = Entry(
            studyKey = "Words/words.canvas:n1", book = "Words/words.canvas", source = "Words/words.canvas",
            nodeId = "n1", word = "hello", definition = "同样释义",
            color = "1", addedDate = "2026-08-01", mastered = false,
            localEditedAt = "2026-08-14T10:00:00Z",
        )
        val result = engine.applyRemote(local, snapshot.words[0], snapshot.relative, null)
        assertFalse(result.pendingPush, "文本无差异就不算待回推")
        assertEquals("4", result.entry.color)
        assertEquals("2026-08-02", result.entry.addedDate)
        assertEquals(true, result.entry.mastered)
    }

    // ==================================================== 3. 新增 / 字段合并

    /** 云端新增词条 → 本地新建，且进度走 withLegacyFieldsDerived 补齐 */
    @Test
    fun newRemoteWordIsInsertedWithLegacyDerivedProgress() {
        val remote = StudyProgress(
            status = "review",
            interval = 14,
            ef = 2.5,
            lastReview = "2026-08-13T09:22:23.219Z",
        )
        val word = com.notebar.engine.ParsedWord(nodeId = "n9", word = "world", definition = "世界")
        val result = engine.applyRemote(null, word, "Words/words.canvas", remote)

        assertEquals(true, result.changed)
        assertFalse(result.pendingPush)
        assertEquals("Words/words.canvas:n9", result.entry.studyKey)
        assertEquals("世界", result.entry.definition)
        assertEquals(14.0, result.entry.s, "远程进度应先补齐 legacy 字段")
        assertEquals(5.0, result.entry.d)
        assertEquals("2026-08-27", result.entry.dueDate?.take(10))
    }

    /** 本地已有同一 nodeId → 按字段合并，不重复插入 */
    @Test
    fun existingLocalWordIsMergedFieldByField() {
        val snapshot = CanvasSnapshot(
            relative = "Words/words.canvas",
            words = listOf(
                com.notebar.engine.ParsedWord(
                    nodeId = "n1", word = "hello", aliases = listOf("hi"), definition = "你好",
                ),
            ),
            progress = emptyMap(),
            canvasMtime = 1L,
            sidecarMtime = null,
        )
        val local = Entry(
            studyKey = "Words/words.canvas:n1", book = "Words/words.canvas", source = "Words/words.canvas",
            nodeId = "n1", word = "hello", aliases = emptyList(), definition = "旧",
        )
        val result = engine.applyRemote(local, snapshot.words[0], snapshot.relative, null)
        assertEquals("你好", result.entry.definition)
        assertEquals(listOf("hi"), result.entry.aliases)
        assertEquals("Words/words.canvas:n1", result.entry.studyKey, "studyKey 不得变化")
        assertEquals("Words/words.canvas", result.entry.book)
    }

    /** 快照里没有该词时原样返回（iOS 的删除只发生在清理词库阶段） */
    @Test
    fun applyRemoteBySnapshotLeavesUnknownEntryUntouched() {
        val snapshot = CanvasSnapshot(
            relative = "Words/words.canvas",
            words = listOf(com.notebar.engine.ParsedWord(nodeId = "n1", word = "hello")),
            progress = emptyMap(),
            canvasMtime = 1L,
            sidecarMtime = null,
        )
        val other = Entry(
            studyKey = "Words/words.canvas:nX", book = "Words/words.canvas", source = "Words/words.canvas",
            nodeId = "nX", word = "ghost",
        )
        assertEquals(other, engine.applyRemote(other, snapshot))
    }

    // ======================================================== 4. 进度合并语义

    @Test
    fun progressMergeUsesMergeSemantics() {
        val snapshot = CanvasSnapshot(
            relative = "Words/words.canvas",
            words = listOf(com.notebar.engine.ParsedWord(nodeId = "n1", word = "hello", definition = "你好")),
            progress = mapOf(
                "Words/words.canvas:n1" to StudyProgress(
                    status = "review",
                    s = 99.0,
                    lastReview = "2026-08-13T00:00:00.000Z",
                    history = listOf(
                        com.notebar.engine.ReviewRecord("2026-08-12T00:00:00.000Z", "good"),
                        com.notebar.engine.ReviewRecord("2026-08-13T00:00:00.000Z", "again"),
                    ),
                ),
            ),
            canvasMtime = 1L,
            sidecarMtime = 2L,
        )
        val local = Entry(
            studyKey = "Words/words.canvas:n1", book = "Words/words.canvas", source = "Words/words.canvas",
            nodeId = "n1", word = "hello", definition = "你好",
            s = 10.0,
            status = "learning",
            lastReview = "2026-08-12T00:00:00.000Z",
            history = listOf(com.notebar.engine.ReviewRecord("2026-08-12T00:00:00.000Z", "good")),
        )

        val result = engine.applyRemote(local, snapshot.words[0], snapshot.relative, snapshot.progress[local.studyKey])
        assertEquals(99.0, result.entry.s, "lastReview 较新的远程应胜出")
        assertEquals("review", result.entry.status)
        assertEquals("2026-08-13T00:00:00.000Z", result.entry.lastReview)
        assertEquals(2, result.entry.history?.size, "history 应按 date|quality 去重合并")

        // 与 Merge 直接算出的结果逐字段一致（确认引擎没有二次加工）
        val expected = Merge.progress(local = local.progress, remote = snapshot.progress[local.studyKey]!!)!!
        assertEquals(expected.s, result.entry.s)
        assertEquals(expected.history, result.entry.history)
        assertEquals(expected.lastReview, result.entry.lastReview)
    }

    /** 本地更新时本地胜出：不得被远程旧进度覆盖 */
    @Test
    fun localNewerProgressWins() {
        val remote = StudyProgress(status = "learning", s = 1.0, lastReview = "2026-08-01T00:00:00.000Z")
        val local = Entry(
            studyKey = "Words/words.canvas:n1", book = "Words/words.canvas", source = "Words/words.canvas",
            nodeId = "n1", word = "hello", status = "review", s = 50.0,
            lastReview = "2026-08-20T00:00:00.000Z",
        )
        val word = com.notebar.engine.ParsedWord(nodeId = "n1", word = "hello")
        val result = engine.applyRemote(local, word, "Words/words.canvas", remote)
        assertEquals(50.0, result.entry.s)
        assertEquals("review", result.entry.status)
        assertEquals("2026-08-20T00:00:00.000Z", result.entry.lastReview)
    }

    // ===================================================== 5. 边车读回校验

    @Test
    fun writeSidecarWritesAndVerifies() {
        val store = seededStore()
        val path = "$wordsDir/words.nb-sync.json"
        val progress = StudyProgress(status = "mastered", s = 42.0, lastReview = "2026-08-14T00:00:00.000Z")

        assertTrue(engine.writeSidecar(store, path, "Words/words.canvas", "Words/words.canvas:n1", progress))

        val sidecar = readSidecar(store, path)
        assertEquals("Words/words.canvas", sidecar.book)
        assertEquals(1, sidecar.version)
        assertEquals(42.0, sidecar.words["Words/words.canvas:n1"]?.s)
        assertEquals("2026-08-14T00:00:00.000Z", sidecar.words["Words/words.canvas:n1"]?.lastReview)
    }

    /** 写入不生效（提供器不提交）→ 读回校验失败 → 返回 false */
    @Test
    fun writeSidecarReturnsFalseWhenWriteDoesNotLand() {
        val store = seededStore()
        val path = "$wordsDir/words.nb-sync.json"
        store.dropWrites = true

        val ok = engine.writeSidecar(
            store, path, "Words/words.canvas", "k",
            StudyProgress(status = "review", lastReview = "2026-08-14T00:00:00.000Z"),
        )
        assertFalse(ok, "写入声称成功但未落盘时必须返回 false")
        assertEquals(2, store.writeAttempts, "应重试一次")
        assertNull(store.content(path))
    }

    /** 第一次写失败、重试成功 → 返回 true */
    @Test
    fun writeSidecarRetriesOnceOnTransientFailure() {
        val store = seededStore()
        val path = "$wordsDir/words.nb-sync.json"
        store.failNextWrite = true

        val ok = engine.writeSidecar(
            store, path, "Words/words.canvas", "k",
            StudyProgress(status = "review", lastReview = "2026-08-14T00:00:00.000Z"),
        )
        assertTrue(ok)
        assertEquals(2, store.writeAttempts)
        assertEquals("2026-08-14T00:00:00.000Z", readSidecar(store, path).words["k"]?.lastReview)
    }

    /** 写回是「读 → 合并 → 写」：磁盘上其它 key 与既有字段不得丢失 */
    @Test
    fun writeSidecarMergesWithExistingContentAndKeepsOtherKeys() {
        val store = seededStore()
        val path = "$wordsDir/words.nb-sync.json"
        store.put(
            path,
            sidecarJson(
                "Words/words.canvas", "2026-08-01T00:00:00Z",
                mapOf("other" to StudyProgress(status = "learning", s = 3.0, lastReview = "2026-08-01T00:00:00.000Z")),
            ),
        )

        assertTrue(
            engine.writeSidecar(
                store, path, "Words/IGNORED.canvas", "k",
                StudyProgress(status = "review", s = 7.0, lastReview = "2026-08-14T00:00:00.000Z"),
            ),
        )

        val sidecar = readSidecar(store, path)
        assertTrue(
            Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$").matches(sidecar.updatedAt),
            "updatedAt 应被刷新为秒级 ISO8601，实际：${sidecar.updatedAt}",
        )
        assertEquals(3.0, sidecar.words["other"]?.s, "其它 key 必须原样保留")
        assertEquals("Words/words.canvas", sidecar.book, "已存在的边车 book 沿用磁盘值，不被入参覆盖")
        assertEquals(7.0, sidecar.words["k"]?.s)
    }

    /**
     * 红线回归：词条内的**未知字段必须原样保留**。
     *
     * 桌面端 `writeSidecarAtomic` 是 JSON 合并，词条内未知字段（如日后新增的字段、
     * 其他端写入的扩展键）会存活；若 Android 走强类型编解码就会静默吃掉它们，
     * 等于单方面破坏既有数据模型。此测试钉死"保真"这条契约。
     */
    @Test
    fun writeSidecarPreservesUnknownFieldsInsideWordEntries() {
        val store = FakeStore()
        val path = "$wordsDir/words.nb-sync.json"
        store.put(
            path,
            """{"version":1,"book":"Words/words.canvas","words":{"k":{"status":"review","s":1.0,"FUTURE_FIELD":42,"nested":{"keep":true}}},"updatedAt":"2026-01-01T00:00:00Z","TOP_LEVEL_FUTURE":"keepme"}""",
        )

        assertTrue(
            engine.writeSidecar(
                store, path, "Words/words.canvas", "k",
                StudyProgress(status = "review", s = 9.0, lastReview = "2026-08-14T00:00:00.000Z"),
            ),
        )

        val raw = store.peek(path)!!
        assertTrue(raw.contains("\"FUTURE_FIELD\":42"), "词条内未知字段被丢弃：$raw")
        assertTrue(raw.contains("\"nested\":{\"keep\":true}"), "词条内嵌套未知对象被丢弃：$raw")
        assertTrue(raw.contains("\"TOP_LEVEL_FUTURE\":\"keepme\""), "顶层未知字段被丢弃：$raw")
        // 本次写入的进度必须真的落盘
        assertEquals(9.0, readSidecar(store, path).words["k"]?.s)
        assertEquals("2026-08-14T00:00:00.000Z", readSidecar(store, path).words["k"]?.lastReview)
    }

    /**
     * 与上一条配对：**未知字段保留**不得退化成"旧值永不消失"。
     *
     * 注意 `dueDate` 的留存是**正确**的合并语义（iOS `Merge.progress`：胜者为空时回落败者），
     * 所以这里用一个人为构造的、合并结果里确实不存在的**已知字段**来验证清理路径：
     * 磁盘有 `stage`，而合并结果里 `stage` 仍来自磁盘（同样会被保留）——
     * 因此真正可验证的是「写入的字段被更新、未知字段未被误删」这两条，
     * 清理逻辑由 STUDY_PROGRESS_FIELDS 白名单保证，另有单测 `writeSidecarPreservesUnknownFields…` 反向钉住。
     */
    @Test
    fun writeSidecarKeepsMergeFallbackButUpdatesWrittenFields() {
        val store = FakeStore()
        val path = "$wordsDir/words.nb-sync.json"
        store.put(
            path,
            """{"version":1,"book":"Words/words.canvas","words":{"k":{"status":"review","s":1.0,"dueDate":"2026-08-01","lastReview":"2026-08-01T00:00:00.000Z"}},"updatedAt":"2026-01-01T00:00:00Z"}""",
        )

        assertTrue(
            engine.writeSidecar(
                store, path, "Words/words.canvas", "k",
                StudyProgress(status = "review", s = 9.0, lastReview = "2026-08-14T00:00:00.000Z"),
            ),
        )

        val entry = readSidecar(store, path).words["k"]!!
        assertEquals(9.0, entry.s, "本次写入的 s 必须生效（而不是留下旧的 1.0）")
        assertEquals("2026-08-14T00:00:00.000Z", entry.lastReview, "本次写入的 lastReview 必须生效")
        assertEquals(
            "2026-08-01", entry.dueDate,
            "dueDate 是本条磁盘值：Merge 胜者（入参）为空 → 回落败者，属 iOS 既有语义，必须保留",
        )
    }

    /**
     * 磁盘上的 lastReview 更新时，合并结果以磁盘为准，
     * 于是「回读校验 == 本次写入的 lastReview」必然失败 → 返回 false。
     * 这是与 iOS 逐行一致的行为（iOS 重试后同样报「未同步到电脑端」）。
     */
    @Test
    fun writeSidecarFailsVerificationWhenDiskHoldsNewerProgress() {
        val store = seededStore()
        val path = "$wordsDir/words.nb-sync.json"
        store.put(
            path,
            sidecarJson(
                "Words/words.canvas", "2026-08-20T00:00:00Z",
                mapOf("k" to StudyProgress(status = "review", s = 88.0, lastReview = "2026-08-20T00:00:00.000Z")),
            ),
        )

        val ok = engine.writeSidecar(
            store, path, "Words/words.canvas", "k",
            StudyProgress(status = "review", s = 1.0, lastReview = "2026-08-01T00:00:00.000Z"),
        )
        assertFalse(ok)
        assertEquals("2026-08-20T00:00:00.000Z", readSidecar(store, path).words["k"]?.lastReview, "磁盘较新者不得被旧值覆盖")
    }

    /** 边车 updatedAt 与 iOS ISO8601DateFormatter 一致：秒级、带 Z */
    @Test
    fun sidecarTimestampIsSecondPrecisionIso8601() {
        val store = seededStore()
        val path = "$wordsDir/words.nb-sync.json"
        engine.writeSidecar(store, path, "Words/words.canvas", "k", StudyProgress(status = "new"))
        val updatedAt = readSidecar(store, path).updatedAt
        assertTrue(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$").matches(updatedAt), "实际值：$updatedAt")
    }

    // ====================================================== 6. 冲突副本仲裁

    /** canvas 冲突副本识别（对齐 iOS testConflictCopyDetectionAndResolution） */
    @Test
    fun detectsCanvasConflictCopyAndChangedWords() {
        val store = seededStore()
        store.put("$wordsDir/words 2.canvas", canvas(Triple("b", "world", "世界")), mtime = 2_000L)

        val result = engine.scan(store, root, prefix)
        assertEquals(1, result.conflicts.size)

        val conflict = result.conflicts.first()
        assertEquals("Words/words.canvas", conflict.book)
        assertEquals(SyncConflictKind.CANVAS, conflict.kind)
        assertEquals("$wordsDir/words 2.canvas", conflict.conflictPath)
        assertEquals("$wordsDir/words.canvas", conflict.mainPath)
        assertContentEquals(listOf("hello", "world"), conflict.changedWords)
        assertEquals("canvas:$wordsDir/words 2.canvas", conflict.id)
        assertEquals("words", conflict.bookDisplayName)

        // 副本不得被当成一个词库
        assertEquals(listOf("Words/words.canvas"), result.snapshots.map { it.relative })
    }

    /** 边车冲突副本识别：`英语词库 2.nb-sync.json` → book 换成 .canvas，kind = sidecar */
    @Test
    fun detectsSidecarConflictCopy() {
        val store = seededStore()
        store.put(
            "$wordsDir/英语词库.nb-sync.json",
            sidecarJson("Words/英语词库.canvas", "2026-08-01T00:00:00Z", mapOf("a" to StudyProgress(status = "new"))),
        )
        store.put(
            "$wordsDir/英语词库 2.nb-sync.json",
            sidecarJson(
                "Words/英语词库.canvas", "2026-08-02T00:00:00Z",
                mapOf("a" to StudyProgress(status = "new"), "b" to StudyProgress(status = "review")),
            ),
        )

        val result = engine.scan(store, root, prefix)
        assertEquals(1, result.conflicts.size)
        val conflict = result.conflicts.first()
        assertEquals(SyncConflictKind.SIDECAR, conflict.kind)
        assertEquals("Words/英语词库.canvas", conflict.book)
        assertEquals("$wordsDir/英语词库.nb-sync.json", conflict.mainPath)
        assertEquals("$wordsDir/英语词库 2.nb-sync.json", conflict.conflictPath)
        assertContentEquals(listOf("b"), conflict.changedWords, "主边车少一个 key")
        assertEquals("英语词库", conflict.bookDisplayName)
    }

    /** 保留副本：主文件内容被副本替换，副本消失 */
    @Test
    fun resolveConflictKeepCopyReplacesMain() {
        val store = seededStore()
        store.put("$wordsDir/words 2.canvas", canvas(Triple("b", "world", "世界")), mtime = 2_000L)
        val conflict = engine.scan(store, root, prefix).conflicts.first()

        assertTrue(engine.resolveConflict(store, conflict, keepCopy = true))
        assertTrue(store.content("$wordsDir/words.canvas")!!.contains("world"), "主文件应含副本内容")
        assertNull(store.content("$wordsDir/words 2.canvas"), "副本应被移除")
        assertNull(store.list(wordsDir)!!.firstOrNull { it.name == "words 2.canvas" })
    }

    /** 保留主版本：副本改名归档为 `.resolved-<epoch 秒>`，主文件不动 */
    @Test
    fun resolveConflictKeepMainArchivesCopy() {
        val store = seededStore()
        val mainContent = canvas(Triple("n1", "hello", "你好"))
        store.put("$wordsDir/words 2.canvas", canvas(Triple("b", "world", "世界")), mtime = 2_000L)
        val conflict = engine.scan(store, root, prefix).conflicts.first()

        assertTrue(engine.resolveConflict(store, conflict, keepCopy = false))
        assertEquals(mainContent, store.content("$wordsDir/words.canvas"), "主文件不得被改动")
        assertNull(store.content("$wordsDir/words 2.canvas"))
        val archived = store.list(wordsDir)!!.filter { it.name.startsWith("words 2.canvas.resolved-") }
        assertEquals(1, archived.size, "副本应被归档")
        assertTrue(archived.first().name.substringAfter("words 2.canvas.resolved-").toLong() > 0)
    }

    /** 仲裁后清掉 mtime 记录，强制下次扫描重新处理（对应 iOS L326） */
    @Test
    fun resolveConflictForgetsMtimeSoNextScanReprocesses() {
        val store = seededStore()
        assertTrue(engine.scan(store, root, prefix).changed.isNotEmpty())
        assertTrue(engine.scan(store, root, prefix).changed.isEmpty(), "首次之后应被 mtime 闸门跳过")

        store.put("$wordsDir/words 2.canvas", canvas(Triple("b", "world", "世界")), mtime = 9_000L)
        val conflict = engine.scan(store, root, prefix).conflicts.first()
        engine.resolveConflict(store, conflict, keepCopy = true)

        assertTrue(engine.scan(store, root, prefix).changed.isNotEmpty(), "仲裁后必须重新处理主词库")
    }

    /** 非冲突副本命名的普通文件不受影响 */
    @Test
    fun nonConflictSidecarNamesAreNotConflicts() {
        val store = seededStore()
        store.put(
            "$wordsDir/words.nb-sync.json",
            sidecarJson("Words/words.canvas", "2026-08-01T00:00:00Z", mapOf("Words/words.canvas:n1" to StudyProgress(status = "new"))),
        )
        store.put("$wordsDir/words2.nb-sync.json", sidecarJson("Words/other.canvas", "2026-08-01T00:00:00Z", emptyMap()))

        val result = engine.scan(store, root, prefix)
        assertTrue(result.conflicts.isEmpty(), "不得误判：" + result.conflicts.map { it.conflictPath })
    }

    // ============================================================ 7. 幂等

    /** 重复扫描幂等：第二次无变化 → changed 为空、词条不再被改动 */
    @Test
    fun repeatedScanIsIdempotent() {
        val store = seededStore()
        store.put(
            "$wordsDir/words.nb-sync.json",
            sidecarJson(
                "Words/words.canvas", "2026-08-01T00:00:00Z",
                mapOf("Words/words.canvas:n1" to StudyProgress(status = "review", s = 4.0, lastReview = "2026-08-01T00:00:00.000Z")),
            ),
        )

        val entries = mutableListOf<Entry>()
        val first = applyScan(store, entries, engine.scan(store, root, prefix))
        assertEquals(1, first.size)
        assertTrue(first.all { it.changed })
        val snapshotAfterFirst = entries.map { it.copy() }

        val second = applyScan(store, entries, engine.scan(store, root, prefix))
        assertTrue(second.isEmpty(), "第二次扫描不应产生任何待应用词条")
        assertEquals(snapshotAfterFirst, entries, "词条不得被再次改动")
    }

    /** 无任何文件变化时扫描两次，conflicts 与 snapshots 也必须稳定 */
    @Test
    fun repeatedScanKeepsSnapshotsAndConflictsStable() {
        val store = seededStore()
        store.put("$wordsDir/words 2.canvas", canvas(Triple("b", "world", "世界")), mtime = 2_000L)

        val first = engine.scan(store, root, prefix)
        val second = engine.scan(store, root, prefix)
        assertEquals(first.snapshots.map { it.relative }, second.snapshots.map { it.relative })
        assertEquals(first.conflicts.map { it.id }, second.conflicts.map { it.id })
    }

    // ======================================================== 8. 词库清理

    /** 清理只在扫描到词库时发生；currentBooks 为空 → 不得清空 */
    @Test
    fun pruneOnlyRunsWhenBooksWereScanned() {
        val stale = listOf(
            Entry(studyKey = "words.canvas:n1", book = "words.canvas", source = "words.canvas", nodeId = "n1", word = "a"),
            Entry(studyKey = "Words/Words/a.canvas:n1", book = "Words/Words/a.canvas", source = "Words/Words/a.canvas", nodeId = "n1", word = "b"),
            Entry(studyKey = "Words/a.canvas:n1", book = "Words/a.canvas", source = "Words/a.canvas", nodeId = "n1", word = "c"),
        )

        // 扫描到 0 个词库 → 原样保留（避免误清空）
        assertEquals(stale, engine.pruneMissingBooks(stale, emptySet()))

        // 扫描到词库 → 只保留实际存在的
        val kept = engine.pruneMissingBooks(stale, setOf("Words/a.canvas"))
        assertEquals(listOf("Words/a.canvas"), kept.map { it.book })
    }

    /** 整链路：b.canvas 被删除后，第二次扫描应清掉对应词条（对齐 iOS testStaleBooksAreRemovedOnScan） */
    @Test
    fun removedBookIsPrunedOnNextScan() {
        val store = seededStore()
        store.put("$wordsDir/b.canvas", canvas(Triple("b", "book", "书")))

        val entries = mutableListOf<Entry>()
        applyScan(store, entries, engine.scan(store, root, prefix))
        assertEquals(setOf("Words/words.canvas", "Words/b.canvas"), entries.map { it.book }.toSet())

        store.removePath("$wordsDir/b.canvas")
        applyScan(store, entries, engine.scan(store, root, prefix))
        assertEquals(setOf("Words/words.canvas"), entries.map { it.book }.toSet())
    }

    // ================================================ 9. logicalPrefix / 路径

    /** 用户直接选中 Words 目录：prefix 为空，边车写在所选目录本身，不得产生 Words/Words */
    @Test
    fun pickingWordsDirectoryDirectlyWritesBesideIt() {
        val store = FakeStore()
        store.mkdir(root)
        store.put("$root/words.canvas", canvas(Triple("n1", "hello", "你好")))

        val detected = engine.logicalPrefixFor(store, root)
        assertEquals("", detected)

        val result = engine.scan(store, root, detected)
        assertEquals(listOf("Words/words.canvas"), result.snapshots.map { it.relative }, "逻辑名仍带 Words/ 前缀")

        val sidecarPath = engine.physicalPath(root, detected, "Words/words.canvas", ".nb-sync.json", ".canvas")
        assertEquals("$root/words.nb-sync.json", sidecarPath)
        assertFalse(sidecarPath.contains("Words/Words"))
        assertTrue(
            engine.writeSidecar(
                store, sidecarPath, "Words/words.canvas", "Words/words.canvas:n1",
                StudyProgress(status = "mastered", s = 42.0, lastReview = "2026-08-14T00:00:00.000Z"),
            ),
        )
        assertNotNull(store.content("$root/words.nb-sync.json"))
        assertNull(store.list(root)!!.firstOrNull { it.name == "Words" }, "不得创建嵌套 Words 目录")
    }

    /** 用户选中 NoteBar 目录：prefix 为 Words/，边车落在 <root>/Words/ */
    @Test
    fun pickingNoteBarDirectoryUsesWordsSubdir() {
        val store = seededStore()
        assertEquals("Words/", engine.logicalPrefixFor(store, root))
        assertEquals(
            "$wordsDir/words.nb-sync.json",
            engine.physicalPath(root, "Words/", "Words/words.canvas", ".nb-sync.json", ".canvas"),
        )
    }

    /** canvas 的物理路径：suffix 为空、不替换扩展名 */
    @Test
    fun physicalPathForCanvasKeepsExtension() {
        assertEquals(
            "$wordsDir/words.canvas",
            engine.physicalPath(root, "Words/", "Words/words.canvas", "", null),
        )
    }

    // ================================================ 10. 边车解码容错

    /** 坏边车（缺 updatedAt）按缺失处理，不影响 canvas 扫描 */
    @Test
    fun malformedSidecarIsTreatedAsAbsent() {
        val store = seededStore()
        store.put("$wordsDir/words.nb-sync.json", """{"version":1,"book":"Words/words.canvas","words":{}}""")

        val result = engine.scan(store, root, prefix)
        assertEquals(1, result.snapshots.size)
        assertTrue(result.snapshots.first().progress.isEmpty(), "解不出的边车不得让扫描失败")
        assertNull(result.snapshots.first().sidecarMtime)
    }

    /** 边车按文件内 book 建索引：book 与文件名不一致时取不到进度（与 iOS 一致，不做模糊匹配） */
    @Test
    fun sidecarIsIndexedByItsDeclaredBook() {
        val store = seededStore()
        store.put(
            "$wordsDir/words.nb-sync.json",
            sidecarJson(
                "Words/other.canvas", "2026-08-01T00:00:00Z",
                mapOf("k" to StudyProgress(status = "review", s = 9.0)),
            ),
        )
        val snapshot = engine.scan(store, root, prefix).snapshots.first()
        assertEquals("Words/words.canvas", snapshot.relative)
        assertTrue(snapshot.progress.isEmpty(), "book 不匹配时不应套用该边车")
        // iOS：sidecarMtimes 按声明的 book 记账（L461），快照按 relative 取用（L474）
        // → 两者不一致时进度与 mtime 都取不到，该词库永远会被 mtime 闸门放行
        assertNull(snapshot.sidecarMtime, "book 不匹配时 sidecarMtime 同样取不到")
    }
}

package com.notebar.app.sync

import com.notebar.engine.Merge
import com.notebar.engine.StudyKey
import com.notebar.engine.StudyProgress
import com.notebar.engine.sync.SyncEngine
import com.notebar.engine.sync.SyncStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 端到端：`SyncEngine` 真的跑在**百度网盘后端**上（内存版网盘，不触网）。
 *
 * 这组用例回答的是「换后端到底换对了没有」——[BaiduPanFileStoreTest] 验的是单点端口语义，
 * 这里验的是 engine 的**完整扫描 / 合并 / 写边车**流程在新后端上不退化，尤其是：
 * - `.canvas` 与 `.nb-sync.json` 的内容一字不改（红线 2）；
 * - 磁盘里更新的进度必须胜出（`Merge.progress` 的仲裁不被后端改变）；
 * - 未知字段在往返后仍然存在（红线 2 的「未知字段必须保留」）；
 * - 首次同步（远端空）不能报成「目录权限不可用」。
 *
 * 与桌面端 `baidu-pan-provider.test.ts` 的对照：那个文件覆盖「镜像编排 + 采纳前校验 +
 * backup + 审计」；这些属于桌面端 provider 的职责，Android 侧由 [SyncEngine] 承担
 * （它已经有自己的 79 个 engine 测试）。本文件只补「后端从本地换成网盘」的增量风险。
 */
class BaiduPanSyncIntegrationTest {

    private val engine = SyncEngine()
    private val token = "fake-access-token-1"

    private fun client(transport: MemoryPanTransport, dir: String = "NoteBar"): BaiduPanClient =
        BaiduPanClient(
            initialConfig = BaiduPanSettings(
                enabled = true,
                appKey = "fake-app-key",
                secretKey = "fake-secret-key",
                accessToken = token,
                refreshToken = "fake-refresh-token-1",
                expiresAt = Long.MAX_VALUE,
                dir = dir,
            ),
            transport = transport,
            nowMs = { 1_763_000_000_000L },
            sleep = { },
        )

    private fun storeOf(transport: MemoryPanTransport): BaiduPanFileStore {
        val c = client(transport)
        return BaiduPanFileStore(c, remoteRoot = c.wordsDir, localRoot = c.wordsDir)
    }

    private fun canvasJson(vararg nodes: String): String =
        """{"nodes":[${nodes.joinToString(",")}]}"""

    private fun textNode(id: String, text: String, color: String? = null): String =
        """{"id":"$id","type":"text","text":"$text","x":0,"y":0,"width":200,"height":100""" +
            (if (color != null) ""","color":"$color"""" else "") + "}"

    private fun sidecar(words: String, updatedAt: String = "2026-10-16T10:00:00Z"): String =
        """{"version":1,"book":"Words/英语.canvas","words":{$words},"updatedAt":"$updatedAt"}"""

    /** 词库与边车在网盘上的实际路径（照桌面端 provider 的布局） */
    private val canvasPath = "/apps/NoteBar/Words/英语.canvas"
    private val sidecarPath = "/apps/NoteBar/Words/Words/英语.nb-sync.json"
    private val book = "Words/英语.canvas"

    private fun seededTransport(): MemoryPanTransport {
        val transport = MemoryPanTransport()
        transport.seedFile(
            canvasPath,
            canvasJson(
                textNode("n1", "apple\n--- 词典释义 ---\nn. 苹果"),
                textNode("n2", "banana\n--- 词典释义 ---\nn. 香蕉"),
            ),
        )
        return transport
    }

    // --------------------------------------------------------------- 扫描

    @Test
    fun scanReadsCanvasAndSidecarFromPanBackend() {
        val transport = seededTransport()
        transport.seedFile(
            sidecarPath,
            sidecar(
                """"en:word:apple":{"status":"review","s":9.0,"d":5.0,"lapses":1,
                   "dueDate":"2026-09-30","lastReview":"2026-08-01T10:00:00Z"}""",
            ),
        )
        val store = storeOf(transport)

        val result = engine.scan(store, store.wordsDir, store.logicalPrefix)

        assertEquals(1, result.snapshots.size)
        val snapshot = result.snapshots.first()
        assertEquals(book, snapshot.relative)
        assertEquals(listOf("apple", "banana"), snapshot.words.map { it.word })
        assertNotNull("边车进度必须从网盘读回来", snapshot.progress["en:word:apple"])
        assertTrue(result.conflicts.isEmpty())
        assertTrue(result.status.message.startsWith("已连接"))
    }

    @Test
    fun firstScanOnEmptyRemoteIsConnectedNotEmptyFailure() {
        // 首次同步时远端只有沙箱根。若后端把「目录不存在」报成枚举失败，
        // engine 会给出「同步失败：目录权限不可用」——那是**误报**。
        val transport = MemoryPanTransport()
        transport.dirs.add("/apps/NoteBar")
        val store = storeOf(transport)

        val result = engine.scan(store, store.wordsDir, store.logicalPrefix)

        assertTrue(result.snapshots.isEmpty())
        assertFalse(
            "首次同步不得报成权限失败：${result.status.message}",
            result.status.message == SyncStatus.SCAN_FAILED,
        )
        assertTrue(result.status.message.startsWith("已连接"))
    }

    // ----------------------------------------------------------- 进度合并

    @Test
    fun sidecarMergeKeepsNewerDiskProgress() {
        val transport = seededTransport()
        transport.seedFile(
            sidecarPath,
            sidecar(
                """"en:word:apple":{"status":"review","s":30.0,"d":12.0,
                   "dueDate":"2026-12-01","lastReview":"2026-10-10T10:00:00Z"}""",
            ),
        )
        val store = storeOf(transport)
        val result = engine.scan(store, store.wordsDir, store.logicalPrefix)
        val remote = result.snapshots.first().progress["en:word:apple"]!!

        // 本地（Room）里是更旧的进度 → 磁盘（网盘）里的较新者胜出
        val local = StudyProgress(status = "learning", s = 1.0, lastReview = "2026-09-01T00:00:00Z")
        val merged = Merge.progress(local = local, remote = remote)!!
        assertEquals("review", merged.status)
        assertEquals(30.0, merged.s!!, 1e-9)
    }

    // ----------------------------------------------------------- 写边车

    @Test
    fun writeSidecarRoundTripsThroughPanBackendAndVerifies() {
        val transport = seededTransport()
        transport.seedFile(sidecarPath, sidecar(""))
        val store = storeOf(transport)
        val key = StudyKey.canvas(book, "n1")
        val progress = StudyProgress(status = "review", s = 9.0, lastReview = "2026-10-16T10:00:00Z")

        // engine 内部的「写入 + 回读校验」必须在网盘后端上通过
        assertTrue(engine.writeSidecar(store, store.remotePathOf(sidecarPath), book, key, progress))

        // 落盘内容与 engine 直接写本地时的一致（同一套 mergeIntoRawSidecar）
        val written = transport.textOf(sidecarPath)
        assertNotNull(written)
        val decoded = com.notebar.engine.NoteBarJson.instance
            .decodeFromString(com.notebar.engine.SidecarFile.serializer(), written!!)
        assertEquals(book, decoded.book)
        assertEquals("2026-10-16T10:00:00Z", decoded.words[key]!!.lastReview)
    }

    @Test
    fun writeSidecarPreservesUnknownFieldsAcrossPanRoundTrip() {
        // 红线 2：`.nb-sync.json` 里的未知字段（别端新增的扩展键）必须一字不动地活下来。
        val transport = seededTransport()
        val key = StudyKey.canvas(book, "n1")
        transport.seedFile(
            sidecarPath,
            """
            {"version":1,"book":"Words/英语.canvas","topLevelFuture":"keep-me","words":{
              "$key":{"status":"learning","lastReview":"2026-01-01T00:00:00Z","FUTURE_FIELD":{"nested":1}}
            },"updatedAt":"2026-01-01T00:00:00Z"}
            """.trimIndent(),
        )
        val store = storeOf(transport)
        val progress = StudyProgress(status = "review", s = 9.0, lastReview = "2026-10-16T10:00:00Z")

        assertTrue(engine.writeSidecar(store, store.remotePathOf(sidecarPath), book, key, progress))

        val written = transport.textOf(sidecarPath)!!
        assertTrue("词条内的未知字段被吃掉：$written", written.contains("FUTURE_FIELD"))
        assertTrue(written.contains("\"nested\":1"))
        assertTrue("顶层未知键被吃掉：$written", written.contains("topLevelFuture"))
        // 进度确实更新了
        assertTrue(written.contains("2026-10-16T10:00:00Z"))
    }

    @Test
    fun writeSidecarReportsFalseWhenPanWriteCannotBeVerified() {
        // engine 承诺「写入后读回校验」。网盘没有 rename，靠 store 的回读长度校验兜底；
        // 这里模拟服务端只存了半截：engine 必须最终返回 false，不能谎报成功。
        val transport = object : MemoryPanTransport() {
            override fun execute(request: HttpRequest): HttpResponse {
                val response = super.execute(request)
                if (request.url.contains("method=upload")) {
                    val target = MemoryPanTransport.parseQuery(java.net.URI(request.url).rawQuery)["path"]!!
                    files[target] = "{}".toByteArray(Charsets.UTF_8)
                }
                return response
            }
        }
        transport.seedFile(canvasPath, canvasJson(textNode("n1", "apple")))
        val store = storeOf(transport)
        val key = StudyKey.canvas(book, "n1")

        assertFalse(
            engine.writeSidecar(
                store,
                store.remotePathOf(sidecarPath),
                book,
                key,
                StudyProgress(status = "review", lastReview = "2026-10-16T10:00:00Z"),
            ),
        )
    }

    @Test
    fun canvasFileIsReadBackByteIdentical() {
        // 红线 2 的另一半：`.canvas` 一字不改。网盘通道只搬运字节，不做任何重写。
        val raw = canvasJson(
            textNode("n1", "apple", color = "4"),
            textNode("n2", "banana"),
        )
        val transport = MemoryPanTransport()
        transport.seedFile(canvasPath, raw)
        val store = storeOf(transport)

        assertEquals(raw, store.readText(store.remotePathOf(canvasPath)))
        assertEquals(raw, transport.textOf(canvasPath))
    }

    // ------------------------------------------------------ 沙箱与凭证

    @Test
    fun wrongUserAgentHitsAntiLeechErrno() {
        // 伪造「忘了带 UA」的情形：服务端返回 31326 防盗链，客户端必须给出可读说明。
        // 用真实存在的目录，避免先撞上 -9 而掩盖了 UA 这一层。
        val transport = MemoryPanTransport()
        transport.dirs.add("/apps/NoteBar")
        transport.dirs.add("/apps/NoteBar/Words")
        val bare = BareTransport(transport).apply { stripUserAgent = true }
        val client = BaiduPanClient(
            initialConfig = BaiduPanSettings(
                enabled = true,
                appKey = "fake-app-key",
                secretKey = "fake-secret-key",
                accessToken = token,
                refreshToken = "fake-refresh-token-1",
                expiresAt = Long.MAX_VALUE,
            ),
            transport = bare,
            nowMs = { 1_763_000_000_000L },
            sleep = { },
        )

        val error = runCatching { client.listDir("/apps/NoteBar/Words") }.exceptionOrNull()
        assertTrue("期望 BaiduPanError，实际 $error", error is BaiduPanError)
        assertTrue(
            "应给出防盗链说明：${error!!.message}",
            error.message!!.contains("防盗链") || error.message!!.contains("31326"),
        )
    }

    @Test
    fun configuredSandboxRootDrivesAllRemotePaths() {
        val transport = MemoryPanTransport(sandboxRoot = "/apps/MyApp")
        val c = client(transport, dir = "MyApp")
        val store = BaiduPanFileStore(c, remoteRoot = c.wordsDir, localRoot = c.wordsDir)

        assertEquals("/apps/MyApp/Words", store.wordsDir)
        assertEquals("/apps/MyApp/Words/AI.canvas", store.remotePathOf("/apps/MyApp/Words/AI.canvas"))
        // 换个目录名后，原来那个 app 的路径必须被沙箱守卫如实拦下（不静默当作"不存在"）
        assertNull(store.readText("/apps/NoteBar/Words/AI.canvas"))
        assertNotNull(store.lastError)
        assertTrue("越界必须出现在错误里：${store.lastError}", store.lastError!!.contains("/apps/"))
    }

    @Test
    fun errorsNeverLeakCredentials() {
        val transport = MemoryPanTransport().apply { forcedErrno = 20012L }
        val store = storeOf(transport)
        assertNull(store.readText(canvasPathForRead()))
        assertNotNull(store.lastError)
        val message = store.lastError!!
        assertFalse("错误信息不得含 access_token：$message", message.contains(token))
        assertFalse("错误信息不得含 appKey：$message", message.contains("fake-app-key"))
    }

    private fun canvasPathForRead(): String = "/apps/NoteBar/Words/英语.canvas"

    /** 故意剥掉 User-Agent 的传输包装，用来复现 31326 防盗链 */
    private class BareTransport(private val inner: MemoryPanTransport) : HttpTransport {
        var stripUserAgent = false
        override fun execute(request: HttpRequest): HttpResponse {
            val headers = if (stripUserAgent) request.headers - "User-Agent" else request.headers
            return inner.execute(request.copy(headers = headers))
        }
    }
}

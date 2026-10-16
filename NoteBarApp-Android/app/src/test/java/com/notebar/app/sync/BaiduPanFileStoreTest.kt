package com.notebar.app.sync

import com.notebar.engine.sync.FileStore
import com.notebar.engine.sync.SyncEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [BaiduPanFileStore] 的端口语义测试：用**内存版网盘**（[MemoryPanTransport]）驱动，
 * 永不触网。
 *
 * 与桌面端 `tests/sync/baidu-pan-provider.test.ts` 的用例语义对照见各类注释；
 * 端到端的「engine 真的能跑通网盘后端」放在 [BaiduPanSyncIntegrationTest]。
 */
class BaiduPanFileStoreTest {

    private val sandboxRoot = "/apps/NoteBar"
    private val wordsDir = "$sandboxRoot/Words"

    private fun client(transport: MemoryPanTransport, dir: String = "NoteBar"): BaiduPanClient =
        BaiduPanClient(
            initialConfig = BaiduPanSettings(
                enabled = true,
                appKey = "fake-app-key",
                secretKey = "fake-secret-key",
                accessToken = "fake-access-token-1",
                refreshToken = "fake-refresh-token-1",
                expiresAt = Long.MAX_VALUE,
                dir = dir,
            ),
            transport = transport,
            nowMs = { 1_763_000_000_000L },
            sleep = { },
        )

    private fun storeOf(
        transport: MemoryPanTransport,
        dir: String = "NoteBar",
    ): Pair<BaiduPanFileStore, BaiduPanClient> {
        val c = client(transport, dir)
        return BaiduPanFileStore(c, remoteRoot = c.wordsDir, localRoot = c.wordsDir) to c
    }

    // ------------------------------------------------------------ 路径映射

    @Test
    fun remotePathMapsCanvasToRootAndSidecarToNestedWordsDir() {
        val (store, _) = storeOf(MemoryPanTransport())
        // 与桌面端 provider 的实际远端布局逐字对齐：
        // canvas → /apps/<dir>/Words/x.canvas；边车 → /apps/<dir>/Words/Words/x.nb-sync.json
        assertEquals("$wordsDir/AI.canvas", store.remotePathOf("$wordsDir/AI.canvas"))
        assertEquals(
            "$wordsDir/Words/AI.nb-sync.json",
            store.remotePathOf("$wordsDir/AI.nb-sync.json"),
        )
        // engine 若按逻辑名（Words/xxx）传进来，也要归一化，不能出现 Words/Words 双层
        assertEquals("$wordsDir/AI.canvas", store.remotePathOf("$wordsDir/Words/AI.canvas"))
    }

    @Test
    fun logicalPrefixIsEmptySoEngineNeverNestsWordsTwice() {
        val (store, _) = storeOf(MemoryPanTransport())
        assertEquals("", store.logicalPrefix)
        // 对照：engine 的启发式探测在空目录上会给出 Words/（这正是本 store 要覆盖它的原因）
        assertEquals("Words/", SyncEngine().logicalPrefixFor(store, wordsDir))
    }

    // ------------------------------------------------------------------ list

    @Test
    fun listMergesCanvasesAndNestedSidecarsIntoSingleView() {
        val transport = MemoryPanTransport()
        transport.seedFile("$wordsDir/AI.canvas", "{}")
        transport.seedFile("$wordsDir/Words/AI.nb-sync.json", "{}")
        val (store, _) = storeOf(transport)

        val entries = store.list(wordsDir)
        assertNotNull(entries)
        // 远端布局：canvas 在 Words/ 下、边车在 Words/Words/ 下，因此列表里会同时出现
        // 嵌套的 Words/ 目录项。engine 只按扩展名挑 .canvas / *.nb-sync.json，会忽略它
        // （与桌面端 `remoteSidecarName()` 的实际落盘位置一致）。
        assertEquals(
            setOf("Words", "AI.canvas", "AI.nb-sync.json"),
            entries!!.map { it.name }.toSet(),
        )
        // 非目录项才是 engine 真正消费的：画布与边车各一个
        val files = entries.filterNot { it.isDirectory }
        assertEquals(setOf("AI.canvas", "AI.nb-sync.json"), files.map { it.name }.toSet())
        val sidecar = files.first { it.name.endsWith(".nb-sync.json") }
        assertTrue(sidecar.size > 0)
        // 网盘 server_mtime 是秒级 → 毫秒
        assertEquals(1691048400000L, sidecar.mtime)
    }

    @Test
    fun listOnFreshSandboxReturnsEmptyRatherThanFailure() {
        // 权益：首次同步时远端除了沙箱根什么都没有。若这里返回 null，engine 会报
        // 「目录权限不可用」把用户吓一跳——但真相只是「还没同步过」。
        val transport = MemoryPanTransport()
        transport.dirs.add(sandboxRoot)
        val (store, _) = storeOf(transport)

        val entries = store.list(wordsDir)
        assertNotNull("同步根不存在时应视为空目录而不是枚举失败", entries)
        assertTrue(entries!!.isEmpty())
    }

    @Test
    fun listReturnsNullWhenOuterSandboxRootIsMissing() {
        // 连沙箱根都不存在（未授权/目录名写错）→ 必须返回 null，让 engine 报权限问题
        val (store, _) = storeOf(MemoryPanTransport())
        assertNull(store.list(wordsDir))
        assertNotNull("失败必须可见", store.lastError)
    }

    @Test
    fun listReportsSandboxEscapeVisibly() {
        val transport = MemoryPanTransport()
        val (store, _) = storeOf(transport)
        // 手工构造一个越界的入参（engine 不会这么传，但端口是公开的）
        val escaping = BaiduPanFileStore(client(transport), remoteRoot = wordsDir, localRoot = "/etc")
        assertNull(escaping.list("/etc"))
        assertNotNull(escaping.lastError)
        assertTrue(escaping.lastError!!.contains("/apps/"))
    }

    // -------------------------------------------------------------- readText

    @Test
    fun readTextReturnsContentForPresentFileAndNullForMissing() {
        val transport = MemoryPanTransport()
        transport.seedFile("$wordsDir/AI.canvas", """{"nodes":[]}""")
        val (store, _) = storeOf(transport)

        assertEquals("""{"nodes":[]}""", store.readText("$wordsDir/AI.canvas"))
        assertNull(store.readText("$wordsDir/missing.canvas"))
        // 文件不存在是正常情况，不该被记成错误
        assertNull(store.lastError)
    }

    @Test
    fun readTextSurfacesRealFailuresInLastError() {
        val transport = MemoryPanTransport()
        transport.seedFile("$wordsDir/AI.canvas", "{}")
        transport.forcedErrno = 20012L // 配额耗尽
        val (store, _) = storeOf(transport)

        assertNull(store.readText("$wordsDir/AI.canvas"))
        assertNotNull("配额失败必须可见", store.lastError)
        assertTrue(store.lastError!!.contains("20012") || store.lastError!!.contains("访问超限"))
    }

    // ------------------------------------------------------------ writeAtomic

    @Test
    fun writeAtomicUploadsThenVerifiesLength() {
        val transport = MemoryPanTransport()
        transport.dirs.add(sandboxRoot)
        val (store, _) = storeOf(transport)

        val text = """{"nodes":[{"id":"n1"}]}"""
        assertTrue(store.writeAtomic("$wordsDir/AI.canvas", text))
        assertEquals(text, transport.textOf("$wordsDir/AI.canvas"))
        // 覆盖写：第二次写更短的内容必须成功（ondup=overwrite）
        assertTrue(store.writeAtomic("$wordsDir/AI.canvas", "{}"))
        assertEquals("{}", transport.textOf("$wordsDir/AI.canvas"))
    }

    @Test
    fun writeAtomicCreatesNestedSidecarDirectoryItself() {
        // engine 的 writeSidecar 直接写边车路径；边车在嵌套的 Words/ 下，必须自动补目录
        val transport = MemoryPanTransport()
        transport.dirs.add(sandboxRoot)
        val (store, _) = storeOf(transport)

        assertTrue(store.writeAtomic("$wordsDir/AI.nb-sync.json", """{"version":1}"""))
        assertEquals("""{"version":1}""", transport.textOf("$wordsDir/Words/AI.nb-sync.json"))
        assertTrue(transport.dirs.contains("$wordsDir/Words"))
    }

    @Test
    fun writeAtomicReturnsFalseWhenServerStoresWrongLength() {
        // 网盘没有 rename，原子性的等价物就是「回读校验」。长度不符必须如实返回 false，
        // 否则 engine 的读回校验会拿到「成功」，坏数据就成了唯一副本。
        val transport = object : MemoryPanTransport() {
            override fun execute(request: HttpRequest): HttpResponse {
                val response = super.execute(request)
                // 上传「成功」但只存了半截（模拟被截断/被并发覆盖）
                if (request.url.contains("method=upload")) {
                    val target = MemoryPanTransport.parseQuery(java.net.URI(request.url).rawQuery)["path"]!!
                    files[target] = "{}".toByteArray(Charsets.UTF_8)
                }
                return response
            }
        }
        transport.dirs.add(sandboxRoot)
        val (store, _) = storeOf(transport)

        assertFalse(store.writeAtomic("$wordsDir/AI.canvas", """{"nodes":[1,2,3,4,5]}"""))
        assertNotNull("写入校验失败必须可见", store.lastError)
        assertTrue(store.lastError!!.contains("校验失败"))
    }

    @Test
    fun writeAtomicReturnsFalseOnSandboxEscape() {
        val transport = MemoryPanTransport()
        val c = client(transport)
        // localRoot 指向沙箱之外的路径，模拟「配置被改成越界目录」
        val store = BaiduPanFileStore(c, remoteRoot = "/apps/OtherApp/Words", localRoot = "/apps/OtherApp/Words")
        assertFalse(store.writeAtomic("/apps/OtherApp/Words/a.canvas", "{}"))
        assertNotNull(store.lastError)
        assertTrue("越界必须明确报出沙箱：${store.lastError}", store.lastError!!.contains("沙箱"))
    }

    // ---------------------------------------------------------------- delete

    @Test
    fun deleteIsIdempotentForMissingFiles() {
        val transport = MemoryPanTransport()
        transport.dirs.add(sandboxRoot)
        transport.dirs.add(wordsDir)
        val (store, _) = storeOf(transport)

        assertTrue("本就不存在的文件：删除算成功（与 LocalFileStore 一致）", store.delete("$wordsDir/none.canvas"))

        transport.seedFile("$wordsDir/AI.canvas", "{}")
        assertTrue(store.delete("$wordsDir/AI.canvas"))
        assertNull(transport.textOf("$wordsDir/AI.canvas"))
    }

    // ----------------------------------------------------------------- exists

    @Test
    fun existsDistinguishesPresentFromMissingAndDir() {
        val transport = MemoryPanTransport()
        transport.dirs.add(sandboxRoot)
        transport.dirs.add(wordsDir)
        transport.seedFile("$wordsDir/AI.canvas", "{}")
        val (store, _) = storeOf(transport)

        assertTrue(store.exists("$wordsDir/AI.canvas"))
        assertTrue(store.exists(wordsDir))
        assertFalse(store.exists("$wordsDir/none.canvas"))
        assertNull(store.lastError)
    }

    // ------------------------------------------------ 与 LocalFileStore 的语义对照

    @Test
    fun portSemanticsMatchLocalFileStore() {
        // 两个实现必须满足同一组端口契约，否则 SyncEngine 的行为会随后端漂移
        val transport = MemoryPanTransport()
        transport.dirs.add(sandboxRoot)
        transport.dirs.add(wordsDir)
        val (remote, _) = storeOf(transport)
        val remoteLocal = LocalFileStore()
        val tempDir = kotlin.io.path.createTempDirectory("notebar-pan-parity").toFile()
        try {
            val remotePath = "$wordsDir/parity.canvas"
            val localPath = java.io.File(tempDir, "parity.canvas").absolutePath
            assertParity(remote, remoteLocal, remotePath, localPath, "ABCDEF")
            assertParity(remote, remoteLocal, remotePath, localPath, "A") // 覆盖写更短内容
        } finally {
            tempDir.deleteRecursively()
        }
    }

    private fun assertParity(
        remote: FileStore,
        local: FileStore,
        remotePath: String,
        localPath: String,
        content: String,
    ) {
        assertEquals(local.writeAtomic(localPath, content), remote.writeAtomic(remotePath, content))
        assertEquals(local.readText(localPath), remote.readText(remotePath))
        assertEquals(local.exists(localPath), remote.exists(remotePath))
        assertNull(remote.readText("$remotePath.missing"))
        assertNull(local.readText("$localPath.missing"))
    }
}

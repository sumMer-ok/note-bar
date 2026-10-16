package com.notebar.app.sync

import com.notebar.engine.sync.SyncEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 后端选择：**百度网盘优先，本地目录兜底**。
 *
 * 重点是「兜底必须可见」——配置不全时静默用本地目录，用户会以为数据已经在云端，
 * 这类静默降级正是桌面端 `reportError` 三通道（console + Notice + 失败日志）要防的事。
 */
class SyncBackendSelectorTest {

    private val localRoot = "/data/user/0/com.notebar.app/files/NoteBar"

    private fun pan(
        enabled: Boolean,
        appKey: String = "fake-app-key",
        secretKey: String = "fake-secret-key",
        dir: String = "NoteBar",
    ) = BaiduPanSettings(
        enabled = enabled,
        appKey = appKey,
        secretKey = secretKey,
        dir = dir,
    )

    private fun selectorNoNetwork() = { config: BaiduPanSettings ->
        // 注入假传输，确保单测**永不触网**（选择过程本身不该发请求，这里顺手证明这一点）
        BaiduPanClient(config, transport = ScriptedTransport(listOf(ScriptedTransport.json("{}"))))
    }

    @Test
    fun disabledFallsBackToLocalDirectory() {
        val choice = SyncBackendSelector.select(pan(enabled = false), localRoot, selectorNoNetwork())
        assertFalse(choice.isRemote)
        assertTrue(choice.store is LocalFileStore)
        assertEquals(localRoot, choice.root)
        assertNull("未启用网盘不该弹提示", choice.notice)
        assertNull(choice.logicalPrefix)
    }

    @Test
    fun enabledWithFullCredentialsUsesPanBackend() {
        val choice = SyncBackendSelector.select(pan(enabled = true), localRoot, selectorNoNetwork())
        assertTrue(choice.isRemote)
        assertTrue(choice.store is BaiduPanFileStore)
        // root 由后端自己给（远端同步根），不再是本地目录
        assertEquals("/apps/NoteBar/Words", choice.root)
        assertEquals(BaiduPanFileStore.LOGICAL_PREFIX, choice.logicalPrefix)
        assertNull(choice.notice)
    }

    @Test
    fun enabledWithoutAppKeyFallsBackVisibly() {
        val choice = SyncBackendSelector.select(
            pan(enabled = true, appKey = ""),
            localRoot,
            selectorNoNetwork(),
        )
        assertFalse(choice.isRemote)
        assertTrue(choice.store is LocalFileStore)
        assertEquals(localRoot, choice.root)
        assertNotNull("配置不全必须给出可见提示，不得静默降级", choice.notice)
        assertTrue(choice.notice!!.contains("AppKey"))
    }

    @Test
    fun enabledWithoutSecretKeyFallsBackVisibly() {
        val choice = SyncBackendSelector.select(
            pan(enabled = true, secretKey = ""),
            localRoot,
            selectorNoNetwork(),
        )
        assertFalse(choice.isRemote)
        assertNotNull(choice.notice)
    }

    @Test
    fun customDirDrivesRemoteRoot() {
        val choice = SyncBackendSelector.select(
            pan(enabled = true, dir = "MyApp"),
            localRoot,
            selectorNoNetwork(),
        )
        assertTrue(choice.isRemote)
        assertEquals("/apps/MyApp/Words", choice.root)
    }

    @Test
    fun blankLocalRootIsToleratedWhenPanIsUsed() {
        // 网盘后端不依赖本地目录；本地同步根为空也照样能用
        val choice = SyncBackendSelector.select(pan(enabled = true), null, selectorNoNetwork())
        assertTrue(choice.isRemote)
        assertEquals("/apps/NoteBar/Words", choice.root)
    }

    @Test
    fun localFallbackKeepsNullRootWhenNothingConfigured() {
        val choice = SyncBackendSelector.select(pan(enabled = false), null, selectorNoNetwork())
        assertFalse(choice.isRemote)
        assertNull(choice.root)
    }

    @Test
    fun selectingPanBackendSendsNoRequest() {
        // 选后端是纯本地决策；若它偷偷发请求，设置页每次改动都会吃配额
        val transport = ScriptedTransport(listOf(ScriptedTransport.json("{}")))
        val choice = SyncBackendSelector.select(pan(enabled = true), localRoot) { config ->
            BaiduPanClient(config, transport = transport)
        }
        assertTrue(choice.isRemote)
        assertEquals("选择后端不该发任何请求", 0, transport.requests.size)
    }

    @Test
    fun remoteBackendDeclaresEmptyLogicalPrefix() {
        // engine 的启发式探测在空远端上会给出 Words/，导致物理路径多一层；
        // 后端必须显式声明空前缀，这正是在网盘上「首扫与后续扫路径一致」的前提。
        val choice = SyncBackendSelector.select(pan(enabled = true), localRoot, selectorNoNetwork())
        val store = choice.store as BaiduPanFileStore
        assertEquals("", choice.logicalPrefix)
        assertEquals("", store.logicalPrefix)
        // 对照：engine 自己的探测会给出 Words/
        assertEquals("Words/", SyncEngine().logicalPrefixFor(store, store.wordsDir))
    }
}

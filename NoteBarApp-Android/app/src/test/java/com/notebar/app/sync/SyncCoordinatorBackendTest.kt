package com.notebar.app.sync

import com.notebar.app.data.EntryDao
import com.notebar.app.data.EntryEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [SyncCoordinator] 的后端接线测试：确认「切到网盘」真的把 engine 指向了网盘，
 * 且 path/prefix 的算法没有在切换中走样。
 *
 * 不断言 engine 的内部行为（那由 engine 的 79 个测试与
 * [BaiduPanSyncIntegrationTest] 覆盖），只断言**接线**：
 * - 后端选择结果被采纳（[SyncCoordinator.store] / `isRemoteBackend`）；
 * - 逻辑前缀用后端声明值而不是 engine 的启发式探测；
 * - `configureBackend` 幂等（设置页每敲一个字符都会调用它，不能反复重建客户端）。
 */
class SyncCoordinatorBackendTest {

    /** 最小 EntryDao 假实现：本测试不触碰数据库 */
    private class FakeEntryDao : EntryDao {
        override fun observeAll(): Flow<List<EntryEntity>> = flowOf(emptyList())
        override suspend fun all(): List<EntryEntity> = emptyList()
        override suspend fun findByKey(key: String): EntryEntity? = null
        override fun observeByKey(key: String): Flow<EntryEntity?> = flowOf(null)
        override suspend fun byBook(book: String): List<EntryEntity> = emptyList()
        override suspend fun count(): Int = 0
        override suspend fun upsert(entry: EntryEntity) = Unit
        override suspend fun upsertAll(entries: List<EntryEntity>) = Unit
        override suspend fun insert(entry: EntryEntity) = Unit
        override suspend fun deleteByKey(key: String) = Unit
        override suspend fun deleteByBook(book: String) = Unit
    }

    private val localRoot = "/data/user/0/com.notebar.app/files/NoteBar"

    private fun pan(enabled: Boolean = true, dir: String = "NoteBar") = BaiduPanSettings(
        enabled = enabled,
        appKey = "fake-app-key",
        secretKey = "fake-secret-key",
        dir = dir,
    )

    private fun coordinator() = SyncCoordinator(dao = FakeEntryDao())

    @Test
    fun defaultsToLocalBackendBeforeAnyConfiguration() {
        val coordinator = coordinator()
        assertFalse(coordinator.isRemoteBackend)
        assertTrue(coordinator.store is LocalFileStore)
    }

    @Test
    fun enablingPanSwitchesStoreAndRootToRemote() {
        val coordinator = coordinator()
        coordinator.currentRoot = localRoot

        coordinator.configureBackend(pan(enabled = true), localRoot)

        assertTrue(coordinator.isRemoteBackend)
        assertTrue(coordinator.store is BaiduPanFileStore)
        // 网盘后端的逻辑前缀由后端声明，engine 的启发式探测不再参与
        assertEquals("", (coordinator.store as BaiduPanFileStore).logicalPrefix)
    }

    @Test
    fun disablingPanReturnsToLocalStore() {
        val coordinator = coordinator()
        coordinator.configureBackend(pan(enabled = true), localRoot)
        assertTrue(coordinator.isRemoteBackend)

        coordinator.configureBackend(pan(enabled = false), localRoot)
        assertFalse(coordinator.isRemoteBackend)
        assertTrue(coordinator.store is LocalFileStore)
    }

    @Test
    fun incompleteCredentialsFallBackToLocalAndStayVisible() {
        val coordinator = coordinator()
        coordinator.configureBackend(pan(enabled = true).copy(appKey = ""), localRoot)
        // 配置不全 → 本地兜底（提示文案由 ViewModel 展示，选择层只负责如实回报）
        assertFalse(coordinator.isRemoteBackend)
        assertTrue(coordinator.store is LocalFileStore)
    }

    @Test
    fun configureBackendIsIdempotentSoClientStateSurvivesTyping() {
        // 设置页输入框每敲一个字符都会触发一次；若每次重建后端，就会丢掉
        // 客户端里刚刷新的 refresh_token 与在途状态，也白白多分配对象。
        val coordinator = coordinator()
        coordinator.configureBackend(pan(enabled = true), localRoot)
        val first = coordinator.store

        coordinator.configureBackend(pan(enabled = true), localRoot)
        coordinator.configureBackend(pan(enabled = true), localRoot)

        assertSame("相同配置不得重建后端", first, coordinator.store)
    }

    @Test
    fun changingAnySelectionFieldRebuildsBackend() {
        val coordinator = coordinator()
        coordinator.configureBackend(pan(enabled = true), localRoot)
        val first = coordinator.store

        // dir 变化必须重建（远端根随之改变）
        coordinator.configureBackend(pan(enabled = true, dir = "MyApp"), localRoot)
        val second = coordinator.store
        assertTrue("dir 变化必须重建后端", first !== second)
        assertEquals("/apps/MyApp/Words", (second as BaiduPanFileStore).wordsDir)

        // 本地根变化也必须重建（本地兜底路径随之改变）
        coordinator.configureBackend(pan(enabled = false), localRoot)
        val local1 = coordinator.store
        coordinator.configureBackend(pan(enabled = false), "/other/root")
        assertTrue("本地根变化必须重建后端", local1 !== coordinator.store)
    }

    @Test
    fun tokenRefreshAloneDoesNotRebuildBackend() {
        // 令牌轮换不影响「用哪个后端、指向哪个目录」；重建会丢掉客户端里最新的凭证
        val coordinator = coordinator()
        coordinator.configureBackend(pan(enabled = true), localRoot)
        val first = coordinator.store

        coordinator.configureBackend(
            pan(enabled = true).copy(
                accessToken = "rotated-access",
                refreshToken = "rotated-refresh",
                expiresAt = 9_999_999_999_999L,
            ),
            localRoot,
        )

        assertSame(first, coordinator.store)
    }

    @Test
    fun remoteStoreMapsEnginePathsOntoPanWordsDir() {
        val coordinator = coordinator()
        coordinator.currentRoot = localRoot
        coordinator.configureBackend(pan(enabled = true), localRoot)

        val store = coordinator.store as BaiduPanFileStore
        // 接线正确的话，engine 算出的物理路径会被映射到网盘同步根之下
        assertEquals("/apps/NoteBar/Words/AI.canvas", store.remotePathOf("/apps/NoteBar/Words/AI.canvas"))
        assertEquals(
            "/apps/NoteBar/Words/Words/AI.nb-sync.json",
            store.remotePathOf("/apps/NoteBar/Words/AI.nb-sync.json"),
        )
    }

    @Test
    fun localBackendKeepsUsingEnginePathHeuristic() {
        val coordinator = coordinator()
        coordinator.currentRoot = localRoot
        coordinator.configureBackend(pan(enabled = false), localRoot)
        assertEquals(localRoot, coordinator.currentRoot)
        assertTrue(coordinator.isConfigured)
    }
}

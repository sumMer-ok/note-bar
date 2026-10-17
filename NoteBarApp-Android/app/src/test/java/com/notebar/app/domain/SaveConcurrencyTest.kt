package com.notebar.app.domain

import com.notebar.app.data.DefinitionModule
import com.notebar.app.data.EntryDao
import com.notebar.app.data.EntryEntity
import com.notebar.app.sync.MemoryFileStore
import com.notebar.app.sync.SyncBackendChoice
import com.notebar.app.sync.SyncCoordinator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 编辑保存与轮询扫描**互斥**，否则扫描会用「保存前」的磁盘快照覆盖刚写的新释义
 * （真机 2026-10-18 症状：点了保存、AI 释义没固化，界面回到原样）。
 */
class SaveConcurrencyTest {

    private class FakeDao(rows: List<EntryEntity> = emptyList()) : EntryDao {
        val table = LinkedHashMap<String, EntryEntity>().apply { rows.forEach { put(it.studyKey, it) } }

        /** 扫描读到 Room 时挂住，让测试能精确制造「扫描进行中」的窗口 */
        var gate: CompletableDeferred<Unit>? = null

        override fun observeAll(): Flow<List<EntryEntity>> = flowOf(table.values.toList())
        override suspend fun all(): List<EntryEntity> = table.values.toList()
        override suspend fun findByKey(key: String): EntryEntity? = table[key]
        override fun observeByKey(key: String): Flow<EntryEntity?> = flowOf(table[key])
        override suspend fun byBook(book: String): List<EntryEntity> {
            gate?.await()
            return table.values.filter { it.book == book }
        }
        override suspend fun count(): Int = table.size
        override suspend fun upsert(entry: EntryEntity) { table[entry.studyKey] = entry }
        override suspend fun upsertAll(entries: List<EntryEntity>) { entries.forEach { table[it.studyKey] = it } }
        override suspend fun insert(entry: EntryEntity) { table[entry.studyKey] = entry }
        override suspend fun deleteByKey(key: String) { table.remove(key) }
        override suspend fun deleteByBook(book: String) { table.entries.removeAll { it.value.book == book } }
    }

    private val book = "Probe.canvas"
    private val oldDef = "1. adj. 部长的（旧）"
    private val newDef = "1. adj. 部长的\n\n--- AI 释义 ---\n1）n. 部长级人物"

    private fun canvasText(definition: String) =
        """{"nodes":[{"id":"n1","type":"text","text":"ministerial\n\n$definition","x":0,"y":0,"width":200,"height":60}]}"""

    private fun newStore(def: String) = MemoryFileStore().apply { files["/sync/$book"] = canvasText(def) }

    @Test
    fun saveWaitsForScanAndSurvives() = runBlocking {
        val store = newStore(oldDef)
        val dao = FakeDao()
        val coord = SyncCoordinator(dao, SyncBackendChoice(store, "/sync", "", false, null))

        // 先把词条读进 Room（此时没有 gate，扫描直接跑完）
        coord.scan("/sync")
        val key = dao.table.keys.single()
        assertEquals("扫描后应写入原释义", oldDef, dao.table[key]!!.definition)
        val entry = com.notebar.app.data.EntryCodec.toEntry(dao.table[key]!!)

        // 让扫描**真的**重新处理这个词库：mtime 闸门是「canvas 与 sidecar 的 mtime 都没变 → 跳过」，
        // 必须改文件长度（MemoryFileStore 用文本长度当 mtime），否则第二轮扫描根本不会读 Room。
        store.files["/sync/$book"] = """{"nodes":[
            {"id":"n1","type":"text","text":"ministerial\n\n$oldDef","x":0,"y":0,"width":200,"height":60},
            {"id":"n2","type":"text","text":"unrelated","x":0,"y":80,"width":200,"height":60}
        ]}"""

        // 让下一次扫描在「读完磁盘快照、正要读 Room」处停住
        val gate = CompletableDeferred<Unit>()
        dao.gate = gate
        val scanning = async(Dispatchers.Default) { coord.scan("/sync") }

        // 扫描持有锁时发起保存：必须在锁上等待，不能插进扫描中间
        val saving = async(Dispatchers.Default) {
            saveThroughViewModelLike(coord, dao, entry, newDef)
        }

        // 给保存一点时间试图抢跑；它应当仍在等锁（Room 未变）
        Thread.sleep(200)
        assertEquals("扫描未结束前保存不得落库", oldDef, dao.table[key]!!.definition)

        dao.gate = null
        gate.complete(Unit)
        withTimeout(10_000) { scanning.await() }
        withTimeout(10_000) { saving.await() }

        println("== afterConcurrent.definition='${dao.table[key]!!.definition}'")
        assertEquals("保存的新释义必须存活", newDef, dao.table[key]!!.definition)
        assertTrue("画布也必须带上新释义", store.files["/sync/$book"]!!.contains("AI 释义"))
    }

    /**
     * 复刻 [com.notebar.app.ui.AppViewModel.saveWordEdit] 的读-改-写序列，
     * 但只依赖 [SyncCoordinator.exclusive]，这样单测不需要 Android 的 Room/Application。
     */
    private suspend fun saveThroughViewModelLike(
        coord: SyncCoordinator,
        dao: FakeDao,
        original: com.notebar.engine.Entry,
        definition: String,
    ) {
        coord.exclusive {
            val updated = original.copy(
                definition = definition,
                localEditedAt = "2026-10-18T00:00:00Z",
            )
            dao.upsert(com.notebar.app.data.EntryCodec.toEntity(updated))
            val canvas = coord.readCanvas(original.book)
            if (canvas != null) {
                val next = com.notebar.engine.CanvasEditor.updateWord(
                    canvas, original.nodeId, updated.word, definition, updated.aliases,
                )
                if (next != null && coord.writeCanvas(original.book, next)) {
                    dao.upsert(com.notebar.app.data.EntryCodec.toEntity(updated.copy(localEditedAt = null)))
                }
            }
        }
    }

    /**
     * 只钉「不被覆盖」这一条语义：扫描已读到旧快照时，期间完成的保存结果必须活下来。
     *
     * 与 [saveWaitsForScanAndSurvives] 的区别：这条不做「保存必须等」的中间断言，
     * 因此即使把互斥去掉，它也会在**最终断言**上变红 —— 直接对应用户看到的症状。
     */
    @Test
    fun scanMustNotClobberNewerSave() = runBlocking {
        val store = newStore(oldDef)
        val dao = FakeDao()
        val coord = SyncCoordinator(dao, SyncBackendChoice(store, "/sync", "", false, null))
        coord.scan("/sync")
        val key = dao.table.keys.single()
        val entry = com.notebar.app.data.EntryCodec.toEntry(dao.table[key]!!)

        // 触发一次真正会重扫的 mtime 变化，然后卡在「读完快照、正要读 Room」
        store.files["/sync/$book"] = canvasText(oldDef) + " "
        val gate = CompletableDeferred<Unit>()
        dao.gate = gate
        val scanning = async(Dispatchers.Default) { coord.scan("/sync") }

        val saving = async(Dispatchers.Default) {
            saveThroughViewModelLike(coord, dao, entry, newDef)
        }

        // 宁可让保存先跑完也不要漏掉窗口：稍等后放行扫描
        Thread.sleep(100)
        dao.gate = null
        gate.complete(Unit)
        withTimeout(10_000) { scanning.await() }
        withTimeout(10_000) { saving.await() }

        println("== clobberCheck.definition='${dao.table[key]?.definition}'")
        assertEquals("扫描不得用旧快照覆盖已保存的新释义", newDef, dao.table[key]!!.definition)
    }

    @Test
    fun scanDoesNotReviveDeletedWord() = runBlocking {
        val store = newStore(oldDef)
        val dao = FakeDao()
        val coord = SyncCoordinator(dao, SyncBackendChoice(store, "/sync", "", false, null))
        coord.scan("/sync")
        val key = dao.table.keys.single()
        val entry = com.notebar.app.data.EntryCodec.toEntry(dao.table[key]!!)

        coord.exclusive {
            dao.deleteByKey(entry.studyKey)
            val canvas = coord.readCanvas(entry.book)
            if (canvas != null) {
                com.notebar.engine.CanvasEditor.deleteWord(canvas, entry.nodeId)
                    ?.let { coord.writeCanvas(entry.book, it) }
            }
        }
        coord.scan("/sync")
        assertTrue("删掉的词不得被扫描复活", dao.table.isEmpty())
    }
}

package com.notebar.app.sync

import com.notebar.app.data.EntryCodec
import com.notebar.app.data.EntryDao
import com.notebar.app.data.EntryEntity
import com.notebar.engine.CanvasEditor
import com.notebar.engine.Entry
import com.notebar.engine.StudyKey
import com.notebar.engine.StudyProgress
import com.notebar.engine.sync.FileStore
import com.notebar.engine.sync.SyncConflict
import com.notebar.engine.sync.SyncEngine
import com.notebar.engine.sync.SyncScanResult
import com.notebar.engine.sync.SyncStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/**
 * 同步编排：把纯逻辑的 [SyncEngine] 接到 Room 表与真实 [FileStore] 上。
 *
 * 对应 iOS `SyncService` 的职责划分：
 * - 文件层与合并判定全在 engine（[SyncEngine.scan] / [applyRemote] / [writeSidecar]）；
 * - 本类只负责「读/写 Room」「算物理路径」「回推本地未上传编辑」「清词库」这些宿主动作。
 *
 * 红线 2：`.canvas` 与 `.nb-sync.json` 一字不改；Room 只是本地缓存，
 * 同步时**一律**用 [SyncEngine.applyRemote]（内部走 `Merge.progress`）决定进度归属，
 * 绝不让 Room 覆盖文件里更新的进度。
 *
 * Phase 4b：后端（百度网盘 / 本地目录）由 [configureBackend] 注入的选择结果决定，
 * 本类不再硬编码 [LocalFileStore]。**后端仍在运行时向 engine 索要物理路径**，
 * 所有路径换算继续复用 `SyncEngine.physicalPath`（单一真相），本类只把
 * [SyncBackendChoice.logicalPrefix] 覆盖掉探测结果。
 */
class SyncCoordinator(
    private val dao: EntryDao,
    private var backend: SyncBackendChoice = SyncBackendSelector.select(BaiduPanSettings(), null),
    private val engine: SyncEngine = SyncEngine(),
) {

    /** 当前后端使用的 [FileStore]（本地或网盘） */
    val store: FileStore get() = backend.store

    /** true = 当前走百度网盘通道 */
    val isRemoteBackend: Boolean get() = backend.isRemote

    /** 已应用的后端选择（用来做幂等判断，见 [configureBackend]） */
    private var appliedBackendKey: String? = null

    /**
     * 切换后端（设置页改动网盘开关 / 凭证后调用）。
     *
     * **幂等**：设置页每敲一个字符都会调到这里；若每次都重建客户端，就会把
     * 「刷新后暂存的新 refresh_token」与在途状态一起丢掉，也白白多分配对象。
     * 只有影响选择的字段（enabled / 凭证 / dir / 本地根）真的变了才重选。
     *
     * @param root 本地同步根；网盘配置齐全时会被后端自己的远端根取代
     */
    fun configureBackend(pan: BaiduPanSettings, localRoot: String?) {
        val key = listOf(
            pan.enabled.toString(),
            pan.appKey,
            pan.secretKey,
            pan.dir,
            localRoot.orEmpty(),
        ).joinToString("\u0000")
        if (key == appliedBackendKey) return

        backend = SyncBackendSelector.select(pan, localRoot)
        appliedBackendKey = key
    }

    /** 最近一次扫描结果（UI 用来展示冲突列表） */
    @Volatile
    var lastConflicts: List<SyncConflict> = emptyList()
        private set

    /** 最近一次扫描状态文案 */
    @Volatile
    var lastStatus: String = "未连接"
        private set

    /**
     * 当前后端声明的逻辑前缀；null 表示交给 engine 的启发式探测。
     *
     * 为什么需要覆盖：engine 的 `logicalPrefixFor` 用「目录里有没有 `.canvas`」判断，
     * 而网盘同步根在首次同步时是空的 → 会被误判成 `Words/`，物理路径多出一层。
     * 网盘布局是已知的，因此由后端自己声明（见 [BaiduPanFileStore.LOGICAL_PREFIX]）。
     */
    private fun resolvePrefix(root: String): String =
        backend.logicalPrefix ?: engine.logicalPrefixFor(store, root)

    /**
     * 全量扫描 + 词条合并。对应 iOS `SyncService.scan()`。
     *
     * @param root 同步目录（可为 null，表示还没选目录）
     * @return 本次扫描的状态文案（与 iOS 的 `onStatusChanged` 文案逐字一致）
     */
    suspend fun scan(root: String?): String = withContext(Dispatchers.IO) {
        val effectiveRoot = backend.root ?: root
        if (effectiveRoot.isNullOrBlank()) {
            lastStatus = SyncStatus.MISSING_DIRECTORY
            return@withContext lastStatus
        }

        val prefix = resolvePrefix(effectiveRoot)
        val result: SyncScanResult = engine.scan(store, effectiveRoot, prefix)

        if (result.status.message == SyncStatus.SCAN_FAILED) {
            lastStatus = SyncStatus.SCAN_FAILED
            return@withContext lastStatus
        }

        lastConflicts = result.conflicts

        var changed = false
        val pendingPush = ArrayList<Entry>()

        for (snapshot in result.changed) {
            val entriesByKey = dao.byBook(snapshot.relative).associateBy { it.studyKey }
            for (word in snapshot.words) {
                val key = StudyKey.canvas(snapshot.relative, word.nodeId)
                val existing = entriesByKey[key]
                val applied = engine.applyRemote(
                    entry = existing?.let { EntryCodec.toEntry(it) },
                    word = word,
                    relative = snapshot.relative,
                    remoteProgress = snapshot.progress[key],
                )
                val row = EntryCodec.toEntity(applied.entry)
                if (row != existing) {
                    dao.upsert(row)
                    changed = true
                }
                if (applied.pendingPush) pendingPush.add(applied.entry)
            }
        }

        // 清理「词库」列表：只保留本次扫描实际存在的词库（仅在扫描到词库时执行）
        val currentBooks = result.currentBooks
        if (currentBooks.isNotEmpty()) {
            val all = dao.all()
            val keep = engine.pruneMissingBooks(all.map { EntryCodec.toEntry(it) }, currentBooks)
            val keepKeys = keep.map { it.studyKey }.toSet()
            for (row in all) {
                if (!keepKeys.contains(row.studyKey)) {
                    dao.deleteByKey(row.studyKey)
                    changed = true
                }
            }
        }

        for (entry in pendingPush) {
            pushLocalEntry(entry)
        }

        lastStatus = result.status.message
        lastStatus
    }

    /**
     * 把本地未上传的单词编辑回推云端。对应 iOS `SyncService.pushLocalEntry`：
     * 读 canvas → `CanvasEditor.updateWord` → 原子写 → 成功后清 `localEditedAt`。
     */
    suspend fun pushLocalEntry(entry: Entry): Boolean = withContext(Dispatchers.IO) {
        val root = effectiveRoot() ?: return@withContext false
        val prefix = resolvePrefix(root)
        val canvasPath = engine.physicalPath(
            root = root,
            logicalPrefix = prefix,
            logical = entry.book,
            suffix = "",
            replacingExtension = null,
        )
        val text = store.readText(canvasPath) ?: return@withContext false
        val rootObj = runCatching {
            com.notebar.engine.NoteBarJson.instance.parseToJsonElement(text).let { it as JsonObject }
        }.getOrNull() ?: return@withContext false

        val updated = CanvasEditor.updateWord(
            root = rootObj,
            nodeId = entry.nodeId,
            word = entry.word,
            definition = entry.definition,
            aliases = entry.aliases,
        ) ?: return@withContext false

        val encoded = com.notebar.engine.NoteBarJson.instance.encodeToString(JsonObject.serializer(), updated)
        if (!store.writeAtomic(canvasPath, encoded)) return@withContext false

        dao.findByKey(entry.studyKey)?.let { row ->
            dao.upsert(row.copy(localEditedAt = null))
        }
        true
    }

    /**
     * 评分后写回边车。对应 iOS `SyncService.persist(book:key:progress:)`，
     * 直接复用 engine 的 [SyncEngine.writeSidecar]（含读回校验与一次重试）。
     *
     * @return true = 已成功写回；false = 写失败或没配同步目录（UI 提示对应文案）
     */
    suspend fun persist(book: String, key: String, progress: StudyProgress): Boolean =
        withContext(Dispatchers.IO) {
            val root = effectiveRoot() ?: return@withContext false
            val prefix = resolvePrefix(root)
            val path = engine.physicalPath(
                root = root,
                logicalPrefix = prefix,
                logical = book,
                suffix = SyncEngine.SIDECAR_SUFFIX,
                replacingExtension = ".canvas",
            )
            engine.writeSidecar(store, path, book, key, progress)
        }

    /** 读取 Canvas JSON。对应 iOS `SyncService.readCanvas(_:)` */
    suspend fun readCanvas(relative: String): JsonObject? = withContext(Dispatchers.IO) {
        val root = effectiveRoot() ?: return@withContext null
        val prefix = resolvePrefix(root)
        val path = engine.physicalPath(root, prefix, relative, "", null)
        val text = store.readText(path) ?: return@withContext null
        runCatching { com.notebar.engine.NoteBarJson.instance.parseToJsonElement(text) as JsonObject }
            .getOrNull()
    }

    /** 写回 Canvas JSON。对应 iOS `SyncService.writeCanvas(_:data:)` */
    suspend fun writeCanvas(relative: String, data: JsonObject): Boolean = withContext(Dispatchers.IO) {
        val root = effectiveRoot() ?: return@withContext false
        val prefix = resolvePrefix(root)
        val path = engine.physicalPath(root, prefix, relative, "", null)
        val encoded = com.notebar.engine.NoteBarJson.instance.encodeToString(JsonObject.serializer(), data)
        val ok = store.writeAtomic(path, encoded)
        if (!ok) lastStatus = SyncStatus.PROGRESS_PATH_UNAVAILABLE
        ok
    }

    /** 冲突仲裁。对应 iOS `SyncService.resolve(_:keepCopy:)` */
    suspend fun resolveConflict(conflict: SyncConflict, keepCopy: Boolean): Boolean =
        withContext(Dispatchers.IO) {
            val ok = engine.resolveConflict(store, conflict, keepCopy)
            lastConflicts = lastConflicts.filterNot { it.id == conflict.id }
            ok
        }

    /**
     * 删除词库：先清本地词条，再删云端的 Canvas 与边车。
     * 对应 iOS `SyncService.deleteBook(_:)`。
     */
    suspend fun deleteBook(book: String): Boolean = withContext(Dispatchers.IO) {
        dao.deleteByBook(book)
        engine.forgetMtime(book)

        val root = effectiveRoot() ?: return@withContext false
        val prefix = resolvePrefix(root)
        val canvasPath = engine.physicalPath(root, prefix, book, "", null)
        val sidecarPath = engine.physicalPath(root, prefix, book, SyncEngine.SIDECAR_SUFFIX, ".canvas")
        var removed = true
        for (path in listOf(canvasPath, sidecarPath)) {
            if (store.exists(path) && !store.delete(path)) removed = false
        }
        removed
    }

    /** 当前同步目录（由调用方在设置变化时写入）；网盘后端下由后端自己决定 */
    @Volatile
    var currentRoot: String? = null

    /** 实际生效的同步根：网盘后端优先用自己的远端根，否则用 [currentRoot] */
    private fun effectiveRoot(): String? = backend.root ?: currentRoot

    /** 供 UI 判断是否已配置目录 */
    val isConfigured: Boolean get() = !effectiveRoot().isNullOrBlank()

    /** 便捷：把 engine 的词条映射成数据库行（供外部测试与 UI 复用） */
    fun toRow(entry: Entry): EntryEntity = EntryCodec.toEntity(entry)
}

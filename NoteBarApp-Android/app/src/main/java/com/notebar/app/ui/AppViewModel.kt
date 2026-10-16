package com.notebar.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import com.notebar.app.data.EntryCodec
import com.notebar.app.data.EntryEntity
import com.notebar.app.data.NoteBarDatabase
import com.notebar.app.data.Settings
import com.notebar.app.data.SettingsRepository
import com.notebar.app.domain.RatingOutcome
import com.notebar.app.domain.ReviewEngine
import com.notebar.app.domain.ReviewDirection
import com.notebar.app.domain.DefinitionSections
import com.notebar.engine.CanvasEditor
import com.notebar.engine.Entry
import com.notebar.engine.FSRS
import com.notebar.engine.ReinforceDraft
import com.notebar.engine.ReinforceSession
import com.notebar.engine.sync.SyncConflict
import com.notebar.app.sync.SyncCoordinator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 应用状态持有者。对应 iOS `AppState` + 各视图对 SwiftData 的查询。
 *
 * 职责边界：
 * - 设置 / 强化草稿 / 同步目录 → [SettingsRepository]（DataStore）
 * - 词条 → Room（本地缓存，source of truth 是同步目录里的 .canvas / .nb-sync.json）
 * - 评分落库后立即调 [SyncCoordinator.persist] 写回边车（对应 iOS `appState.sync.persist`）
 */
class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val db: NoteBarDatabase = Room.databaseBuilder(
        app,
        NoteBarDatabase::class.java,
        NoteBarDatabase.NAME,
    ).build()

    private val dao = db.entryDao()
    private val settingsRepo = SettingsRepository(app)
    private val sync = SyncCoordinator(dao)

    /** 词条流（Room 实时查询）；UI 从这里取全部词条再做纯逻辑筛选 */
    val entries: StateFlow<List<Entry>> = dao.observeAll()
        .combine(MutableStateFlow(Unit)) { rows, _ -> rows.map { EntryCodec.toEntry(it) } }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** 原始行流（编辑时需要拿到行对象写回） */
    val entryRows: StateFlow<List<EntryEntity>> = dao.observeAll()
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val settings: StateFlow<Settings> = settingsRepo.settings
        .stateIn(viewModelScope, SharingStarted.Eagerly, Settings())

    val reinforceDraft: StateFlow<ReinforceDraft?> = settingsRepo.reinforceDraft
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _syncStatus = MutableStateFlow("未连接")
    val syncStatus: StateFlow<String> = _syncStatus.asStateFlow()

    private val _conflicts = MutableStateFlow<List<SyncConflict>>(emptyList())
    val conflicts: StateFlow<List<SyncConflict>> = _conflicts.asStateFlow()

    /** 当前实际使用的同步根目录（未显式配置时是 app 私有目录） */
    private val _syncRootPath = MutableStateFlow<String?>(null)
    val syncRootPath: StateFlow<String?> = _syncRootPath.asStateFlow()

    private var syncTimer: Job? = null

    init {
        viewModelScope.launch {
            // 恢复上次配置的同步目录并开启定时扫描（对应 iOS `sync.start()` 的 15s 轮询）
            val configured = settingsRepo.syncRoot.first()
            sync.currentRoot = resolveRoot(configured)
            _syncRootPath.value = sync.currentRoot
            startSyncLoop()
        }
    }

    /** 同步目录解析：优先用户显式配置的目录，否则回落到 app 私有目录（保证开箱可用） */
    private fun resolveRoot(configured: String?): String? {
        if (!configured.isNullOrBlank()) return configured
        // 未配置时使用 app 私有目录下的 NoteBar，便于本地联调与 SAF 落地前的验证
        val app = getApplication<Application>()
        return java.io.File(app.filesDir, "NoteBar").apply { mkdirs() }.absolutePath
    }

    private fun startSyncLoop() {
        syncTimer?.cancel()
        syncTimer = viewModelScope.launch {
            while (isActive) {
                runScan()
                delay(SYNC_INTERVAL_MS)
            }
        }
    }

    suspend fun runScan() {
        val root = sync.currentRoot
        val status = sync.scan(root)
        _syncStatus.value = status
        _conflicts.value = sync.lastConflicts
    }

    // ------------------------------------------------------------------ 设置

    suspend fun updateSettings(transform: (Settings) -> Settings) = settingsRepo.update(transform)

    /** 设置流的一次性快照（供需要同步取值的场景使用） */
    suspend fun currentSettings(): Settings = settingsRepo.currentSettings()

    suspend fun setSyncRoot(path: String?) {
        settingsRepo.setSyncRoot(path)
        sync.currentRoot = resolveRoot(path)
        _syncRootPath.value = sync.currentRoot
        runScan()
    }

    // -------------------------------------------------------------- 强化草稿

    suspend fun saveReinforceDraft(session: ReinforceSession<String>) =
        settingsRepo.saveReinforceDraft(session)

    suspend fun saveReinforceDraft(draft: ReinforceDraft) = settingsRepo.saveReinforceDraft(draft)

    suspend fun clearReinforceDraft() = settingsRepo.clearReinforceDraft()

    // ------------------------------------------------------------------ 评分

    /**
     * 评分：算 FSRS → 落 Room → 写边车。
     *
     * 与 iOS `ReviewView.rate(_:)` 一一对应，包括：
     * 学习模式下把「不认识」的词记入内存 weakKeys（**不写进度**）；
     * 毕业时同时写 lifecycle 与 status。
     *
     * @param trackWeak 为 true 时把「不认识」记入 [weakKeys]（仅学习模式）
     */
    suspend fun rate(
        entry: Entry,
        direction: ReviewDirection,
        trackWeak: Boolean,
        weakKeys: MutableList<String>,
    ): RatingOutcome = withContext(Dispatchers.IO) {
        if (trackWeak && direction == ReviewDirection.again) {
            ReviewEngine.trackWeakKey(weakKeys, entry.studyKey)
        }

        val outcome = ReviewEngine.rate(entry, direction)
        val next = ReviewEngine.apply(entry, outcome)

        val row = EntryCodec.toEntity(next)
        dao.upsert(row)
        // 评分后立即写回边车（对应 iOS `appState.sync.persist`）
        val ok = sync.persist(entry.book, entry.studyKey, outcome.progress)
        if (!ok) _syncStatus.value = com.notebar.engine.sync.SyncStatus.PROGRESS_WRITE_FAILED

        // 同步刷新词条流之外的一致性：写回 Room 后由 Flow 自动推送
        outcome
    }

    /** 撤销：把词条恢复到评分前的进度（对应 iOS `undo()`） */
    suspend fun restore(entry: Entry, progress: com.notebar.engine.StudyProgress) =
        withContext(Dispatchers.IO) {
            dao.upsert(EntryCodec.toEntity(entry.withProgress(progress)))
        }

    /**
     * 把 [ReviewSessionState] 算出的评分结果落库并写回边车。
     *
     * 评分本身由纯逻辑的 `ReviewSessionState.rate()` 完成（便于单测），
     * 这里只负责持久化，避免同一套 FSRS 逻辑出现两份实现。
     */
    suspend fun persistOutcome(
        updated: Entry,
        outcome: com.notebar.app.domain.RatingOutcome,
    ) = withContext(Dispatchers.IO) {
        dao.upsert(EntryCodec.toEntity(updated))
        val ok = sync.persist(updated.book, updated.studyKey, outcome.progress)
        if (!ok) _syncStatus.value = com.notebar.engine.sync.SyncStatus.PROGRESS_WRITE_FAILED
    }

    // -------------------------------------------------------------- 词条编辑

    /**
     * 保存单词编辑：写 Room（含 `localEditedAt`）→ 写回 canvas。
     * 对应 iOS `WordEditSheet.save()`。
     */
    suspend fun saveWordEdit(
        original: Entry,
        word: String,
        aliases: List<String>,
        contents: Map<com.notebar.app.data.DefinitionModule, String>,
        order: List<com.notebar.app.data.DefinitionModule>,
    ) = withContext(Dispatchers.IO) {
        var definition = original.definition
        for (module in order) {
            definition = DefinitionSections.update(definition, module, contents[module] ?: "")
        }

        val updated = original.copy(
            word = word,
            aliases = aliases,
            definition = definition,
            localEditedAt = com.notebar.engine.TimeIso.nowString(),
        )
        dao.upsert(EntryCodec.toEntity(updated))

        // 回推 canvas：读 → CanvasEditor.updateWord → 原子写
        val canvas = sync.readCanvas(original.book)
        if (canvas != null) {
            val next = CanvasEditor.updateWord(canvas, original.nodeId, word, definition, aliases)
            if (next != null && sync.writeCanvas(original.book, next)) {
                // 上传成功 → 清掉待推送标记
                dao.upsert(EntryCodec.toEntity(updated.copy(localEditedAt = null)))
            }
        }
    }

    /** 删除词条：本地删除 + 从 canvas 里移除节点。对应 iOS `WordDetailView.delete()` */
    suspend fun deleteWord(entry: Entry) = withContext(Dispatchers.IO) {
        dao.deleteByKey(entry.studyKey)
        val canvas = sync.readCanvas(entry.book)
        if (canvas != null) {
            val next = CanvasEditor.deleteWord(canvas, entry.nodeId)
            if (next != null) sync.writeCanvas(entry.book, next)
        }
    }

    // ------------------------------------------------------------------ 同步

    suspend fun resolveConflict(conflict: SyncConflict, keepCopy: Boolean) {
        withContext(Dispatchers.IO) { sync.resolveConflict(conflict, keepCopy) }
        runScan()
    }

    suspend fun deleteBook(book: String): Boolean {
        val ok = withContext(Dispatchers.IO) { sync.deleteBook(book) }
        runScan()
        return ok
    }

    override fun onCleared() {
        syncTimer?.cancel()
        db.close()
        super.onCleared()
    }

    companion object {
        /** 对应 iOS `SyncService.start()` 的 15 秒轮询 */
        const val SYNC_INTERVAL_MS = 15_000L

        /** 今日日期串（`YYYY-MM-DD`），与 FSRS.dayString 同口径 */
        fun today(): String = FSRS.dayString(FSRS.today())
    }
}

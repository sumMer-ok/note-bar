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
import com.notebar.app.sync.SyncRootProbe
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

    /** 当前实际使用的同步根目录（未显式配置时是 app 私有目录；网盘后端下是远端根） */
    private val _syncRootPath = MutableStateFlow<String?>(null)
    val syncRootPath: StateFlow<String?> = _syncRootPath.asStateFlow()

    /** 当前是否走百度网盘通道（设置页展示用） */
    private val _usingBaiduPan = MutableStateFlow(false)
    val usingBaiduPan: StateFlow<Boolean> = _usingBaiduPan.asStateFlow()

    private var syncTimer: Job? = null

    init {
        viewModelScope.launch {
            // 恢复上次配置的同步目录与网盘开关，并开启定时扫描
            // （对应 iOS `sync.start()` 的 15s 轮询；网盘配额有限，见 [pollIntervalMs]）
            val settings = settingsRepo.currentSettings()
            var configured = settingsRepo.syncRoot.first()

            // 自愈：旧版本允许把「不可写」的路径存进设置（例如共享存储 /storage/emulated/0/…，
            // 而 App 只有 INTERNET 权限）——一旦存在，之后每次同步都只报「目录权限不可用」，
            // 用户被卡在死状态（真机 2026-10-17 就是这么卡住的）。这里检测到不可写就清除并回落默认。
            if (!configured.isNullOrBlank() && !SyncRootProbe.isWritableDirectory(configured)) {
                settingsRepo.setSyncRoot(null)
                _syncStatus.value = "已恢复默认同步目录：原目录不可写入（$configured）"
                configured = null
            }

            sync.currentRoot = resolveRoot(configured)
            applyBackend(settings)
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

    /**
     * 依据设置选择同步后端（百度网盘优先、本地目录兜底），并刷新状态文案。
     *
     * 后端切换**只在这里发生**（配置变化时），运行期失败不走静默降级——
     * 否则同一次同步可能把两份来源的数据混在一起，用户却看到「同步成功」。
     */
    suspend fun applyBackend(settings: Settings) {
        sync.configureBackend(settings.baiduPan, sync.currentRoot ?: resolveRoot(null))
        _usingBaiduPan.value = sync.isRemoteBackend
        _syncRootPath.value = if (sync.isRemoteBackend) {
            settings.baiduPan.wordsDir
        } else {
            sync.currentRoot
        }
        val notice = backendNotice(settings.baiduPan)
        if (notice != null) _syncStatus.value = notice
    }

    /** 配置不全时的可见提示（绝不静默回落到本地） */
    private fun backendNotice(pan: com.notebar.app.sync.BaiduPanSettings): String? {
        if (!pan.enabled) return null
        if (!pan.isConfigured) {
            return "百度网盘同步已启用，但 AppKey / SecretKey 尚未填写，已回退到本地目录"
        }
        return null
    }

    private fun startSyncLoop() {
        syncTimer?.cancel()
        syncTimer = viewModelScope.launch {
            while (isActive) {
                runScan()
                // 网盘未过审应用每小时仅 10 次配额，轮询间隔必须显著放宽
                delay(if (sync.isRemoteBackend) BAIDU_PAN_INTERVAL_MS else SYNC_INTERVAL_MS)
            }
        }
    }

    suspend fun runScan() {
        val status = sync.scan(sync.currentRoot)
        _syncStatus.value = status
        _conflicts.value = sync.lastConflicts
    }

    // ------------------------------------------------------------------ 设置

    suspend fun updateSettings(transform: (Settings) -> Settings) {
        settingsRepo.update(transform)
        // 网盘开关 / 凭证 / 目录变化后立刻重选后端（设置页改完即时生效）
        applyBackend(settingsRepo.currentSettings())
    }

    /** 设置流的一次性快照（供需要同步取值的场景使用） */
    suspend fun currentSettings(): Settings = settingsRepo.currentSettings()

    /**
     * 设置本地同步根（`null` = 恢复默认的应用私有目录）。
     *
     * **先探测可写再持久化**：真机反馈（2026-10-17）是用户填了 `/storage/emulated/0/NoteBar`
     * 并点了「使用该目录」，该路径因缺存储权限必然不可写，却被原样存进设置 →
     * 此后每次同步都只报「目录权限不可用」，且界面看不出是"路径本身不可能可用"。
     * 现在不可写的路径一律**不保存**，并把原因写进同步状态行（正面告诉用户怎么办）。
     *
     * @return 出错时的说明文案；成功返回 null
     */
    suspend fun setSyncRoot(path: String?): String? {
        val candidate = path?.trim().orEmpty()
        if (candidate.isNotEmpty() && !SyncRootProbe.isWritableDirectory(candidate)) {
            val message = "该目录不可写入，已保持原设置：$candidate —— " +
                "Android 11+ 访问共享存储需要「安全目录选择器」（SAF，尚未接入）。" +
                "同步根通常无需修改，点「恢复默认目录」用应用私有目录即可"
            _syncStatus.value = message
            return message
        }
        settingsRepo.setSyncRoot(candidate.ifEmpty { null })
        sync.currentRoot = resolveRoot(candidate.ifEmpty { null })
        applyBackend(settingsRepo.currentSettings())
        runScan()
        return null
    }

    // -------------------------------------------------------------- 百度网盘

    /**
     * 用一次性授权码换 token，并把新的 access/refresh token 落盘。
     *
     * 走的是与同步完全相同的 [BaiduPanClient]，因此「刷新后保存新 refresh_token」的语义
     * 在授权与刷新两条路径上一致（网盘会轮换 refresh_token，旧值在部分场景下失效）。
     *
     * @return 展示给用户的结果文案；**失败也只返回可读原因，绝不包含任何凭证**
     */
    suspend fun exchangeBaiduPanAuthCode(code: String): String = withContext(Dispatchers.IO) {
        val pan = settingsRepo.currentSettings().baiduPan
        if (!pan.isConfigured) return@withContext "请先填写 AppKey 与 SecretKey"

        val client = com.notebar.app.sync.BaiduPanClient(pan)
        return@withContext try {
            val result = client.exchangeAuthorizationCode(code.trim())
            val latest = settingsRepo.currentSettings().baiduPan
            // 用返回的令牌落盘；这里显式再写一次，避免将来客户端内部更新路径变化时漏存
            saveBaiduPanTokens(latest, result.accessToken, result.refreshToken, result.expiresAt)
            "已授权（令牌有效期至 ${java.time.Instant.ofEpochMilli(result.expiresAt)}）"
        } catch (error: com.notebar.app.sync.BaiduPanError) {
            // 客户端已经做过凭证脱敏，这里再兜一层
            com.notebar.app.sync.sanitizeMessage(
                "授权失败：${error.message}",
                listOf(pan.secretKey, pan.appKey),
            )
        } catch (error: Exception) {
            "授权失败：${error.javaClass.simpleName}"
        }
    }

    /** 把新令牌写回设置（含刷新后的 refresh_token，绝不写日志） */
    private suspend fun saveBaiduPanTokens(
        pan: com.notebar.app.sync.BaiduPanSettings,
        accessToken: String,
        refreshToken: String,
        expiresAt: Long,
    ) {
        updateSettings { s ->
            s.copy(
                baiduPan = s.baiduPan.copy(
                    accessToken = accessToken,
                    refreshToken = refreshToken.ifEmpty { pan.refreshToken },
                    expiresAt = expiresAt,
                ),
            )
        }
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
        /** 对应 iOS `SyncService.start()` 的 15 秒轮询（本地目录后端） */
        const val SYNC_INTERVAL_MS = 15_000L

        /**
         * 百度网盘后端的轮询间隔：5 分钟。
         * 未过审应用每小时仅 10 次调用配额（errno 20012 / 31034），
         * 与桌面端 `DEFAULT_BAIDU_PAN_POLL_SEC = 300` 保持一致，不能像本地目录那样激进。
         */
        const val BAIDU_PAN_INTERVAL_MS = 300_000L

        /** 今日日期串（`YYYY-MM-DD`），与 FSRS.dayString 同口径 */
        fun today(): String = FSRS.dayString(FSRS.today())
    }
}

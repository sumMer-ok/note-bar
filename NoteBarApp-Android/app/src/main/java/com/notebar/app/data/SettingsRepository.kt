package com.notebar.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.notebar.engine.ReinforceDraft
import com.notebar.engine.ReinforceSession
import com.notebar.engine.draftSnapshot
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** 应用级 DataStore 单例（Preferences 版） */
private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "notebar-settings")

/**
 * 设置仓储：DataStore Preferences。
 *
 * 与 iOS 的对应关系：
 * - `Settings` ↔ `AppState.Settings`（存 UserDefaults 的 `app-settings`）；
 * - `reinforceDraft` ↔ `AppState.reinforceDraft`（存 UserDefaults 的 `reinforce-draft`）；
 * - `syncRoot` ↔ `BookmarkStore`（iOS 存安全作用域书签，Android 存 SAF 树 URI 或私有目录路径）。
 *
 * 设置的落库格式是整份 JSON 字符串（不是逐字段 key），这样字段增删与 iOS 的
 * `Codable` 行为一致：新增字段走默认值，未知字段被忽略。
 */
class SettingsRepository(private val context: Context) {

    private val keySettings = stringPreferencesKey("app-settings")
    private val keyReinforceDraft = stringPreferencesKey("reinforce-draft")
    private val keySyncRoot = stringPreferencesKey("sync-root")
    private val keySyncTreeUri = stringPreferencesKey("sync-tree-uri")

    /** 设置流；总有一个值（缺失时为默认 [Settings]） */
    val settings: Flow<Settings> = context.settingsDataStore.data
        .map { SettingsCodec.decode(it[keySettings]) }

    /** 强化草稿流；草稿队列已空时返回 null（对应 iOS `loadReinforceDraft` 的 `isResumable` 闸门） */
    val reinforceDraft: Flow<ReinforceDraft?> = context.settingsDataStore.data
        .map { decodeDraft(it[keyReinforceDraft]) }

    val syncRoot: Flow<String?> = context.settingsDataStore.data
        .map { it[keySyncRoot] }

    val syncTreeUri: Flow<String?> = context.settingsDataStore.data
        .map { it[keySyncTreeUri] }

    suspend fun currentSettings(): Settings = settings.first()

    /**
     * 清空本仓库的所有持久化状态（**仅供设备上测试使用**）。
     *
     * 存在的理由：DataStore Preferences 是进程级单文件，instrumented 测试之间会互相污染
     * ——曾出现「上一个用例写入 dailyNewWordLimit=7，下一个用例断言默认值 20 失败」，
     * 把测试隔离问题误判成生产默认值错误。测试在每个用例前调用本方法恢复「全新安装」语义。
     */
    suspend fun resetForTest() {
        context.settingsDataStore.edit { it.clear() }
    }

    suspend fun update(transform: (Settings) -> Settings) {
        context.settingsDataStore.edit { prefs ->
            prefs[keySettings] = SettingsCodec.encode(transform(SettingsCodec.decode(prefs[keySettings])))
        }
    }

    suspend fun setDefaultBook(book: String, isDefault: Boolean) = update { s ->
        s.copy(
            defaultBooks = if (isDefault) {
                if (s.defaultBooks.contains(book)) s.defaultBooks else s.defaultBooks + book
            } else {
                s.defaultBooks.filterNot { it == book }
            },
        )
    }

    suspend fun setPinnedBook(book: String, isPinned: Boolean) = update { s ->
        s.copy(
            pinnedBooks = if (isPinned) {
                if (s.pinnedBooks.contains(book)) s.pinnedBooks else s.pinnedBooks + book
            } else {
                s.pinnedBooks.filterNot { it == book }
            },
        )
    }

    suspend fun saveReinforceDraft(session: ReinforceSession<String>) {
        saveReinforceDraft(session.draftSnapshot())
    }

    suspend fun saveReinforceDraft(draft: ReinforceDraft) {
        context.settingsDataStore.edit { prefs ->
            prefs[keyReinforceDraft] = ReinforceDraftCodec.encode(draft)
        }
    }

    suspend fun clearReinforceDraft() {
        context.settingsDataStore.edit { it.remove(keyReinforceDraft) }
    }

    suspend fun setSyncRoot(path: String?) {
        context.settingsDataStore.edit { prefs ->
            if (path == null) prefs.remove(keySyncRoot) else prefs[keySyncRoot] = path
        }
    }

    suspend fun setSyncTreeUri(uri: String?) {
        context.settingsDataStore.edit { prefs ->
            if (uri == null) prefs.remove(keySyncTreeUri) else prefs[keySyncTreeUri] = uri
        }
    }

    /**
     * 解析草稿 JSON。与 iOS 一致：队列为空的草稿视为"不可恢复"，直接当作没有草稿。
     */
    private fun decodeDraft(raw: String?): ReinforceDraft? {
        if (raw.isNullOrBlank()) return null
        val draft = ReinforceDraftCodec.decode(raw) ?: return null
        return if (draft.isResumable) draft else null
    }
}

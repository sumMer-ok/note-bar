package com.notebar.app.data

import androidx.room.Entity
import androidx.room.PrimaryKey
import com.notebar.engine.Entry
import com.notebar.engine.ReviewRecord
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * 词条表。
 *
 * 字段与 engine 的 [Entry] / iOS SwiftData 的 `Entry` **逐字段一一对应**：
 * `firstLearnedDate`、`localEditedAt` 等一个都不能少，否则同步合并与统计口径会走样。
 *
 * 存储考量：
 * - Room 是**本地缓存**，`.canvas` / `.nb-sync.json` 才是 source of truth（见红线 2）；
 * - `aliases` / `history` 在 iOS 侧是数组类型，这里用 JSON 字符串落库（`aliasesJson` /
 *   `historyJson`），读写经 [EntryCodec] 与 engine 的 `NoteBarJson` 口径保持一致；
 * - `localEditedAt` 在 iOS 是 `Date?`，engine 用 ISO8601 串，这里同样存 ISO8601 串。
 */
@Entity(tableName = "entries")
data class EntryEntity(
    @PrimaryKey val studyKey: String,
    val book: String,
    val source: String,
    val nodeId: String,
    val word: String,
    val aliasesJson: String,
    val definition: String,
    val color: String?,
    val addedDate: String?,
    val mastered: Boolean?,
    val s: Double?,
    val d: Double?,
    val lapses: Int?,
    val dueDate: String?,
    val lastReview: String?,
    val historyJson: String?,
    val lifecycle: String?,
    val pinned: Boolean?,
    val status: String?,
    val stage: Int?,
    val firstLearnedDate: String?,
    val localEditedAt: String?,
)

/**
 * [EntryEntity] ↔ engine [Entry] 的映射（纯函数，可 JVM 单测）。
 *
 * 两个方向都必须**无损**：任何字段丢失都会导致同步覆盖判断（`applyRemote` 的
 * textChanged / pendingPush 分支）和统计（`firstLearnedDate`）出错。
 */
object EntryCodec {

    private val json = Json {
        encodeDefaults = true
        explicitNulls = false
        ignoreUnknownKeys = true
    }

    private val aliasesSerializer = ListSerializer(String.serializer())
    private val historySerializer = ListSerializer(ReviewRecord.serializer())

    fun encodeAliases(aliases: List<String>): String =
        json.encodeToString(aliasesSerializer, aliases)

    fun decodeAliases(raw: String?): List<String> {
        if (raw.isNullOrBlank()) return emptyList()
        return runCatching { json.decodeFromString(aliasesSerializer, raw) }.getOrElse { emptyList() }
    }

    fun encodeHistory(history: List<ReviewRecord>?): String? =
        history?.let { json.encodeToString(historySerializer, it) }

    fun decodeHistory(raw: String?): List<ReviewRecord>? {
        if (raw.isNullOrBlank()) return null
        return runCatching { json.decodeFromString(historySerializer, raw) }.getOrNull()
    }

    /** engine [Entry] → 数据库行 */
    fun toEntity(entry: Entry): EntryEntity = EntryEntity(
        studyKey = entry.studyKey,
        book = entry.book,
        source = entry.source,
        nodeId = entry.nodeId,
        word = entry.word,
        aliasesJson = encodeAliases(entry.aliases),
        definition = entry.definition,
        color = entry.color,
        addedDate = entry.addedDate,
        mastered = entry.mastered,
        s = entry.s,
        d = entry.d,
        lapses = entry.lapses,
        dueDate = entry.dueDate,
        lastReview = entry.lastReview,
        historyJson = encodeHistory(entry.history),
        lifecycle = entry.lifecycle,
        pinned = entry.pinned,
        status = entry.status,
        stage = entry.stage,
        firstLearnedDate = entry.firstLearnedDate,
        localEditedAt = entry.localEditedAt,
    )

    /** 数据库行 → engine [Entry] */
    fun toEntry(entity: EntryEntity): Entry = Entry(
        studyKey = entity.studyKey,
        book = entity.book,
        source = entity.source,
        nodeId = entity.nodeId,
        word = entity.word,
        aliases = decodeAliases(entity.aliasesJson),
        definition = entity.definition,
        color = entity.color,
        addedDate = entity.addedDate,
        mastered = entity.mastered,
        s = entity.s,
        d = entity.d,
        lapses = entity.lapses,
        dueDate = entity.dueDate,
        lastReview = entity.lastReview,
        history = decodeHistory(entity.historyJson),
        lifecycle = entity.lifecycle,
        pinned = entity.pinned,
        status = entity.status,
        stage = entity.stage,
        firstLearnedDate = entity.firstLearnedDate,
        localEditedAt = entity.localEditedAt,
    )
}

package com.notebar.engine.sync

import com.notebar.engine.Entry
import com.notebar.engine.ParsedWord
import com.notebar.engine.StudyProgress
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 同步层的数据模型。逐字段移植自 `NoteBarApp/Sync/SyncService.swift` 与
 * `NoteBarApp/Store/DataStore.swift`，只保留纯数据（无 IO、无 Android/iOS 类型）。
 *
 * 时间字段一律用 epoch 毫秒（`Long?`）表示 iOS 的 `Date?`，与 `FileMeta.mtime` 口径一致；
 * 侧车 JSON 里的时间串仍是 ISO8601 字符串，不做转换。
 */

/** iCloud 冲突副本（`<name> 2.canvas` / `<name> 2.nb-sync.json`）的仲裁信息 */
data class SyncConflict(
    val book: String,
    val kind: SyncConflictKind,
    val mainPath: String,
    val conflictPath: String,
    val mainUpdatedAt: Long?,
    val conflictUpdatedAt: Long?,
    val mainWords: List<String>,
    val conflictWords: List<String>,
) {
    /** 对应 iOS `SyncConflict.id` */
    val id: String
        get() = "${kind.rawValue}:$conflictPath"

    /** 主版本与副本版本的词集合对称差（排序后）；对应 iOS `changedWords` */
    val changedWords: List<String>
        get() {
            val mainSet = mainWords.toSet()
            val copySet = conflictWords.toSet()
            return ((mainSet - copySet) + (copySet - mainSet)).sorted()
        }

    /** 对应 iOS `SyncConflict.bookDisplayName` */
    val bookDisplayName: String
        get() = displayNameFor(book)
}

/** 冲突副本所属的宿主文件类型；对应 iOS `SyncConflict.Kind` */
enum class SyncConflictKind(val rawValue: String) {
    CANVAS("canvas"),
    SIDECAR("sidecar"),
}

/**
 * 一次扫描的产物：一个 Canvas 词库的解析结果 + 对应边车的进度。
 * 对应 iOS `CanvasSnapshot`（原为 private struct，这里公开以便调用方与单测驱动）。
 */
data class CanvasSnapshot(
    val relative: String,
    val words: List<ParsedWord>,
    val progress: Map<String, StudyProgress>,
    val canvasMtime: Long?,
    val sidecarMtime: Long?,
)

/**
 * 一次扫描的结果。
 *
 * 与 iOS 的差异：iOS 的 `scan()` 直接持有 SwiftData 并就地合并词条；本引擎不持有词条存储，
 * 因此把「文件层结果」与「词条层合并」拆开：
 * - [snapshots]：本次扫描到的全部词库（对应 iOS `payload.snapshots`，用于清理词库列表）
 * - [changed]：通过 mtime 闸门、需要交给 [SyncEngine.applyRemote] 合并的词库子集
 * - [conflicts]：本次扫描到的冲突副本（对应 iOS `SyncService.conflicts`）
 */
data class SyncScanResult(
    val snapshots: List<CanvasSnapshot>,
    val conflicts: List<SyncConflict>,
    val changed: List<CanvasSnapshot>,
    val status: SyncStatus,
) {
    /** 本次实际存在的词库逻辑名集合；对应 iOS `currentBooks` */
    val currentBooks: Set<String>
        get() = snapshots.map { it.relative }.toSet()
}

/**
 * 单个词条应用云端内容后的结果。
 *
 * [entry] 是合并后的词条；[pendingPush] 为 true 表示该词条有「本地已编辑但尚未上传」的内容，
 * 需要回推云端（对应 iOS scan 里的 `pendingPush` 列表）；[changed] 表示是否产生了改动
 * （对应 iOS 那个 `changed` 标志，决定是否需要落库）。
 */
data class ApplyRemoteResult(
    val entry: Entry,
    val pendingPush: Boolean,
    val changed: Boolean,
)

/**
 * 同步状态提示文案。触发条件与状态分组 1:1 对齐 iOS `SyncService` 的
 * `onStatusChanged(...)` 调用点（同样的 6 种情形、同样的判定），便于 Phase 4 的 UI 直接透传。
 *
 * **措辞按端本地化（2026-10-17 修正）**：原文案是从 iOS 逐字搬来的，含「iCloud 云盘中的
 * NoteBar 文件夹」——在 Android 上这句是**错的**（Android 既没有 iCloud，同步根也是应用私有
 * 目录或用户自选目录），真机上会显示成「请到设置重新选择 iCloud 中的 NoteBar 文件夹」，
 * 让用户以为要去 iOS 设置里找东西。iOS 的 Swift 侧有自己的一份文案，本文件只服务 Android，
 * 因此这里改为平台中立的说法。**状态集合与触发条件不变**（三端行为口径仍然一致）。
 */
data class SyncStatus(val message: String) {
    companion object {
        /** 同步根在 UI 里的统称（Android 上通常是应用私有目录或用户自选目录） */
        const val SYNC_FOLDER_LABEL = "同步文件夹"

        /** 书签/目录为空时的提示（iOS L111 对应情形） */
        const val MISSING_DIRECTORY =
            "未选择同步目录：请到「设置」选择$SYNC_FOLDER_LABEL"

        /** 有配置但解析不出目录时的提示（iOS L113 对应情形） */
        const val INACCESSIBLE_DIRECTORY =
            "无法访问同步目录：请到「设置」重新选择$SYNC_FOLDER_LABEL"

        /** 目录枚举失败（权限/安全作用域失效）时的提示（iOS L125 对应情形） */
        const val SCAN_FAILED =
            "同步失败：目录权限不可用，请到「设置」重新选择$SYNC_FOLDER_LABEL"

        /** 算不出边车物理路径时的提示（iOS L212 对应情形） */
        const val PROGRESS_PATH_UNAVAILABLE = "无法访问同步目录：进度未能写回"

        /** 进度写回后读回校验仍失败时的提示（iOS L229 对应情形） */
        const val PROGRESS_WRITE_FAILED =
            "无法写回：本次评分未同步到电脑端，请重试或重新选择同步目录"

        /** iOS L190：扫描成功后的状态行（含最近同步时刻 HH:mm） */
        fun connected(rootName: String, time: String): SyncStatus =
            SyncStatus("已连接：$rootName · 最近同步 $time")

        /**
         * 对应 iOS `SyncService.timeString(_:)`：`DateFormatter` 固定 `HH:mm` 模式、
         * 使用系统默认时区与 locale。
         */
        fun timeString(instant: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
            DateTimeFormatter.ofPattern("HH:mm").withZone(zone).format(instant)
    }
}

/** 逻辑名 → 显示名：去掉目录与 `.canvas` 后缀；对应 iOS `bookDisplayName` 的两处实现 */
internal fun displayNameFor(book: String): String {
    val base = book.substringAfterLast('/')
    return if (base.endsWith(".canvas")) base.dropLast(".canvas".length) else base
}

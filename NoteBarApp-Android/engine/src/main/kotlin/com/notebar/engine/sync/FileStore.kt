package com.notebar.engine.sync

/**
 * 宿主文件系统的抽象端口。
 *
 * 设计约束（Phase 2b）：
 * - 这里**只定义接口**，真实实现（Android SAF / java.io.File）留给 Phase 4；
 * - 纯逻辑层（[SyncEngine]）一律通过本接口访问文件，不得 import 任何 Android/Obsidian 类型；
 * - 所有方法都按「失败返回 null / false」的约定，不抛异常，对应 iOS 里 `try?` 的写法。
 *
 * 对应 iOS 的 NSFileCoordinator 读 / `writeAtomically` 写：
 * iOS 那层协调（iCloud 提供器必须 `replaceItemAt`）属于宿主实现细节，
 * 端口层只承诺 [writeAtomic] 的语义是「temp + rename 的原子替换」。
 */
interface FileStore {

    /**
     * 列出目录下的直接子项（不递归）；目录不存在或不可读时返回 null。
     *
     * 对应 iOS `FileManager.contentsOfDirectory(at:includingPropertiesForKeys:)`:
     * 返回 nil（枚举失败）与空数组（目录存在但为空）语义不同，调用方据此提示「权限不可用」。
     */
    fun list(dir: String): List<FileMeta>?

    /** 读取文本；不存在或读不到返回 null（对应 iOS `readData(at:)` 返回 nil） */
    fun readText(path: String): String?

    /**
     * 原子写：先写临时文件再 rename 覆盖目标，成功返回 true。
     * 对应 iOS `writeAtomically(_:to:)`（含 `replaceItemAt` 失败降级为直接覆盖）。
     */
    fun writeAtomic(path: String, text: String): Boolean

    /** 删除文件；成功或本就存在性无关时返回 true，失败返回 false */
    fun delete(path: String): Boolean

    /** 文件（或目录）是否存在 */
    fun exists(path: String): Boolean
}

/**
 * 目录项元信息。
 *
 * 对应 iOS 在 `collect` 里用到的 `URLResourceValues`：
 * - [mtime]：`contentModificationDate` 的 epoch 毫秒（iOS 是 `Date?`，可为 null）
 * - [size]：`fileSize`；`readText` 之外仅作展示/诊断用
 */
data class FileMeta(
    val name: String,
    val isDirectory: Boolean,
    val mtime: Long?,
    val size: Long,
)

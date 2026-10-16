package com.notebar.app.sync

import com.notebar.engine.sync.FileMeta
import com.notebar.engine.sync.FileStore
import java.io.File
import java.io.IOException

/**
 * [FileStore] 的真实实现（app 私有目录 / 任意普通目录版）。
 *
 * 语义严格对齐 engine 的端口约定（见 `engine/sync/FileStore.kt`）：
 * - 所有方法**失败返回 null / false，不抛异常**（对应 iOS 的 `try?`）；
 * - [list] 区分「枚举失败 → null」与「目录存在但为空 → 空列表」，
 *   调用方据此提示「权限不可用」；
 * - [writeAtomic] 是 temp + rename 的原子替换（对应 iOS `writeAtomically` /
 *   `replaceItemAt`）。
 *
 * 关于 SAF：本阶段先把本地目录版做通（任务书允许）。SAF 的 `DocumentFile` 版
 * 未接入 —— 接入时只需再实现一份本接口，`SyncEngine` 无需改动。
 */
class LocalFileStore : FileStore {

    override fun list(dir: String): List<FileMeta>? {
        val file = File(dir)
        if (!file.isDirectory) return null
        val entries = file.listFiles() ?: return null
        return entries.map { child ->
            FileMeta(
                name = child.name,
                isDirectory = child.isDirectory,
                mtime = child.lastModified().takeIf { it > 0 },
                size = if (child.isFile) child.length() else 0L,
            )
        }
    }

    override fun readText(path: String): String? {
        val file = File(path)
        if (!file.isFile) return null
        return try {
            file.readText(Charsets.UTF_8)
        } catch (_: IOException) {
            null
        } catch (_: SecurityException) {
            null
        }
    }

    override fun writeAtomic(path: String, text: String): Boolean {
        val target = File(path)
        val dir = target.parentFile ?: return false
        if (!dir.isDirectory && !dir.mkdirs()) return false
        val tmp = File(dir, "${target.name}.nb-tmp")
        return try {
            tmp.writeText(text, Charsets.UTF_8)
            // rename 覆盖：Java 的 renameTo 在多数文件系统上可覆盖已存在文件；
            // 失败时（如某些网络文件系统）降级为直接写目标，与 iOS 的降级路径一致。
            if (tmp.renameTo(target)) return true
            target.writeText(text, Charsets.UTF_8)
            tmp.delete()
            true
        } catch (_: IOException) {
            tmp.delete()
            false
        } catch (_: SecurityException) {
            tmp.delete()
            false
        }
    }

    override fun delete(path: String): Boolean {
        val file = File(path)
        if (!file.exists()) return true
        return try {
            file.delete()
        } catch (_: SecurityException) {
            false
        }
    }

    override fun exists(path: String): Boolean = File(path).exists()
}

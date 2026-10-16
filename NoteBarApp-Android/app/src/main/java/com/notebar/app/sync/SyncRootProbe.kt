package com.notebar.app.sync

import java.io.File

/**
 * 同步根可用性探测。
 *
 * 背景（2026-10-17 真机）：设置页允许手填任意绝对路径并**立即持久化**，但 App 清单里只有
 * `INTERNET` 权限、没有存储权限，填 `/storage/emulated/0/...` 这类共享存储路径**必然不可写**；
 * 一旦写进设置，之后每次同步都只报「目录权限不可用，请到设置重新选择同步文件夹」，
 * 用户被卡在一个只能靠自己手动改回的死状态（真机上就是这么卡住的）。
 *
 * 因此把「能不能用」的判断前置到这里：**建目录 + 写探针 + 删探针**，全过才算可用。
 * 任何异常一律视为不可用，不向调用方抛错（同步链路要求失败可预期）。
 */
object SyncRootProbe {
    private const val PROBE_NAME = ".notebar-write-probe"

    /** 路径可写返回 true；目录不存在会尝试创建。 */
    fun isWritableDirectory(path: String): Boolean {
        if (path.isBlank()) return false
        val dir = File(path)
        return try {
            // 路径被一个同名文件占着时 mkdirs 会失败 —— 正是我们要拒绝的情况
            if (!dir.isDirectory && !dir.mkdirs()) return false
            val probe = File(dir, PROBE_NAME)
            probe.writeText("notebar-probe")
            probe.delete()
            true
        } catch (_: Exception) {
            // SecurityException（无权限）、IOException（只读挂载）等一律算不可用
            false
        }
    }
}

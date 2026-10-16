package com.notebar.app.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 同步根探测的回归测试。
 *
 * 背景（2026-10-17 真机）：用户填了 `/storage/emulated/0/NoteBar` 并点了「使用该目录」——
 * App 只有 INTERNET 权限、没有存储权限，该路径必然不可写，却被原样存进设置，
 * 之后每次同步都只报「目录权限不可用」。这组测试把「不可写就必须判为不可用」钉死。
 */
class SyncRootProbeTest {

    @Test
    fun writableTempDirectoryIsAccepted() {
        val dir = Files.createTempDirectory("notebar-root-probe").toFile()
        assertTrue("可写目录必须通过", SyncRootProbe.isWritableDirectory(dir.absolutePath))
        dir.deleteRecursively()
    }

    @Test
    fun nonExistentDirectoryIsCreatedAndAccepted() {
        val parent = Files.createTempDirectory("notebar-root-probe").toFile()
        val target = File(parent, "created/sub")
        assertTrue("不存在时应尝试创建并通过", SyncRootProbe.isWritableDirectory(target.absolutePath))
        assertTrue("目录应已被创建", target.isDirectory)
        parent.deleteRecursively()
    }

    @Test
    fun pathOccupiedByAFileIsRejected() {
        // 用一个同名文件占住路径：mkdirs 必然失败 → 必须判为不可用（而不是留个坏根给同步）
        val file = Files.createTempFile("notebar-root-probe", ".file").toFile()
        assertFalse("被文件占用的路径不可用", SyncRootProbe.isWritableDirectory(file.absolutePath))
        file.delete()
    }

    @Test
    fun blankPathIsRejected() {
        assertFalse(SyncRootProbe.isWritableDirectory(""))
        assertFalse(SyncRootProbe.isWritableDirectory("   "))
    }

    @Test
    fun probeFileIsCleanedUpAfterwards() {
        // 探测不能在现场留下垃圾文件
        val dir = Files.createTempDirectory("notebar-root-probe").toFile()
        SyncRootProbe.isWritableDirectory(dir.absolutePath)
        val leftovers = dir.listFiles()?.map { it.name } ?: emptyList()
        assertTrue("探测后不应残留文件，实际：$leftovers", leftovers.isEmpty())
        dir.deleteRecursively()
    }
}

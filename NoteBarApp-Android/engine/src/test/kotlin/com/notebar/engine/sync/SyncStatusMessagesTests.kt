package com.notebar.engine.sync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 同步状态文案的护栏测试。
 *
 * 背景（2026-10-17 真机）：这些常量最初是从 iOS 逐字搬来的，含「iCloud 云盘中的 NoteBar 文件夹」，
 * 在 Android 上显示成「请到设置重新选择 iCloud 中的 NoteBar 文件夹」——用户会以为要去 iOS 设置里找东西。
 * 本测试把「Android 文案不得出现 iCloud」钉死，防止下次同步 iOS 文案时又把它带回来。
 */
class SyncStatusMessagesTests {

    private val allMessages = listOf(
        SyncStatus.MISSING_DIRECTORY,
        SyncStatus.INACCESSIBLE_DIRECTORY,
        SyncStatus.SCAN_FAILED,
        SyncStatus.PROGRESS_PATH_UNAVAILABLE,
        SyncStatus.PROGRESS_WRITE_FAILED,
        SyncStatus.connected("NoteBar", "12:00").message,
    )

    @Test
    fun messagesNeverMentionICloud() {
        for (message in allMessages) {
            assertFalse(
                message.contains("iCloud", ignoreCase = true),
                "Android 文案不应出现 iCloud（会误导用户去 iOS 设置里找）：$message",
            )
        }
    }

    @Test
    fun messagesStayActionableAndNonEmpty() {
        for (message in allMessages) {
            assertTrue(message.isNotBlank(), "文案不能为空")
        }
        // 目录类问题必须给出「去设置」的下一步，否则用户不知道怎么办
        for (message in listOf(
            SyncStatus.MISSING_DIRECTORY,
            SyncStatus.INACCESSIBLE_DIRECTORY,
            SyncStatus.SCAN_FAILED,
        )) {
            assertTrue(message.contains("「设置」"), "目录类提示必须指向设置页：$message")
        }
    }

    @Test
    fun connectedLineKeepsIosShape() {
        // 与 iOS `connected(rootName:time:)` 同形：已连接：<根名> · 最近同步 HH:mm
        assertEquals("已连接：NoteBar · 最近同步 09:05", SyncStatus.connected("NoteBar", "09:05").message)
    }
}

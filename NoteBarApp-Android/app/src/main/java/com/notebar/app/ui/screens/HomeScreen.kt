package com.notebar.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Book
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Spellcheck
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.notebar.app.domain.ReviewMode
import com.notebar.app.domain.StudyScope
import com.notebar.engine.Entry
import com.notebar.engine.ReinforceDraft
import com.notebar.engine.TimeIso

/**
 * 首页。逐块对应 iOS `HomeView`：
 * - 标题「学习」；
 * - 四宫格入口：开始复习 / 开始学习 / 开始慢游 / 开始听写（文案照抄）；
 * - 未完成的不熟词强化草稿入口（「继续强化 N 个不熟词 / 第 X 轮 · 已作答 Y 次」）；
 * - 「今日待复习 X · 新词 Y」；
 * - 「我的词库」列表（默认 / 置顶标记、待复习数、长按菜单）。
 *
 * iOS 的滑动露出「默认 / 置顶」改用长按菜单：Android 上这是同一组动作的更自然手势，
 * 动作集合与 iOS 完全一致（默认 / 取消默认、置顶 / 取消置顶、删除词库）。
 */
@Composable
fun HomeScreen(
    entries: List<Entry>,
    pinnedBooks: List<String>,
    defaultBooks: List<String>,
    today: String,
    draft: ReinforceDraft?,
    onStartReview: () -> Unit,
    onStartLearn: () -> Unit,
    onStartBrowse: () -> Unit,
    onStartDictation: () -> Unit,
    onResumeReinforce: (ReinforceDraft) -> Unit,
    onDiscardReinforce: () -> Unit,
    onOpenBook: (String) -> Unit,
    onToggleDefault: (String) -> Unit,
    onTogglePinned: (String) -> Unit,
    onDeleteBook: (String) -> Unit,
) {
    val totalDue = StudyScope.dueCount(entries, today)
    val totalNew = StudyScope.newCount(entries)
    val books = StudyScope.orderedBooks(entries, pinnedBooks)

    var pendingDelete by remember { mutableStateOf<String?>(null) }

    LazyColumn(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Text("学习", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                HomeActionButton(
                    title = "开始复习",
                    icon = Icons.Filled.Refresh,
                    color = Color(0xFF2196F3),
                    modifier = Modifier.weight(1f),
                    onClick = onStartReview,
                )
                HomeActionButton(
                    title = "开始学习",
                    icon = Icons.Filled.AutoAwesome,
                    color = Color(0xFF9C27B0),
                    modifier = Modifier.weight(1f),
                    onClick = onStartLearn,
                )
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                HomeActionButton(
                    title = "开始慢游",
                    icon = Icons.Filled.Book,
                    color = Color(0xFF009688),
                    modifier = Modifier.weight(1f),
                    onClick = onStartBrowse,
                )
                HomeActionButton(
                    title = "开始听写",
                    icon = Icons.Filled.Spellcheck,
                    color = Color(0xFF8C939E),
                    modifier = Modifier.weight(1f),
                    onClick = onStartDictation,
                )
            }
        }

        if (draft != null && draft.isResumable) {
            item {
                ReinforceDraftRow(
                    draft = draft,
                    onResume = { onResumeReinforce(draft) },
                    onDiscard = onDiscardReinforce,
                )
            }
        }

        item {
            Text(
                "今日待复习 $totalDue · 新词 $totalNew",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        item {
            Text("我的词库", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        }
        if (books.isEmpty()) {
            // 空态必须给出下一步：真机 2026-10-17 用户点完同步看到「已连接」却没有单词，
            // 不知道是"同步失败"还是"本来就没词库"。这里把原因和去处都写清楚。
            item {
                Text(
                    "还没有词库。\n" +
                        "· 若还没配置：到「设置 → 百度网盘」填 AppKey / SecretKey，点「打开授权链接」" +
                        "取授权码换令牌，再点「立即同步」\n" +
                        "· 若已配置：点「设置 → 立即同步」，词库会从网盘下载到这里\n" +
                        "· 同步状态看「设置 → 同步目录」，会显示当前用的是网盘还是本地目录、有几个词库",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        items(books, key = { it }) { book ->
            val wordCount = entries.count { it.book == book }
            val dueCount = StudyScope.dueCount(entries, today, book)
            BookRow(
                book = book,
                wordCount = wordCount,
                dueCount = dueCount,
                isDefault = defaultBooks.contains(book),
                isPinned = pinnedBooks.contains(book),
                onOpen = { onOpenBook(book) },
                onToggleDefault = { onToggleDefault(book) },
                onTogglePinned = { onTogglePinned(book) },
                onDelete = { pendingDelete = book },
            )
        }
    }

    val deleteTarget = pendingDelete
    if (deleteTarget != null) {
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除词库「${displayName(deleteTarget)}」？") },
            text = {
                Text("将删除该词库在同步目录中的 Canvas 和复习进度文件，电脑端同步后也会移除，此操作不可恢复。")
            },
            confirmButton = {
                TextButton(onClick = {
                    onDeleteBook(deleteTarget)
                    pendingDelete = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            },
        )
    }
}

/** 首页大按钮。对应 iOS `HomeActionButton`（此处省略随机探头的小动物动画） */
@Composable
private fun HomeActionButton(
    title: String,
    icon: ImageVector,
    color: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = modifier.height(78.dp),
        shape = RoundedCornerShape(18.dp),
        colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = Color.White),
    ) {
        Icon(icon, contentDescription = null)
        Spacer(Modifier.width(8.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
    }
}

/** 强化草稿入口。对应 iOS `HomeView` 的「继续强化」块（含长按放弃） */
@Composable
private fun ReinforceDraftRow(
    draft: ReinforceDraft,
    onResume: () -> Unit,
    onDiscard: () -> Unit,
) {
    var showDiscard by remember { mutableStateOf(false) }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onResume, onLongClick = { showDiscard = true }),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(
            containerColor = com.notebar.app.ui.theme.NoteBarColors.againRed.copy(alpha = 0.14f),
        ),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "继续强化 ${draft.remainingCount} 个不熟词",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold,
                color = com.notebar.app.ui.theme.NoteBarColors.againRed,
            )
            Spacer(Modifier.weight(1f))
            Text(
                "第 ${draft.round} 轮 · 已作答 ${draft.totalAnswers} 次",
                style = MaterialTheme.typography.labelSmall,
                color = com.notebar.app.ui.theme.NoteBarColors.againRed,
            )
        }
    }
    if (showDiscard) {
        AlertDialog(
            onDismissRequest = { showDiscard = false },
            title = { Text("放弃这次强化？") },
            text = {
                Text("将清空「不熟词强化」的本轮进度。已写入的复习进度不受影响。")
            },
            confirmButton = {
                TextButton(onClick = {
                    showDiscard = false
                    onDiscard()
                }) { Text("放弃", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { showDiscard = false }) { Text("取消") }
            },
        )
    }
}

/** 词库行。对应 iOS `BookRow` 的展示部分（动作改由长按菜单触发） */
@Composable
private fun BookRow(
    book: String,
    wordCount: Int,
    dueCount: Int,
    isDefault: Boolean,
    isPinned: Boolean,
    onOpen: () -> Unit,
    onToggleDefault: () -> Unit,
    onTogglePinned: () -> Unit,
    onDelete: () -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }

    Box {
        Card(
            modifier = Modifier.fillMaxWidth().combinedClickable(
                onClick = onOpen,
                onLongClick = { showMenu = true },
            ),
            shape = RoundedCornerShape(18.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (isPinned) {
                            Icon(
                                Icons.Filled.PushPin,
                                contentDescription = "已置顶",
                                tint = Color(0xFFFF9800),
                                modifier = Modifier.height(14.dp),
                            )
                            Spacer(Modifier.width(5.dp))
                        }
                        Text(displayName(book), fontWeight = FontWeight.Medium)
                        if (isDefault) {
                            Spacer(Modifier.width(5.dp))
                            Text(
                                "（默认）",
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                    Text(
                        "$wordCount 词",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.weight(1f))
                Text(
                    "待复习 $dueCount",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        if (showMenu) {
            androidx.compose.material3.DropdownMenu(
                expanded = showMenu,
                onDismissRequest = { showMenu = false },
            ) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(if (isDefault) "取消默认" else "默认") },
                    onClick = {
                        showMenu = false
                        onToggleDefault()
                    },
                )
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(if (isPinned) "取消置顶" else "置顶") },
                    onClick = {
                        showMenu = false
                        onTogglePinned()
                    },
                )
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text("删除词库") },
                    onClick = {
                        showMenu = false
                        onDelete()
                    },
                )
            }
        }
    }
}

/** 词库显示名：去掉目录与 `.canvas` 后缀。对应 iOS `bookDisplayName` */
internal fun displayName(book: String): String {
    val base = book.substringAfterLast('/')
    return if (base.endsWith(".canvas")) base.dropLast(".canvas".length) else base
}

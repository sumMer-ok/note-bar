package com.notebar.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.notebar.app.data.DefinitionModule
import com.notebar.app.data.Settings
import com.notebar.engine.sync.SyncConflict

/**
 * 设置页。逐块对应 iOS `SettingsView`：
 * 同步目录 / 外观 / 学习 / AI 释义 / 单词卡片显示顺序 / 冲突仲裁。
 *
 * 与 iOS 的差异（会在报告里说明）：
 * - 「选择目录」在 Android 上先落到 app 私有目录同步目录（SAF 目录选择器未接入）；
 * - 释义模块顺序用上 / 下移按钮代替 iOS 的拖拽把手（同一组动作，Android 更稳）。
 */
@Composable
fun SettingsScreen(
    settings: Settings,
    syncStatus: String,
    syncRoot: String?,
    conflicts: List<SyncConflict>,
    onSetSyncRoot: (String?) -> Unit,
    onSyncNow: () -> Unit,
    onUpdate: ((Settings) -> Settings) -> Unit,
    onResolveConflict: (SyncConflict, Boolean) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("设置", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)

        // ---------------------------------------------------------- 同步目录
        Section("同步目录") {
            Text(
                syncRoot ?: "（未配置，使用应用私有目录）",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                syncStatus,
                style = MaterialTheme.typography.labelSmall,
                color = if (syncStatus.startsWith("无法") || syncStatus.startsWith("同步失败") ||
                    syncStatus.startsWith("未选择")
                ) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            var rootInput by remember(syncRoot) { mutableStateOf("") }
            OutlinedTextField(
                value = rootInput,
                onValueChange = { rootInput = it },
                label = { Text("同步目录绝对路径") },
                placeholder = { Text("/storage/emulated/0/NoteBar") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { onSetSyncRoot(rootInput.trim().ifEmpty { null }) },
                    enabled = rootInput.isNotBlank(),
                ) { Text("使用该目录") }
                OutlinedButton(onClick = onSyncNow) { Text("立即同步") }
                OutlinedButton(onClick = { onSetSyncRoot(null) }) { Text("恢复默认目录") }
            }
            Text(
                "Android 侧当前用普通目录作为同步根（默认是应用私有目录）。填绝对路径需要具备存储权限；" +
                    "安全目录选择器（SAF）尚未接入，因此还无法直接选取 U 盘/网盘挂载的文件夹。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "词库约定：<同步根>/Words/*.canvas 与同名 .nb-sync.json 边车。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // -------------------------------------------------------------- 外观
        Section("外观") {
            Text("外观模式", style = MaterialTheme.typography.labelMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Settings.Appearance.entries.forEach { mode ->
                    if (settings.appearance == mode) {
                        Button(onClick = { onUpdate { it.copy(appearance = mode) } }) { Text(mode.title) }
                    } else {
                        OutlinedButton(onClick = { onUpdate { it.copy(appearance = mode) } }) { Text(mode.title) }
                    }
                }
            }
        }

        // -------------------------------------------------------------- 学习
        Section("学习") {
            SwitchRow("自动朗读单词", settings.autoPronounce) {
                onUpdate { s -> s.copy(autoPronounce = it) }
            }
            StepperRow(
                label = "每日新词上限",
                value = settings.dailyNewWordLimit,
                range = 1..200,
                onChange = { v -> onUpdate { s -> s.copy(dailyNewWordLimit = v) } },
            )
            StepperRow(
                label = "每日复习上限",
                value = settings.dailyReviewLimit,
                range = 1..500,
                onChange = { v -> onUpdate { s -> s.copy(dailyReviewLimit = v) } },
            )
            StepperRow(
                label = "每轮听写词数",
                value = settings.dictationPerSession,
                range = 1..100,
                onChange = { v -> onUpdate { s -> s.copy(dictationPerSession = v) } },
            )
            SwitchRow("听写拼写正确后自动下一个", settings.dictationAutoAdvance) {
                onUpdate { s -> s.copy(dictationAutoAdvance = it) }
            }
            Text(
                "TTS 模板",
                style = MaterialTheme.typography.labelMedium,
            )
            OutlinedTextField(
                value = settings.ttsTemplate,
                onValueChange = { v -> onUpdate { s -> s.copy(ttsTemplate = v) } },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // ---------------------------------------------------------- AI 释义
        Section("AI 释义") {
            LabelledField("API 地址", settings.aiApiUrl) { v -> onUpdate { s -> s.copy(aiApiUrl = v) } }
            LabelledField("API Key", settings.aiApiKey, isSecret = true) { v ->
                onUpdate { s -> s.copy(aiApiKey = v) }
            }
            LabelledField("模型", settings.aiModel) { v -> onUpdate { s -> s.copy(aiModel = v) } }
            LabelledField("额外参数（JSON，可选）", settings.aiExtraParams) { v ->
                onUpdate { s -> s.copy(aiExtraParams = v) }
            }
            Text("自定义笔记提示词", style = MaterialTheme.typography.labelMedium)
            OutlinedTextField(
                value = settings.aiNotesPrompt,
                onValueChange = { v -> onUpdate { s -> s.copy(aiNotesPrompt = v) } },
                modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
            )
            Text(
                "「AI 释义」提示词与 Obsidian 插件保持一致；上方为「自定义笔记」提示词，可自行修改，支持 {{word}} 与 {{sentence}} 占位符",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // ------------------------------------------------- 单词卡片显示顺序
        Section("单词卡片显示顺序") {
            settings.definitionOrder.forEachIndexed { index, module ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(module.label, modifier = Modifier.weight(1f))
                    IconButton(
                        onClick = {
                            onUpdate { s -> s.copy(definitionOrder = moveUp(s.definitionOrder, index)) }
                        },
                        enabled = index > 0,
                    ) { Icon(Icons.Filled.ArrowUpward, contentDescription = "上移") }
                    IconButton(
                        onClick = {
                            onUpdate { s -> s.copy(definitionOrder = moveDown(s.definitionOrder, index)) }
                        },
                        enabled = index < settings.definitionOrder.lastIndex,
                    ) { Icon(Icons.Filled.ArrowDownward, contentDescription = "下移") }
                }
            }
            Text(
                "调整四个释义模块在卡片上的显示顺序",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // ---------------------------------------------------------- 冲突仲裁
        Section("冲突仲裁") {
            if (conflicts.isEmpty()) {
                Text(
                    "暂无冲突",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                conflicts.forEach { conflict ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            "${conflict.bookDisplayName} · ${if (conflict.kind.rawValue == "canvas") "单词内容" else "复习进度"}",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        if (conflict.changedWords.isNotEmpty()) {
                            Text(
                                "两版差异 ${conflict.changedWords.size} 处：${conflict.changedWords.take(5).joinToString("、")}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = { onResolveConflict(conflict, false) }) {
                                Text("保留主版本")
                            }
                            OutlinedButton(onClick = { onResolveConflict(conflict, true) }) {
                                Text("保留副本")
                            }
                        }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        content()
        HorizontalDivider()
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun StepperRow(label: String, value: Int, range: IntRange, onChange: (Int) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("$label $value", modifier = Modifier.weight(1f))
        TextButton(
            onClick = { onChange((value - 1).coerceIn(range)) },
            enabled = value > range.first,
        ) { Text("−") }
        TextButton(
            onClick = { onChange((value + 1).coerceIn(range)) },
            enabled = value < range.last,
        ) { Text("+") }
    }
}

@Composable
private fun LabelledField(
    label: String,
    value: String,
    isSecret: Boolean = false,
    onChange: (String) -> Unit,
) {
    var text by remember(value) { mutableStateOf(value) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        OutlinedTextField(
            value = text,
            onValueChange = {
                text = it
                onChange(it)
            },
            singleLine = !isSecret,
            visualTransformation = if (isSecret) {
                androidx.compose.ui.text.input.PasswordVisualTransformation()
            } else {
                androidx.compose.ui.text.input.VisualTransformation.None
            },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** 模块顺序上移；对应 iOS `.onMove` 的语义 */
internal fun moveUp(order: List<DefinitionModule>, index: Int): List<DefinitionModule> {
    if (index <= 0 || index > order.lastIndex) return order
    val next = order.toMutableList()
    val item = next.removeAt(index)
    next.add(index - 1, item)
    return next
}

/** 模块顺序下移 */
internal fun moveDown(order: List<DefinitionModule>, index: Int): List<DefinitionModule> {
    if (index < 0 || index >= order.lastIndex) return order
    val next = order.toMutableList()
    val item = next.removeAt(index)
    next.add(index + 1, item)
    return next
}

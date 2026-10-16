package com.notebar.app.ui.screens

import android.content.Intent
import android.net.Uri
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.notebar.app.data.DefinitionModule
import com.notebar.app.data.Settings
import com.notebar.app.sync.BaiduPanClient
import com.notebar.app.sync.BaiduPanConfig
import com.notebar.app.sync.BaiduPanSettings
import com.notebar.engine.sync.SyncConflict

/**
 * 设置页。逐块对应 iOS `SettingsView`：
 * 同步目录 / 百度网盘 / 外观 / 学习 / AI 释义 / 单词卡片显示顺序 / 冲突仲裁。
 *
 * 与 iOS 的差异（会在报告里说明）：
 * - 「选择目录」在 Android 上先落到 app 私有目录同步目录（SAF 目录选择器未接入）；
 * - 释义模块顺序用上 / 下移按钮代替 iOS 的拖拽把手（同一组动作，Android 更稳）；
 * - 「百度网盘」是 Android 独有的设置块（桌面端在插件设置页里，字段语义一致）。
 */
@Composable
fun SettingsScreen(
    settings: Settings,
    syncStatus: String,
    syncRoot: String?,
    conflicts: List<SyncConflict>,
    usingBaiduPan: Boolean,
    onSetSyncRoot: (String?) -> Unit,
    onSyncNow: () -> Unit,
    onUpdate: ((Settings) -> Settings) -> Unit,
    onResolveConflict: (SyncConflict, Boolean) -> Unit,
    /** 用授权码换 token（内部落盘）；结果经回调返回，文案**绝不含凭证** */
    onExchangeAuthCode: (code: String, onResult: (String) -> Unit) -> Unit = { _, onResult ->
        onResult("未接入")
    },
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

        // ------------------------------------------------------------ 百度网盘
        BaiduPanSection(
            config = settings.baiduPan,
            usingBaiduPan = usingBaiduPan,
            onChange = { next -> onUpdate { it.copy(baiduPan = next) } },
            onExchangeAuthCode = onExchangeAuthCode,
        )

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

/**
 * 百度网盘同步设置块（Android 独有，字段语义与桌面端插件设置页一致）。
 *
 * 凭证口径（红线）：AppKey / SecretKey / access_token / refresh_token 都**只读用户输入**，
 * 这里的输入框一律用密码遮罩；页面上不显示、不复制、不打印任何凭证。
 * 授权码是一次性交换用的，用后即清空（不只是清 UI 状态）。
 */
@Composable
private fun BaiduPanSection(
    config: BaiduPanSettings,
    usingBaiduPan: Boolean,
    onChange: (BaiduPanSettings) -> Unit,
    /** 用授权码换 token 并落盘；结果经 [onResult] 回调（**绝不含凭证**） */
    onExchangeAuthCode: (code: String, onResult: (String) -> Unit) -> Unit,
) {
    Section("百度网盘") {
        SwitchRow("启用百度网盘同步", config.enabled) { enabled ->
            onChange(config.copy(enabled = enabled))
        }
        Text(
            if (usingBaiduPan) {
                "当前后端：百度网盘 · ${config.wordsDir}"
            } else if (config.enabled) {
                "当前后端：本地目录（网盘配置不完整，已回退；见下方提示）"
            } else {
                "当前后端：本地目录"
            },
            style = MaterialTheme.typography.labelSmall,
            color = if (config.enabled && !usingBaiduPan) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )

        // AppKey 是**公开值**（就写在授权 URL 里），因此明文显示、便于自查；
        // 标签必须点明「不是 AppID」——真机反馈里用户被旧标签「AppKey（应用 ID）」误导，
        // 填了控制台的 AppID（124480177）→ 授权页报 invalid_client / unknown client id。
        val appKeyLooksValid = BaiduPanClient.looksLikeAppKey(config.appKey)
        LabelledField(
            label = "AppKey（应用 Key，不是 AppID）",
            value = config.appKey,
            isSecret = false,
            helper = when {
                config.appKey.isEmpty() -> "32 位字母数字：控制台「应用管理」里 AppID 下方那一行"
                appKeyLooksValid -> "格式正确（32 位）"
                else -> "格式不对：AppKey 应为 32 位字母数字，当前 ${config.appKey.length} 位。" +
                    "如果你填的是 124480177 这类纯数字，那其实是 AppID，不是 AppKey"
            },
            isError = config.appKey.isNotEmpty() && !appKeyLooksValid,
        ) { v -> onChange(config.copy(appKey = v.trim())) }

        LabelledField(
            label = "SecretKey",
            value = config.secretKey,
            isSecret = true,
            helper = "32 位字母数字；点右侧「显示」可核对是否填错",
        ) { v -> onChange(config.copy(secretKey = v.trim())) }

        // 授权码：换 token 用，一次性。交换开始后立刻从输入框清掉，不留在设置里。
        var authCode by remember { mutableStateOf("") }
        var authResult by remember { mutableStateOf<String?>(null) }

        // 授权链接入口（2026-10-17 加）：真机实测里用户失败的原因就是**拿到了旧的、已被消费过的授权码**
        // （浏览器里还开着上一次的授权页）。让他能在手机上现取现用，比任何错误提示都有效。
        val context = LocalContext.current
        val clipboard = LocalClipboardManager.current
        val authorizeUrl = remember(config.appKey) { BaiduPanClient.authorizeUrl(config.appKey) }

        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("第一步：打开授权链接并点「授权」", style = MaterialTheme.typography.labelMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = {
                        runCatching {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(authorizeUrl)))
                        }.onFailure { authResult = "无法打开浏览器：${it.message ?: "未知错误"}" }
                    },
                    enabled = appKeyLooksValid,
                ) { Text("打开授权链接") }
                OutlinedButton(
                    onClick = { clipboard.setText(AnnotatedString(authorizeUrl)) },
                    enabled = appKeyLooksValid,
                ) { Text("复制授权链接") }
            }
            Text(
                "第二步：把页面上显示的授权码复制下来（长按即可复制，或点页面上的「复制授权码」）",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text("第三步：粘贴到下面并点「换取令牌」", style = MaterialTheme.typography.labelMedium)
            OutlinedTextField(
                value = authCode,
                onValueChange = { authCode = it },
                singleLine = true,
                placeholder = { Text("粘贴百度下发的 code") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(
                onClick = {
                    val code = authCode.trim()
                    if (code.isEmpty()) return@OutlinedButton
                    authCode = ""
                    authResult = "授权中…"
                    onExchangeAuthCode(code) { result -> authResult = result }
                },
                enabled = authCode.isNotBlank() && config.isConfigured,
            ) { Text("换取令牌") }
            Text(
                "注意：授权码只能使用一次、且 10 分钟后过期；过期或已用过就必须重新打开授权链接取新码。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!config.isConfigured) {
                Text(
                    "先填 AppKey 与 SecretKey 才能换取令牌",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            authResult?.let { result ->
                Text(result, style = MaterialTheme.typography.labelSmall)
            }
        }

        LabelledField("沙箱目录名", config.dir) { v ->
            // 空值回落默认目录，与桌面端 normalizeBaiduPanSettings 同口径
            onChange(config.copy(dir = v.trim().ifEmpty { BaiduPanConfig.DEFAULT_DIR }))
        }

        Text(
            "网盘路径：${config.wordsDir}／边车：${config.wordsDir}/Words/*.nb-sync.json",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "凭证只保存在本机设置里，不会写进日志或拼进任何错误文案。" +
                "授权状态：" + when {
                    config.accessToken.isEmpty() -> "未授权"
                    config.expiresAt <= 0L -> "已授权（过期时间未知）"
                    else -> "已授权"
                },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "说明：网盘通道需要先填入 AppKey / SecretKey 并完成一次 OAuth 授权。" +
                "未过审应用每小时仅 10 次调用配额，因此网盘后端的轮询间隔为 5 分钟。",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
    helper: String? = null,
    isError: Boolean = false,
    /** 掩码字段是否提供「显示」开关（默认提供：真机反馈里填错却看不见，是最难自查的故障） */
    allowReveal: Boolean = true,
    onChange: (String) -> Unit,
) {
    var text by remember(value) { mutableStateOf(value) }
    var revealed by remember { mutableStateOf(false) }
    val masked = isSecret && !(allowReveal && revealed)

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        OutlinedTextField(
            value = text,
            onValueChange = {
                text = it
                onChange(it)
            },
            singleLine = true,
            isError = isError,
            visualTransformation = if (masked) {
                androidx.compose.ui.text.input.PasswordVisualTransformation()
            } else {
                androidx.compose.ui.text.input.VisualTransformation.None
            },
            trailingIcon = if (isSecret && allowReveal) {
                {
                    TextButton(onClick = { revealed = !revealed }) {
                        Text(if (revealed) "隐藏" else "显示", style = MaterialTheme.typography.labelSmall)
                    }
                }
            } else {
                null
            },
            modifier = Modifier.fillMaxWidth(),
        )
        helper?.let {
            Text(
                it,
                style = MaterialTheme.typography.labelSmall,
                color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
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

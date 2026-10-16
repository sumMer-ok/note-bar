package com.notebar.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.notebar.app.data.DefinitionModule
import com.notebar.app.domain.PhoneticExtractor
import com.notebar.app.domain.ReviewDirection
import com.notebar.app.domain.ReviewSessionState
import com.notebar.app.ui.components.DefinitionModulesView
import com.notebar.app.ui.components.EmptyState
import com.notebar.app.ui.components.GlassCard
import com.notebar.app.ui.theme.NoteBarColors
import com.notebar.app.ui.theme.wordColor
import com.notebar.engine.Entry
import com.notebar.engine.ReinforceSession

/**
 * 复习 / 学习界面。逐块对应 iOS `ReviewView`：
 *
 * 正常阶段：进度「X / Y」、撤销、「下次 X 天后」预览、翻面、四档评分
 * （按钮给不认识 / 模糊 / 认识；「太简单」由卡片上滑触发，与 iOS 的手势判定一致）。
 *
 * 强化阶段（仅学习模式触发，步骤二～五）：只有「不认识 / 认识」两个判定，
 * 判定只推进内存状态机，不写进度字段、不写边车（红线 3）。
 *
 * 状态与推进逻辑全在 [ReviewSessionState]（纯逻辑，可 JVM 单测），本文件只做渲染与交互。
 */
@Composable
fun ReviewScreen(
    state: ReviewSessionState,
    autoPronounce: Boolean,
    definitionOrder: List<DefinitionModule>,
    onRate: (Entry, ReviewDirection) -> Unit,
    onUndo: (Entry, com.notebar.engine.StudyProgress) -> Unit,
    onReinforceAnswer: (Boolean) -> Unit,
    onReinforcePassWord: () -> Unit,
    onReinforceContinue: () -> Unit,
    onReinforceExit: () -> Unit,
    onEditModule: (Entry, DefinitionModule) -> Unit,
    onSpeak: (String) -> Unit,
    onFinishGroup: () -> Unit,
    onAnotherGroup: () -> Unit,
    /** 状态每次变化后由调用方触发重组用的版本号 */
    version: Int,
) {
    var flipped by remember(version, state.activeCard?.studyKey) { mutableStateOf(state.flipped) }
    var showStuck by remember { mutableStateOf(false) }
    var showLimit by remember { mutableStateOf(false) }

    val session = state.reinforce
    val activeCard = state.activeCard

    // 发音：强化环节同一词会多轮重复出现，需带作答次数才会每轮重播（对应 iOS pronunciationID）
    val pronunciationId = if (session != null) {
        "${session.current}#${session.totalAnswers}"
    } else {
        state.current?.studyKey ?: ""
    }
    LaunchedEffect(pronunciationId, autoPronounce) {
        if (autoPronounce && activeCard != null) onSpeak(activeCard.word)
    }

    // 强化反馈驱动弹窗（对应 iOS answerReinforce 的 feedback.kind 分支）
    LaunchedEffect(state.lastFeedback, session?.totalAnswers, session?.isHalted) {
        when (state.lastFeedback?.kind) {
            com.notebar.engine.ReinforceFeedback.Kind.Stuck -> showStuck = true
            com.notebar.engine.ReinforceFeedback.Kind.LimitReached -> showLimit = true
            else -> Unit
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when {
            session != null && activeCard != null -> {
                ReinforceHeader(
                    round = session.round,
                    roundRemaining = session.roundRemainingCount,
                    seenCount = session.seenCount(activeCard.studyKey),
                    seedSize = session.seed.size,
                    onExit = onReinforceExit,
                )
                Box(
                    modifier = Modifier.weight(1f).fillMaxWidth().clickable { flipped = !flipped },
                ) {
                    CardBody(
                        entry = activeCard,
                        flipped = flipped,
                        order = definitionOrder,
                        onSpeak = onSpeak,
                        onEditModule = onEditModule,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                Text(
                    "强化环节的判定只用于本环节循环，不写入复习进度",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ReinforceButton("不认识", NoteBarColors.againRed, Modifier.weight(1f)) {
                        flipped = false
                        onReinforceAnswer(false)
                    }
                    ReinforceButton("认识", NoteBarColors.goodGreen, Modifier.weight(1f)) {
                        flipped = false
                        onReinforceAnswer(true)
                    }
                }
            }

            state.current != null -> {
                val current = state.current!!
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${state.index + 1} / ${state.queue.size}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.weight(1f))
                    TextButton(
                        onClick = {
                            state.undo()?.let { (entry, progress) -> onUndo(entry, progress) }
                            flipped = false
                        },
                        enabled = state.canUndo,
                    ) { Text("撤销") }
                }

                SwipeableCard(
                    entry = current,
                    flipped = flipped,
                    order = definitionOrder,
                    onFlip = { flipped = !flipped },
                    onSpeak = onSpeak,
                    onEditModule = onEditModule,
                    onRate = { dir ->
                        flipped = false
                        onRate(current, dir)
                    },
                    modifier = Modifier.weight(1f),
                )

                state.preview?.let {
                    Text(
                        "下次 $it",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RateButton("不认识", NoteBarColors.againRed, Modifier.weight(1f)) {
                        flipped = false
                        onRate(current, ReviewDirection.again)
                    }
                    RateButton("模糊", NoteBarColors.hardGray, Modifier.weight(1f)) {
                        flipped = false
                        onRate(current, ReviewDirection.hard)
                    }
                    RateButton("认识", NoteBarColors.goodGreen, Modifier.weight(1f)) {
                        flipped = false
                        onRate(current, ReviewDirection.good)
                    }
                }
            }

            else -> {
                EmptyState(
                    title = "本组完成",
                    description = "本轮卡片已全部完成",
                    modifier = Modifier.weight(1f),
                )
                state.reinforceSummary?.let { summary ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "不熟词强化已通过：${summary.wordCount} 词 · ${summary.totalAnswers} 次作答 · ${summary.rounds} 轮",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (summary.hardestWords.isNotEmpty()) {
                            Text(
                                "反复最多次：${summary.hardestWords.joinToString("、")}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = onFinishGroup, modifier = Modifier.weight(1f)) { Text("完成本组") }
                    OutlinedButton(onClick = onAnotherGroup, modifier = Modifier.weight(1f)) { Text("再学一组") }
                }
            }
        }
    }

    if (showStuck) {
        AlertDialog(
            onDismissRequest = { showStuck = false },
            title = { Text("这个词已连续答错 ${ReinforceSession.STUCK_THRESHOLD} 次") },
            text = { Text("强化环节的判定不会影响复习进度，可以放心多练几轮。") },
            confirmButton = {
                TextButton(onClick = {
                    showStuck = false
                    onReinforcePassWord()
                }) { Text("看释义再判一次") }
            },
            dismissButton = {
                TextButton(onClick = {
                    showStuck = false
                    onReinforcePassWord()
                }) { Text("标记为认识并移出") }
            },
        )
    }

    if (showLimit) {
        AlertDialog(
            onDismissRequest = { showLimit = false },
            title = { Text("强化已暂停") },
            text = {
                Text("本组已作答 ${session?.totalAnswers ?: 0} 次仍未全部通过。先退出、下次继续也可以。")
            },
            confirmButton = {
                TextButton(onClick = {
                    showLimit = false
                    onReinforceContinue()
                }) { Text("继续强化") }
            },
            dismissButton = {
                TextButton(onClick = {
                    showLimit = false
                    onReinforceExit()
                }) { Text("结束强化") }
            },
        )
    }
}

/** 强化环节进度头。对应 iOS `reinforceHeader` */
@Composable
private fun ReinforceHeader(
    round: Int,
    roundRemaining: Int,
    seenCount: Int,
    seedSize: Int,
    onExit: () -> Unit,
) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                "不熟词强化 · 第 $round 轮 · 本轮剩 $roundRemaining 词",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "本词第 $seenCount 次出现 · 共 $seedSize 个不熟词",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.weight(1f))
        TextButton(onClick = onExit) { Text("退出强化") }
    }
}

@Composable
private fun ReinforceButton(title: String, color: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = modifier.height(48.dp),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = color.copy(alpha = 0.18f), contentColor = color),
    ) { Text(title) }
}

@Composable
private fun RateButton(title: String, color: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = modifier.height(48.dp),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = color.copy(alpha = 0.18f), contentColor = color),
    ) { Text(title) }
}

/** 可滑动评分的卡片：左右 = 不认识/认识，上下 = 太简单/模糊（对应 iOS `direction(for:)`） */
@Composable
private fun SwipeableCard(
    entry: Entry,
    flipped: Boolean,
    order: List<DefinitionModule>,
    onFlip: () -> Unit,
    onSpeak: (String) -> Unit,
    onEditModule: (Entry, DefinitionModule) -> Unit,
    onRate: (ReviewDirection) -> Unit,
    modifier: Modifier = Modifier,
) {
    var dragX by remember(entry.studyKey) { mutableStateOf(0f) }
    var dragY by remember(entry.studyKey) { mutableStateOf(0f) }
    val threshold = 240f

    Box(
        modifier = modifier
            .fillMaxWidth()
            .pointerInput(entry.studyKey) {
                detectDragGestures(
                    onDragEnd = {
                        val dx = dragX
                        val dy = dragY
                        dragX = 0f
                        dragY = 0f
                        if (maxOf(kotlin.math.abs(dx), kotlin.math.abs(dy)) < threshold) {
                            return@detectDragGestures
                        }
                        onRate(
                            when {
                                kotlin.math.abs(dx) >= kotlin.math.abs(dy) ->
                                    if (dx < 0) ReviewDirection.again else ReviewDirection.good
                                dy < 0 -> ReviewDirection.easy
                                else -> ReviewDirection.hard
                            },
                        )
                    },
                    onDrag = { change, amount ->
                        change.consume()
                        dragX += amount.x
                        dragY += amount.y
                    },
                )
            }
            .clickable(onClick = onFlip),
    ) {
        CardBody(entry, flipped, order, onSpeak, onEditModule)
        val activeDir = when {
            kotlin.math.abs(dragX) < 24f && kotlin.math.abs(dragY) < 24f -> null
            kotlin.math.abs(dragX) >= kotlin.math.abs(dragY) ->
                if (dragX < 0) ReviewDirection.again else ReviewDirection.good
            dragY < 0 -> ReviewDirection.easy
            else -> ReviewDirection.hard
        }
        if (activeDir != null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    activeDir.label,
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(colorOf(activeDir), RoundedCornerShape(50))
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
        }
    }
}

/**
 * 卡片正反面。正面：单词 + 发音 + 提示；背面：单词 + 音标发音按钮 + 释义模块。
 * 对应 iOS `ReviewView.cardFace(_:back:)`。
 */
@Composable
private fun CardBody(
    entry: Entry,
    flipped: Boolean,
    order: List<DefinitionModule>,
    onSpeak: (String) -> Unit,
    onEditModule: (Entry, DefinitionModule) -> Unit,
    modifier: Modifier = Modifier,
) {
    GlassCard(modifier = modifier.fillMaxSize()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            if (!flipped) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(entry.word, fontSize = 34.sp, fontWeight = FontWeight.Bold, color = wordColor())
                    TextButton(onClick = { onSpeak(entry.word) }) {
                        Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = "发音")
                    }
                    Text(
                        "点击翻面 · 四向滑动评分",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                Column(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        entry.word,
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        color = wordColor(),
                    )
                    val phonetic = PhoneticExtractor.phonetic(entry.definition)
                    if (phonetic != null) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.clickable { onSpeak(entry.word) },
                        ) {
                            Text(
                                phonetic,
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.width(8.dp))
                            Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = "发音", tint = Color(0xFF2196F3))
                        }
                    }
                    DefinitionModulesView(
                        raw = entry.definition,
                        order = order,
                        onEdit = { module -> onEditModule(entry, module) },
                    )
                }
            }
        }
    }
}

internal fun colorOf(dir: ReviewDirection): Color = when (dir) {
    ReviewDirection.again -> NoteBarColors.againRed
    ReviewDirection.hard -> NoteBarColors.hardGray
    ReviewDirection.good -> NoteBarColors.goodGreen
    ReviewDirection.easy -> NoteBarColors.easyOrange
}

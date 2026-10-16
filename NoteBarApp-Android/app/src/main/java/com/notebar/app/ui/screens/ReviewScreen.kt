package com.notebar.app.ui.screens

import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.notebar.app.data.DefinitionModule
import com.notebar.app.domain.PhoneticExtractor
import com.notebar.app.domain.ReviewDirection
import com.notebar.app.domain.ReviewSessionState
import com.notebar.app.ui.components.FlipCard
import kotlinx.coroutines.launch
import kotlin.math.abs
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

/**
 * 与 iOS `ReviewView.direction(for:)` 同构：死区以内返回 null，否则按主轴判方向。
 *
 * 两处调用传不同死区：拖拽中显示方向徽标用 24px；松手是否算数用评分阈值（240px）。
 */
private fun directionOf(dx: Float, dy: Float, deadZone: Float): ReviewDirection? {
    if (abs(dx) < deadZone && abs(dy) < deadZone) return null
    if (abs(dx) >= abs(dy)) return if (dx < 0) ReviewDirection.again else ReviewDirection.good
    return if (dy < 0) ReviewDirection.easy else ReviewDirection.hard
}

/**
 * 可滑动评分的卡片：左右 = 不认识/认识，上下 = 太简单/模糊（对应 iOS `direction(for:)`）。
 *
 * 动画对齐 iOS `ReviewView`（2026-10-17 补，此前 Android 侧只有裸 float 位移，松手瞬间归零、
 * 过阈值直接切下一张，观感是"卡片突然消失"）：
 * - **翻面**：与 iOS `FlipView` 同构——正面绕 Y 轴 0→180°、背面 -180°→0，
 *   且**过半（90°）才切可见面**，避免两层同时可见产生残影；点按触发 spring(≈0.45s)；
 * - **未过阈值松手**：弹簧归位；
 * - **过阈值松手**：先按 iOS `flyOffset` 飞出（主轴 ±1.3 屏，easeOut 0.38s），
 *   **飞出结束后才评分**并切下一张；期间用 `flying` 拦住重复手势。
 */
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
    val key = entry.studyKey
    var dragX by remember(key) { mutableStateOf(0f) }
    var dragY by remember(key) { mutableStateOf(0f) }
    var flying by remember(key) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current.density
    val configuration = LocalConfiguration.current
    val screenW = configuration.screenWidthDp * density
    val screenH = configuration.screenHeightDp * density
    val threshold = 240f

    Box(
        modifier = modifier
            .fillMaxWidth()
            .graphicsLayer {
                translationX = dragX
                translationY = dragY
                // 拖拽时轻微倾斜，手感更接近 iOS
                rotationZ = (dragX / 60f).coerceIn(-10f, 10f)
            }
            .pointerInput(key) {
                detectDragGestures(
                    onDragEnd = {
                        if (flying) return@detectDragGestures
                        val dx = dragX
                        val dy = dragY
                        val dir = directionOf(dx, dy, threshold)
                        if (dir == null) {
                            // 未过阈值：弹簧归位
                            scope.launch {
                                val startX = dragX
                                val startY = dragY
                                animate(
                                    initialValue = 0f,
                                    targetValue = 1f,
                                    animationSpec = spring(
                                        dampingRatio = Spring.DampingRatioNoBouncy,
                                        stiffness = Spring.StiffnessMediumLow,
                                    ),
                                ) { t, _ ->
                                    dragX = startX * (1f - t)
                                    dragY = startY * (1f - t)
                                }
                                dragX = 0f
                                dragY = 0f
                            }
                        } else {
                            // 过阈值：先飞出屏幕，飞出结束再评分（对应 iOS 的 0.38s + asyncAfter）
                            flying = true
                            scope.launch {
                                val startX = dragX
                                val startY = dragY
                                val targetX: Float
                                val targetY: Float
                                when (dir) {
                                    ReviewDirection.again -> { targetX = -screenW * 1.3f; targetY = startY }
                                    ReviewDirection.good -> { targetX = screenW * 1.3f; targetY = startY }
                                    ReviewDirection.easy -> { targetX = startX; targetY = -screenH * 1.3f }
                                    ReviewDirection.hard -> { targetX = startX; targetY = screenH * 1.3f }
                                }
                                animate(
                                    initialValue = 0f,
                                    targetValue = 1f,
                                    animationSpec = tween(
                                        durationMillis = 380,
                                        easing = LinearOutSlowInEasing,
                                    ),
                                ) { t, _ ->
                                    dragX = startX + (targetX - startX) * t
                                    dragY = startY + (targetY - startY) * t
                                }
                                onRate(dir)
                                dragX = 0f
                                dragY = 0f
                                flying = false
                            }
                        }
                    },
                    onDrag = { change, amount ->
                        if (flying) return@detectDragGestures
                        change.consume()
                        dragX += amount.x
                        dragY += amount.y
                    },
                )
            }
            .clickable(onClick = onFlip),
    ) {
        // 正反两面交给共享的 FlipCard（与 iOS FlipView 同构，见其注释）
        FlipCard(
            flipped = flipped,
            stateKey = key,
            modifier = Modifier.fillMaxSize(),
            front = { CardBody(entry, false, order, onSpeak, onEditModule) },
            back = { CardBody(entry, true, order, onSpeak, onEditModule) },
        )

        val activeDir = directionOf(dragX, dragY, deadZone = 24f)
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

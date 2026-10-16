package com.notebar.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.notebar.app.data.DefinitionModule
import com.notebar.app.domain.DefinitionSections
import com.notebar.engine.Entry
import com.notebar.engine.StudyKey
import kotlinx.coroutines.delay

/**
 * 听写答题会话状态（纯逻辑，可 JVM 单测）。对应 iOS `DictationView` 的 `@State` 集合。
 *
 * 判定口径逐行照抄 iOS：
 * - 比较前双方都走 `StudyKey.normalizeText`（NFKC + 折叠空白 + 去首尾标点 + 小写）；
 * - 别名（aliases）同样算正确；
 * - **结算只按第一次输入判定**（`firstResults`），后续重试不改变结算；
 * - 拼错时显示答案并抖动；正确且开启自动下一个时延时推进。
 */
class DictationSessionState(initialQueue: List<Entry>) {

    var queue: List<Entry> = initialQueue
        private set

    var index: Int = 0
        private set

    var input: String = ""
        private set

    var message: String? = null
        private set

    var answered: Boolean = false
        private set

    var lastCorrect: Boolean = false
        private set

    var revealAnswer: Boolean = false
        private set

    /** 抖动计数（UI 用它触发动画） */
    var shakeCount: Int = 0
        private set

    /** 每个词**第一次**输入是否正确；key = studyKey */
    val firstResults: MutableMap<String, Boolean> = linkedMapOf()

    val current: Entry? get() = queue.getOrNull(index)

    val isFinished: Boolean get() = index >= queue.size

    fun onInputChange(value: String) {
        input = value
    }

    /**
     * 检查当前输入。
     *
     * @return true 表示拼写正确
     */
    fun check(): Boolean {
        val entry = current ?: return false
        val normalized = StudyKey.normalizeText(input)
        val ok = normalized == StudyKey.normalizeText(entry.word) ||
            entry.aliases.any { StudyKey.normalizeText(it) == normalized }

        if (!firstResults.containsKey(entry.studyKey)) {
            firstResults[entry.studyKey] = ok
        }

        if (ok) {
            lastCorrect = true
            answered = true
            revealAnswer = false
            message = "正确 ✓"
        } else {
            message = "拼写错误，请重试"
            shakeCount += 1
            revealAnswer = true
        }
        return ok
    }

    /** 推进到下一题 */
    fun advance() {
        input = ""
        message = null
        answered = false
        lastCorrect = false
        revealAnswer = false
        index += 1
    }

    /** 结算：按第一次输入统计正确 / 错误 */
    fun correctEntries(): List<Entry> = queue.filter { firstResults[it.studyKey] == true }

    fun wrongEntries(): List<Entry> = queue.filter { firstResults[it.studyKey] == false }

    /** 再写一遍：只重做本轮写错的词。对应 iOS `restart(withWrong:)` */
    fun restartWithWrong() {
        val wrong = wrongEntries()
        resetSession(wrong)
    }

    /** 下一组：用同一范围排除本轮已用过的词。对应 iOS `nextGroup()` */
    fun nextGroup(all: List<Entry>, books: Set<String>, dates: Set<String>, limit: Int) {
        val next = com.notebar.app.domain.StudyScope.buildDictationQueue(
            entries = all,
            books = books,
            dates = dates,
            limit = limit,
            excluded = queue.map { it.studyKey }.toSet(),
        )
        resetSession(next)
    }

    private fun resetSession(next: List<Entry>) {
        queue = next
        index = 0
        input = ""
        message = null
        answered = false
        lastCorrect = false
        revealAnswer = false
        shakeCount = 0
        firstResults.clear()
    }
}

/**
 * 听写答题页。逐块对应 iOS `DictationView`：
 * 提示（只显示词典释义，回退 AI 释义，再回退「（无释义）」）、拼写输入、
 * 「🔊 点击音标朗读」、「检查 / 下一个」、错误时显示答案、结算页与「再写一遍 / 下一组」。
 */
@Composable
fun DictationScreen(
    state: DictationSessionState,
    autoAdvance: Boolean,
    onSpeak: (String) -> Unit,
    onNextGroup: () -> Unit,
    /** 状态版本号，驱动重组 */
    version: Int,
) {
    val entry = state.current
    if (entry == null) {
        SettlementView(state = state, onSpeak = onSpeak, onNextGroup = onNextGroup)
        return
    }

    var input by remember(entry.studyKey, version) { mutableStateOf(state.input) }

    // 正确后自动下一个：延时 1.2s（对应 iOS `DispatchQueue.main.asyncAfter(.now() + 1.2)`）
    LaunchedEffect(state.answered, state.lastCorrect, autoAdvance, state.index) {
        if (autoAdvance && state.lastCorrect && state.answered) {
            delay(1200)
            state.advance()
            input = ""
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Text(
            "听写 ${state.index + 1} / ${state.queue.size}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Text(
            text = promptFor(entry),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 160.dp)
                .background(
                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    RoundedCornerShape(24.dp),
                )
                .padding(16.dp),
        )

        OutlinedTextField(
            value = input,
            onValueChange = {
                input = it
                state.onInputChange(it)
            },
            placeholder = { Text("拼写英文单词") },
            singleLine = true,
            enabled = !(state.lastCorrect && state.answered),
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(
                onDone = { state.check() },
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        TextButton(onClick = { onSpeak(entry.word) }) { Text("🔊 点击音标朗读") }

        state.message?.let { message ->
            Text(
                message,
                style = MaterialTheme.typography.bodyMedium,
                color = if (message.contains("正确")) Color(0xFF2E8B57) else MaterialTheme.colorScheme.error,
            )
        }

        if (state.revealAnswer) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(entry.word, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                IconButton(onClick = { onSpeak(entry.word) }) {
                    Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = "发音", tint = Color(0xFF2196F3))
                }
            }
        }

        Spacer(Modifier.height(4.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(
                onClick = { state.check() },
                enabled = !(state.lastCorrect && state.answered) && input.trim().isNotEmpty(),
                modifier = Modifier.weight(1f),
            ) { Text("检查", fontWeight = FontWeight.Bold) }

            OutlinedButton(
                onClick = {
                    state.advance()
                    input = ""
                },
                modifier = Modifier.weight(1f),
            ) { Text("下一个", fontWeight = FontWeight.Bold) }
        }
    }
}

/** 结算页。对应 iOS `DictationView.settlementView` */
@Composable
private fun SettlementView(
    state: DictationSessionState,
    onSpeak: (String) -> Unit,
    onNextGroup: () -> Unit,
) {
    val correct = state.correctEntries()
    val wrong = state.wrongEntries()

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            "本轮完成",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Text(
            "正确 ${correct.size} / ${state.queue.size}（按第一次输入判定）",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        LazyColumn(modifier = Modifier.weight(1f)) {
            items(state.queue, key = { it.studyKey }) { entry ->
                val ok = state.firstResults[entry.studyKey] == true
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = if (ok) Icons.Filled.CheckCircle else Icons.Filled.Cancel,
                        contentDescription = null,
                        tint = if (ok) Color(0xFF2E8B57) else MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.padding(horizontal = 4.dp))
                    Text(entry.word, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.weight(1f))
                    IconButton(onClick = { onSpeak(entry.word) }) {
                        Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = "发音", tint = Color(0xFF2196F3))
                    }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(
                onClick = { state.restartWithWrong() },
                enabled = wrong.isNotEmpty(),
                modifier = Modifier.weight(1f),
            ) { Text("再写一遍", fontWeight = FontWeight.Bold) }

            OutlinedButton(onClick = onNextGroup, modifier = Modifier.weight(1f)) {
                Text("下一组", fontWeight = FontWeight.Bold)
            }
        }
    }
}

/**
 * 听写提示：只显示「词典释义」，没有则回退「AI 释义」，再没有就「（无释义）」。
 * 逐行对应 iOS `DictationView.prompt(for:)`。
 */
internal fun promptFor(entry: Entry): String {
    val dictionary = DefinitionSections.content(entry.definition, DefinitionModule.dictionary)
    if (dictionary.isNotEmpty()) return dictionary
    val ai = DefinitionSections.content(entry.definition, DefinitionModule.ai)
    if (ai.isNotEmpty()) return ai
    return "（无释义）"
}

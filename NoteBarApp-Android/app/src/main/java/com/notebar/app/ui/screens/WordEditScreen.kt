package com.notebar.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.notebar.app.data.DefinitionModule
import com.notebar.app.domain.DefinitionSections
import com.notebar.engine.Entry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 保存结果。由宿主体检（[com.notebar.app.ui.AppViewModel.saveWordEdit]）产出，
 * UI 据此决定「留在编辑页报错」还是「可以退出」。
 *
 * @param saved 本地是否已落库。false → 一律不退出（否则就是「点了保存却回到原界面」）
 * @param canvasWritten `.canvas` 是否已同步；false 但 saved=true 只是「待回推」，不拦退出
 * @param error saved=false 时的可读原因
 */
data class WordEditSaveOutcome(
    val saved: Boolean,
    val canvasWritten: Boolean = true,
    val error: String? = null,
)

/**
 * 单词编辑。逐块对应 iOS `WordEditSheet` + `WordDetailView` 的生成按钮：
 * 单词 / 别名（逗号分隔）/ 每个释义模块一个可折叠输入框；
 * ai / legal / notes 三个模块各带一个「AI 生成 / AI 纠正」按钮，
 * dictionary 模块带一个「查词典」按钮（对应桌面 `autoFillFromDictionary`）。
 * 保存时按 `definitionOrder` 逐模块 `DefinitionSections.update` 序列化，并置 `localEditedAt`。
 *
 * 判定逻辑（按钮可见性、拦截文案、提示词选择、别名回填、成功文案）全部在
 * [WordEditAiActions]，本文件只负责把 Compose 状态接进去——这样纯函数可以被 JVM 单测覆盖。
 *
 * [aiRuntime] 为 null 时整块 AI/词典入口不渲染（预览与未注入的调用方保持原样）。
 */
@Composable
fun WordEditScreen(
    entry: Entry,
    definitionOrder: List<DefinitionModule>,
    focusModule: DefinitionModule?,
    onCancel: () -> Unit,
    onSaved: (WordEditSaveOutcome) -> Unit,
    onSave: suspend (word: String, aliases: List<String>, contents: Map<DefinitionModule, String>) -> WordEditSaveOutcome,
    aiRuntime: WordEditAiRuntime? = null,
) {
    var word by remember(entry.studyKey) { mutableStateOf(entry.word) }
    var aliasesText by remember(entry.studyKey) {
        mutableStateOf(entry.aliases.joinToString(", "))
    }
    var contents by remember(entry.studyKey) {
        mutableStateOf(
            DefinitionModule.allCases.associateWith { module ->
                DefinitionSections.content(entry.definition, module)
            },
        )
    }
    var expanded by remember(entry.studyKey) {
        mutableStateOf(
            buildSet {
                add(DefinitionModule.dictionary)
                if (focusModule != null) add(focusModule)
            },
        )
    }

    val scope = rememberCoroutineScope()
    // 正在请求的模块（同一时刻只允许一个），用于禁用按钮与换文案
    var generating by remember(entry.studyKey) { mutableStateOf<DefinitionModule?>(null) }
    // 每个模块独立一行反馈（iOS `messageByModule`）
    var messageByModule by remember(entry.studyKey) {
        mutableStateOf(emptyMap<DefinitionModule, String>())
    }

    // 保存自身也要有状态：以前 onSave 是 fire-and-forget，失败静默、界面照退
    var saving by remember(entry.studyKey) { mutableStateOf(false) }
    var saveError by remember(entry.studyKey) { mutableStateOf<String?>(null) }

    fun setMessage(module: DefinitionModule, message: String?) {
        messageByModule =
            if (message == null) messageByModule - module else messageByModule + (module to message)
    }

    fun failureMessage(error: Throwable): String =
        error.localizedMessage ?: WordEditAiActions.UNKNOWN_ERROR_MESSAGE

    /** 逐条对齐 iOS `WordDetailView.generate(_:)`。 */
    fun generate(module: DefinitionModule) {
        val runtime = aiRuntime ?: return
        val blocked = WordEditAiActions.blockedMessage(module, word, contents)
        if (blocked != null) {
            setMessage(module, blocked)
            return
        }
        setMessage(module, null)
        generating = module
        scope.launch {
            try {
                val result = runtime.fetch(
                    word.trim(),
                    WordEditAiActions.sentenceFor(module, contents),
                    runtime.config(module),
                )
                contents = contents + (module to result.definition)
                if (WordEditAiActions.shouldFillAliases(module, aliasesText, result.aliases)) {
                    aliasesText = WordEditAiActions.aliasesText(result.aliases)
                }
                expanded = expanded + module
                setMessage(module, WordEditAiActions.successMessage(module))
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                setMessage(module, failureMessage(error))
            } finally {
                generating = null
            }
        }
    }

    /** 本地词典填充，对应桌面 `autoFillFromDictionary`（命中即覆盖「词典释义」正文）。 */
    fun lookupDictionary() {
        val runtime = aiRuntime ?: return
        val cleanWord = word.trim()
        if (cleanWord.isEmpty()) {
            setMessage(DefinitionModule.dictionary, WordEditAiActions.EMPTY_WORD_MESSAGE)
            return
        }
        setMessage(DefinitionModule.dictionary, null)
        generating = DefinitionModule.dictionary
        scope.launch {
            try {
                // 1.86 MB 词典首次解析不能压在主线程上
                val hit = withContext(Dispatchers.IO) { runtime.dictionary(cleanWord) }
                val fill = WordEditAiActions.dictionaryFill(hit)
                if (fill != null) {
                    contents = contents + (DefinitionModule.dictionary to fill)
                    expanded = expanded + DefinitionModule.dictionary
                }
                setMessage(DefinitionModule.dictionary, WordEditAiActions.dictionaryMessage(fill))
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                setMessage(DefinitionModule.dictionary, failureMessage(error))
            } finally {
                generating = null
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("编辑单词", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)

        OutlinedTextField(
            value = word,
            onValueChange = { word = it },
            label = { Text("单词") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = aliasesText,
            onValueChange = { aliasesText = it },
            label = { Text("别名（逗号分隔）") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        definitionOrder.forEach { module ->
            val isExpanded = expanded.contains(module)
            val busy = generating == module
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                        RoundedCornerShape(18.dp),
                    )
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            expanded = if (isExpanded) expanded - module else expanded + module
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(module.label, style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.weight(1f))
                    if (aiRuntime != null) {
                        if (module == DefinitionModule.dictionary) {
                            TextButton(
                                onClick = { lookupDictionary() },
                                enabled = generating == null,
                            ) {
                                Text(
                                    if (busy) "查询中…" else "查词典",
                                    style = MaterialTheme.typography.labelMedium,
                                )
                            }
                        } else if (WordEditAiActions.showsGenerateButton(module)) {
                            TextButton(
                                onClick = { generate(module) },
                                enabled = generating == null,
                            ) {
                                Text(
                                    if (busy) "生成中…"
                                    else WordEditAiActions.generateButtonLabel(module),
                                    style = MaterialTheme.typography.labelMedium,
                                )
                            }
                        }
                    }
                    Icon(
                        imageVector = if (isExpanded) Icons.Filled.KeyboardArrowDown
                        else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (isExpanded) {
                    OutlinedTextField(
                        value = contents[module] ?: "",
                        onValueChange = { contents = contents + (module to it) },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
                    )
                }
                // 反馈行放在折叠判断外：拦截文案（如「请先输入单词」）在折叠时也要看得见
                messageByModule[module]?.let { message ->
                    Text(
                        message,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (WordEditAiActions.isSuccessMessage(message)) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.error
                        },
                    )
                }
            }
        }

        saveError?.let { message ->
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = onCancel, enabled = !saving) { Text("取消") }
            Button(
                enabled = !saving,
                onClick = {
                    val parsedAliases = aliasesText.split(",")
                        .map { it.trim() }
                        .filter { it.isNotEmpty() }
                    saving = true
                    saveError = null
                    scope.launch {
                        try {
                            val result = onSave(word, parsedAliases, contents)
                            if (result.saved) {
                                // 本地已经存住了就必须退出：把用户扣在编辑页只会以为「没保存」。
                                // 「画布暂未写成功」由宿主在状态行提示，见 AppRoot 的 onSaved。
                                onSaved(result)
                            } else {
                                saveError = result.error ?: WordEditAiActions.SAVE_FAILED_MESSAGE
                            }
                        } catch (cancellation: CancellationException) {
                            throw cancellation
                        } catch (error: Throwable) {
                            saveError = error.localizedMessage ?: WordEditAiActions.SAVE_FAILED_MESSAGE
                        } finally {
                            saving = false
                        }
                    }
                },
                modifier = Modifier.weight(1f),
            ) { Text(if (saving) "保存中…" else "保存") }
        }
    }
}

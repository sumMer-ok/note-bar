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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.notebar.app.data.DefinitionModule
import com.notebar.app.domain.DefinitionSections
import com.notebar.engine.Entry

/**
 * 单词编辑。逐块对应 iOS `WordEditSheet`：
 * 单词 / 别名（逗号分隔）/ 每个释义模块一个可折叠输入框；保存时
 * 按 `definitionOrder` 逐模块 `DefinitionSections.update` 序列化，并置 `localEditedAt`。
 *
 * 未移植：AI 生成 / AI 纠正按钮（iOS 走 `AIDefinitionService`）。
 * 说明见报告「UI 未接完的部分」。
 */
@Composable
fun WordEditScreen(
    entry: Entry,
    definitionOrder: List<DefinitionModule>,
    focusModule: DefinitionModule?,
    onCancel: () -> Unit,
    onSave: (word: String, aliases: List<String>, contents: Map<DefinitionModule, String>) -> Unit,
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
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = onCancel) { Text("取消") }
            Button(
                onClick = {
                    val parsedAliases = aliasesText.split(",")
                        .map { it.trim() }
                        .filter { it.isNotEmpty() }
                    onSave(word, parsedAliases, contents)
                },
                modifier = Modifier.weight(1f),
            ) { Text("保存") }
        }
    }
}

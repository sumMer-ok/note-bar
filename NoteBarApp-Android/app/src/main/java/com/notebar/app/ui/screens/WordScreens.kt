package com.notebar.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
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
import com.notebar.app.domain.ProficiencyBand
import com.notebar.app.domain.StudyScope
import com.notebar.app.ui.components.DefinitionModulesView
import com.notebar.app.ui.components.EmptyState
import com.notebar.app.ui.components.FlipCard
import com.notebar.app.ui.components.GlassCard
import com.notebar.app.ui.theme.wordColor
import com.notebar.engine.Entry

/** 词表分组方式。对应 iOS `WordListView.Grouping`（文案照抄） */
enum class WordGrouping(val title: String) {
    date("按日期"),
    letter("按首字母"),
    proficiency("按熟练度"),
}

/** 词表里的一条分组 */
data class WordSection(val key: String, val title: String, val entries: List<Entry>)

/**
 * 词表分组算法。逐行对应 iOS `WordListView.sections`，
 * 包括「按日期倒序」「按首字母升序」「按熟练度固定分档顺序」三种排序。
 */
object WordGroupingLogic {

    fun sections(entries: List<Entry>, grouping: WordGrouping): List<WordSection> =
        when (grouping) {
            WordGrouping.date -> {
                val groups = entries.groupBy { it.addedDate ?: "无日期" }
                groups.keys.sortedDescending().map { key ->
                    WordSection("D-$key", key, groups.getValue(key).sortedBy { it.word })
                }
            }

            WordGrouping.letter -> {
                val groups = entries.groupBy { it.word.take(1).uppercase() }
                groups.keys.sorted().map { key ->
                    WordSection("L-$key", key, groups.getValue(key).sortedBy { it.word })
                }
            }

            WordGrouping.proficiency -> ProficiencyBand.bands.map { band ->
                WordSection(
                    "P-${band.label}",
                    band.label,
                    entries.filter { StudyScope.proficiency(it) == band }.sortedBy { it.word },
                )
            }
        }

    /** 按词 / 别名 / 释义过滤。对应 iOS `WordListView.filtered` 的搜索分支 */
    fun filter(entries: List<Entry>, query: String): List<Entry> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return entries
        return entries.filter { entry ->
            entry.word.lowercase().contains(q) ||
                entry.aliases.any { it.lowercase().contains(q) } ||
                entry.definition.lowercase().contains(q)
        }
    }
}

/**
 * 词表。对应 iOS `WordListView`：
 * 分组切换（按日期 / 按首字母 / 按熟练度）、搜索、「单词 | 熟练度 | 编辑」行。
 *
 * 未移植：iOS 右侧的索引进度条（IndexRail）与 `scrollPosition` 联动。
 * 说明见报告「UI 未接完的部分」。
 */
@Composable
fun WordListScreen(
    entries: List<Entry>,
    book: String?,
    onOpenWord: (Entry) -> Unit,
    onEditWord: (Entry) -> Unit,
) {
    var grouping by remember { mutableStateOf(WordGrouping.date) }
    var search by remember { mutableStateOf("") }
    var bookFilter by remember(book) { mutableStateOf(book) }

    val scoped = remember(entries, bookFilter) {
        if (bookFilter == null) entries else entries.filter { it.book == bookFilter }
    }
    val filtered = remember(scoped, search) { WordGroupingLogic.filter(scoped, search) }
    val sections = remember(filtered, grouping) { WordGroupingLogic.sections(filtered, grouping) }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (bookFilter == null) "全部词库" else displayName(bookFilter!!),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.weight(1f))
            if (bookFilter != null) {
                TextButton(onClick = { bookFilter = null }) { Text("全部词库") }
            }
        }

        OutlinedTextField(
            value = search,
            onValueChange = { search = it },
            placeholder = { Text("搜索单词、别名或释义") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        )

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            WordGrouping.entries.forEach { option ->
                AssistChip(
                    onClick = { grouping = option },
                    label = { Text(option.title) },
                    leadingIcon = if (grouping == option) {
                        { Text("●", color = MaterialTheme.colorScheme.primary) }
                    } else {
                        null
                    },
                )
            }
        }

        if (sections.isEmpty()) {
            EmptyState("没有匹配的单词", "换个关键词，或先同步词库", modifier = Modifier.weight(1f))
        } else {
            LazyColumn(modifier = Modifier.weight(1f)) {
                sections.forEach { section ->
                    item(key = "header-${section.key}") {
                        Text(
                            section.title,
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                                .padding(horizontal = 16.dp, vertical = 6.dp),
                        )
                    }
                    items(section.entries, key = { it.studyKey }) { entry ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onOpenWord(entry) }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(entry.word, color = wordColor())
                            Spacer(Modifier.weight(1f))
                            Text(
                                StudyScope.proficiency(entry).label,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            IconButton(onClick = { onEditWord(entry) }) {
                                Icon(
                                    Icons.Filled.Edit,
                                    contentDescription = "编辑",
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * 词详情。对应 iOS `WordDetailView`：
 * 单词 + 发音、四模块释义、「记忆稳定度」进度条与「下次」日期、编辑 / 删除。
 */
@Composable
fun WordDetailScreen(
    entry: Entry,
    definitionOrder: List<DefinitionModule>,
    onSpeak: (String) -> Unit,
    onEditModule: (DefinitionModule) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                entry.word,
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold,
                color = wordColor(),
            )
            Spacer(Modifier.padding(horizontal = 4.dp))
            IconButton(onClick = { onSpeak(entry.word) }) {
                Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = "发音")
            }
        }

        GlassCard(modifier = Modifier.fillMaxWidth()) {
            DefinitionModulesView(
                raw = entry.definition,
                order = definitionOrder,
                modifier = Modifier.fillMaxWidth(),
                onEdit = { onEditModule(it) },
            )
        }

        entry.s?.let { s ->
            LinearProgressIndicator(
                progress = { (s / 30.0).toFloat().coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth(),
            )
            Row(modifier = Modifier.fillMaxWidth()) {
                Text(
                    "记忆稳定度 ${"%.1f".format(s)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    "下次 ${entry.dueDate ?: "—"}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = onEdit) { Text("编辑") }
            TextButton(onClick = onDelete) {
                Text("删除", color = MaterialTheme.colorScheme.error)
            }
        }

        if (entry.book.isNotEmpty()) {
            Text(
                "来自 · ${displayName(entry.book)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * 慢游：随机浏览词条，不评分、不改进度。对应 iOS `BrowseView`。
 */
@Composable
fun BrowseScreen(
    entries: List<Entry>,
    definitionOrder: List<DefinitionModule>,
    current: Entry?,
    flipped: Boolean,
    historySize: Int,
    onFlip: () -> Unit,
    onSpeak: (String) -> Unit,
    onNext: () -> Unit,
    onPrevious: () -> Unit,
    onEditModule: (Entry, DefinitionModule) -> Unit,
    random: kotlin.random.Random = kotlin.random.Random.Default,
) {
    if (current == null) {
        EmptyState("词库为空", "先去添加一些单词吧", modifier = Modifier.fillMaxSize())
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            "来自 · ${current.book}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        GlassCard(modifier = Modifier.fillMaxWidth().weight(1f)) {
            // 与 iOS `BrowseView` 一样是 3D 翻面（原 Android 版是瞬间换内容，没有翻面动作）
            FlipCard(
                flipped = flipped,
                stateKey = current.studyKey,
                modifier = Modifier.fillMaxSize().clickable(onClick = onFlip),
                front = {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Text(
                            current.word,
                            style = MaterialTheme.typography.headlineLarge,
                            fontWeight = FontWeight.Bold,
                            color = wordColor(),
                        )
                        IconButton(onClick = { onSpeak(current.word) }) {
                            Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = "发音")
                        }
                        Text(
                            "点击翻面",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                back = {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Text(
                            current.word,
                            style = MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.Bold,
                            color = wordColor(),
                        )
                        DefinitionModulesView(
                            raw = current.definition,
                            order = definitionOrder,
                            onEdit = { module -> onEditModule(current, module) },
                        )
                    }
                },
            )
        }

        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onPrevious, enabled = historySize > 0) { Text("上一个") }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onNext) { Text("下一个") }
        }
    }
}

/** 供 [BrowseScreen] 的调用方复用的随机取词（对应 iOS `BrowseView.next()`） */
fun pickNextBrowseEntry(all: List<Entry>, current: Entry?, random: kotlin.random.Random): Entry? {
    val pool = all.filter { it.studyKey != current?.studyKey }
    if (pool.isNotEmpty()) return pool.random(random)
    return if (all.isNotEmpty()) all.random(random) else null
}

/** 词条的熟练度文案（供其它页面复用） */
internal fun bandLabel(entry: Entry): String = StudyScope.proficiency(entry).label

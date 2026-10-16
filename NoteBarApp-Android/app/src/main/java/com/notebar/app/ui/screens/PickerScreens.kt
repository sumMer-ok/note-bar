package com.notebar.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.notebar.app.domain.ReviewMode
import com.notebar.app.domain.StudyScope
import com.notebar.engine.Entry
import com.notebar.engine.StudyQueue

/**
 * 开始复习/学习前的词库多选页。对应 iOS `BookPickerView`：
 * - 标题「选择复习词库」/「选择学习词库」；
 * - 右上角「全选 / 清空」；
 * - 进入时预选用户标记的「默认词库」（不预选任何其它词库）。
 */
@Composable
fun BookPickerScreen(
    entries: List<Entry>,
    mode: ReviewMode,
    defaultBooks: List<String>,
    onStart: (Set<String>) -> Unit,
) {
    val books = remember(entries) { entries.map { it.book }.toSet().sorted() }
    var selected by remember(books, defaultBooks) {
        mutableStateOf(books.filter { defaultBooks.contains(it) }.toSet())
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (mode == ReviewMode.review) "选择复习词库" else "选择学习词库",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.weight(1f))
            TextButton(onClick = {
                selected = if (selected.size == books.size) emptySet() else books.toSet()
            }) { Text(if (selected.size == books.size) "清空" else "全选") }
        }

        HorizontalDivider()
        Text(
            "选择词库（可多选）",
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )

        LazyColumn(modifier = Modifier.weight(1f)) {
            items(books, key = { it }) { book ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            selected = if (selected.contains(book)) selected - book else selected + book
                        }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(book)
                    Spacer(Modifier.weight(1f))
                    Icon(
                        imageVector = if (selected.contains(book)) Icons.Filled.CheckCircle
                        else Icons.Filled.RadioButtonUnchecked,
                        contentDescription = null,
                        tint = if (selected.contains(book)) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                HorizontalDivider()
            }
        }

        Button(
            onClick = { onStart(selected) },
            enabled = selected.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().padding(16.dp),
        ) {
            Text(
                if (mode == ReviewMode.review) "开始复习" else "开始学习",
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/**
 * 听写第一步：选词库（单选）。对应 iOS `DictationBookPickerView`。
 */
@Composable
fun DictationBookPickerScreen(
    entries: List<Entry>,
    onPickBook: (String) -> Unit,
) {
    val books = remember(entries) { entries.map { it.book }.toSet().sorted() }
    Column(modifier = Modifier.fillMaxSize()) {
        Text(
            "选择单词本",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(16.dp),
        )
        if (books.isEmpty()) {
            Text(
                "词库为空",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
        } else {
            LazyColumn {
                items(books, key = { it }) { book ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPickBook(book) }
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(displayName(book))
                        Spacer(Modifier.weight(1f))
                        Text(
                            "${entries.count { it.book == book }} 词",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

/**
 * 听写第二步：按添加日期多选。对应 iOS `DictationDatePickerView`。
 */
@Composable
fun DictationDatePickerScreen(
    entries: List<Entry>,
    book: String,
    onStart: (Set<String>) -> Unit,
) {
    val bookEntries = remember(entries, book) { entries.filter { it.book == book } }
    val dateOptions = remember(bookEntries) {
        val dates = bookEntries.mapNotNull { it.addedDate }.toSet().sortedDescending()
        if (bookEntries.any { it.addedDate == null }) dates + StudyQueue.undatedLabel else dates
    }
    var selected by remember(dateOptions) { mutableStateOf(emptySet<String>()) }

    fun countOn(date: String): Int = if (date == StudyQueue.undatedLabel) {
        bookEntries.count { it.addedDate == null }
    } else {
        bookEntries.count { it.addedDate == date }
    }

    val selectedWordCount = bookEntries.count {
        selected.contains(it.addedDate ?: StudyQueue.undatedLabel)
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("选择日期", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = {
                selected = if (selected.size == dateOptions.size) emptySet() else dateOptions.toSet()
            }) { Text(if (selected.size == dateOptions.size) "清空" else "全选") }
        }

        Text(
            "按添加日期选择（可多选）",
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        Text(
            "将听写「${displayName(book)}」词库中这些日期添加的单词",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )

        LazyColumn(modifier = Modifier.weight(1f)) {
            items(dateOptions, key = { it }) { date ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            selected = if (selected.contains(date)) selected - date else selected + date
                        }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(date)
                    Spacer(Modifier.weight(1f))
                    Text(
                        "${countOn(date)} 词",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.padding(horizontal = 4.dp))
                    Icon(
                        imageVector = if (selected.contains(date)) Icons.Filled.CheckCircle
                        else Icons.Filled.RadioButtonUnchecked,
                        contentDescription = null,
                        tint = if (selected.contains(date)) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                HorizontalDivider()
            }
        }

        Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Button(
                onClick = { onStart(selected) },
                enabled = selected.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("开始听写（$selectedWordCount 词）", fontWeight = FontWeight.Bold)
            }
        }
    }
}

/** 首页概览用：某词库的到期数 */
internal fun dueCountIn(entries: List<Entry>, book: String, today: String): Int =
    StudyScope.dueCount(entries, today, book)

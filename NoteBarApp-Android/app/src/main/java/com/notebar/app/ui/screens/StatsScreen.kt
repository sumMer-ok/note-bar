package com.notebar.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.notebar.app.domain.DailyQuote
import com.notebar.app.domain.DailyQuoteBook
import com.notebar.app.domain.StatsCalculator
import com.notebar.app.ui.components.GlassCard
import com.notebar.app.ui.components.StatCard
import com.notebar.engine.Entry
import com.notebar.engine.FSRS
import java.time.LocalDate

/**
 * 统计页。逐块对应 iOS `StatsView`：
 * 每日一句、三张统计卡（连续天数 / 今日学习 / 今日复习）、本月日历、选中日详情、
 * 近 18 周热力图。
 */
@Composable
fun StatsScreen(
    entries: List<Entry>,
    today: LocalDate,
    onOpenWord: (Entry) -> Unit,
) {
    val dayMap = remember(entries) { StatsCalculator.byDay(entries) }
    val todayString = FSRS.dayString(today)
    val streak = remember(dayMap, today) { StatsCalculator.streak(dayMap, today) }
    val learnToday = remember(entries, todayString) { StatsCalculator.learnEntries(entries, todayString) }
    val reviewToday = remember(entries, todayString) { StatsCalculator.reviewEntries(entries, todayString) }

    var selectedDay by remember { mutableStateOf<String?>(null) }

    LazyColumn(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item { QuoteCard(DailyQuoteBook.quote(today)) }

        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatCard("连续天数", streak.toString(), Modifier.weight(1f))
                StatCard("今日学习", learnToday.size.toString(), Modifier.weight(1f))
                StatCard("今日复习", reviewToday.size.toString(), Modifier.weight(1f))
            }
        }

        item {
            Text("日历", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        }
        item {
            CalendarGrid(
                byDay = dayMap,
                today = today,
                selected = selectedDay,
                onSelect = { key -> selectedDay = if (selectedDay == key) null else key },
            )
        }

        selectedDay?.let { day ->
            item {
                DayDetail(
                    day = day,
                    entries = entries,
                    byDay = dayMap,
                    onOpenWord = onOpenWord,
                )
            }
        }

        item {
            Text("近 18 周热力图", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        }
        item { Heatmap(byDay = dayMap, today = today) }
    }
}

/** 每日一句卡片。对应 iOS `QuoteCard` */
@Composable
private fun QuoteCard(quote: DailyQuote) {
    GlassCard(modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "每日一句",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(quote.english, fontStyle = FontStyle.Italic)
            Text(
                quote.chinese,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "— ${quote.author}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** 本月日历。对应 iOS `CalendarGrid`（周一起始、有记录的日期高亮） */
@Composable
private fun CalendarGrid(
    byDay: Map<String, List<StatsCalculator.DayRecord>>,
    today: LocalDate,
    selected: String?,
    onSelect: (String) -> Unit,
) {
    val weeks = remember(today) { StatsCalculator.weeksOfCurrentMonth(today) }
    GlassCard(modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(modifier = Modifier.fillMaxWidth()) {
                listOf("一", "二", "三", "四", "五", "六", "日").forEach { label ->
                    Text(
                        label,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            weeks.forEach { week ->
                Row(modifier = Modifier.fillMaxWidth()) {
                    week.forEach { day ->
                        if (day == null) {
                            Box(Modifier.weight(1f).height(34.dp))
                        } else {
                            val key = FSRS.dayString(day)
                            val has = (byDay[key]?.size ?: 0) > 0
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .height(34.dp)
                                    .padding(1.dp)
                                    .background(
                                        color = when {
                                            selected == key -> MaterialTheme.colorScheme.primary
                                            has -> MaterialTheme.colorScheme.primary.copy(alpha = 0.65f)
                                            else -> Color.Transparent
                                        },
                                        shape = RoundedCornerShape(8.dp),
                                    )
                                    .clickable { onSelect(key) },
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    day.dayOfMonth.toString(),
                                    color = if (has || selected == key) Color.White
                                    else MaterialTheme.colorScheme.onSurface,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 选中日详情。对应 iOS `StatsView.dayDetail(_:)` */
@Composable
private fun DayDetail(
    day: String,
    entries: List<Entry>,
    byDay: Map<String, List<StatsCalculator.DayRecord>>,
    onOpenWord: (Entry) -> Unit,
) {
    val learn = StatsCalculator.learnEntries(entries, day)
    val review = StatsCalculator.reviewEntries(entries, day)

    GlassCard(modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("今日学习 ${learn.size} 词", fontWeight = FontWeight.Bold)
            if (learn.isEmpty()) {
                Text(
                    "无",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                learn.forEach { WordRow(it, StatsCalculator.latestQuality(it, day), onOpenWord) }
            }

            Spacer(Modifier.height(6.dp))
            Text("今日复习 ${review.size} 词", fontWeight = FontWeight.Bold)
            if (review.isEmpty()) {
                Text(
                    "无",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                review.forEach { WordRow(it, StatsCalculator.latestQuality(it, day), onOpenWord) }
            }
        }
    }
}

@Composable
private fun WordRow(entry: Entry, quality: String?, onOpenWord: (Entry) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable { onOpenWord(entry) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(entry.word, fontWeight = FontWeight.Medium)
            Text(
                entry.bookDisplayName,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.weight(1f))
        if (quality != null) {
            Text(
                StatsCalculator.qualityLabel(quality),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** 近 18 周热力图。对应 iOS `Heatmap`（18 列网格 + 四档颜色） */
@Composable
private fun Heatmap(
    byDay: Map<String, List<StatsCalculator.DayRecord>>,
    today: LocalDate,
) {
    val days = remember(today) { StatsCalculator.last18Weeks(today) }
    GlassCard(modifier = Modifier.fillMaxWidth()) {
        // 18 周 = 18 列 × 7 行；按列优先排布（与 iOS 的 LazyVGrid 18 列一致）
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            (0 until 18).forEach { week ->
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    (0 until 7).forEach { dayOfWeek ->
                        val date = days.getOrNull(week * 7 + dayOfWeek)
                        val count = date?.let { byDay[FSRS.dayString(it)]?.size ?: 0 } ?: 0
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(14.dp)
                                .background(heatColor(count), RoundedCornerShape(3.dp)),
                        )
                    }
                }
            }
        }
    }
}

/** 热力图配色。逐字对应 iOS `Heatmap.color(_:)` 的四档 */
private fun heatColor(count: Int): Color = when (count) {
    0 -> Color.Gray.copy(alpha = 0.12f)
    in 1..3 -> Color(0xFF4CAF50).copy(alpha = 0.35f)
    in 4..9 -> Color(0xFF4CAF50).copy(alpha = 0.65f)
    else -> Color(0xFF4CAF50)
}

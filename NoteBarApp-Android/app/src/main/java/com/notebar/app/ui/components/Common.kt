package com.notebar.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.notebar.app.data.DefinitionModule
import com.notebar.app.domain.DefinitionSections

/**
 * 释义模块展示。对应 iOS `DefinitionModulesView`：
 * 按用户设置的顺序排列，模块间用横线分隔；无任何模块时回落到原文/「（无释义）」。
 */
@Composable
fun DefinitionModulesView(
    raw: String,
    order: List<DefinitionModule>,
    modifier: Modifier = Modifier,
    onEdit: ((DefinitionModule) -> Unit)? = null,
) {
    val items = DefinitionSections.modules(raw, order)
    Column(modifier = modifier) {
        if (items.isEmpty()) {
            Text(
                text = if (raw.isEmpty()) "（无释义）" else raw,
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            items.forEachIndexed { index, item ->
                Column(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(item.module.label, style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.weight(1f))
                        if (onEdit != null) {
                            TextButton(onClick = { onEdit(item.module) }) {
                                Text("编辑", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    Text(item.content, modifier = Modifier.fillMaxWidth())
                }
                if (index < items.size - 1) HorizontalDivider()
            }
        }
    }
}

/** 玻璃卡片：对应 iOS 的 `.glassCard()`（圆角 24、半透明底） */
@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        ),
    ) {
        Box(modifier = Modifier.padding(16.dp)) { content() }
    }
}

/** 统计小卡片：对应 iOS `StatsView.statCard` */
@Composable
fun StatCard(title: String, value: String, modifier: Modifier = Modifier) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        ),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(
                title,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** 空状态视图；对应 iOS `ContentUnavailableView` 的最小可用形态 */
@Composable
fun EmptyState(
    title: String,
    description: String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text(
            description,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** 分区标题；对应 iOS 的 `Section` 头部 */
@Composable
fun SectionHeader(title: String, modifier: Modifier = Modifier) {
    Text(
        text = title,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.Bold,
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

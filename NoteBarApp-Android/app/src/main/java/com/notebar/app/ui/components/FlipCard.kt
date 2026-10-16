package com.notebar.app.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity

/**
 * 双面卡片翻转，与 iOS `FlipView` 同构。
 *
 * - 正面绕 Y 轴 `0 → 180°`，背面 `-180° → 0`；
 * - **进度过半（90°）才切换可见面**——否则两面会在中途同时可见，出现残影（iOS 注释明确写了这点）；
 * - `cameraDistance` 必须显式给（默认值透视过强，翻面会显得像被压缩），这里用 12 × density；
 * - 点按触发的动画对应 iOS `withAnimation(.spring(duration: 0.45))`。
 *
 * @param stateKey 词条标识。**换卡时必须变化**：否则新卡会从"背面"转回正面，
 *   产生一次与用户操作无关的旋转（`Animatable` 随 key 重建，直接以当前 [flipped] 为初值）。
 */
@Composable
fun FlipCard(
    flipped: Boolean,
    stateKey: Any?,
    modifier: Modifier = Modifier,
    front: @Composable () -> Unit,
    back: @Composable () -> Unit,
) {
    val progress = remember(stateKey) { Animatable(if (flipped) 1f else 0f) }
    val density = LocalDensity.current.density

    LaunchedEffect(stateKey, flipped) {
        progress.animateTo(
            targetValue = if (flipped) 1f else 0f,
            animationSpec = spring(
                dampingRatio = Spring.DampingRatioNoBouncy,
                stiffness = Spring.StiffnessMediumLow,
            ),
        )
    }

    Box(modifier) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer {
                    rotationY = progress.value * 180f
                    cameraDistance = 12f * density
                    alpha = if (progress.value < 0.5f) 1f else 0f
                },
        ) { front() }
        Box(
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer {
                    rotationY = -180f + progress.value * 180f
                    cameraDistance = 12f * density
                    alpha = if (progress.value >= 0.5f) 1f else 0f
                },
        ) { back() }
    }
}

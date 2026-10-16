package com.notebar.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import com.notebar.app.data.Settings

/**
 * 主题色。逐字对应 iOS `Theme.swift`：
 * againRed / hardGray / goodGreen / easyOrange / darkPurpleWord。
 */
object NoteBarColors {
    val againRed = Color(red = 0.76f, green = 0.22f, blue = 0.24f)
    val hardGray = Color(red = 0.55f, green = 0.58f, blue = 0.62f)
    val goodGreen = Color(red = 0.18f, green = 0.55f, blue = 0.34f)
    val easyOrange = Color(red = 0.90f, green = 0.54f, blue = 0.0f)
    val darkPurpleWord = Color(red = 0.72f, green = 0.62f, blue = 1.0f)
}

private val DarkColors = darkColorScheme()
private val LightColors = lightColorScheme()

/** 当前是否暗色（由 [NoteBarTheme] 按设置注入），供卡片取词色使用 */
val LocalDarkTheme = staticCompositionLocalOf { false }

/**
 * 词色：暗色下用 [NoteBarColors.darkPurpleWord]，浅色下用黑色。
 * 对应 iOS `Theme.wordColor(_:)`。
 */
@Composable
fun wordColor(): Color = if (LocalDarkTheme.current) NoteBarColors.darkPurpleWord else Color.Black

/**
 * 应用主题。
 *
 * iOS 用 `.preferredColorScheme(settings.appearance.colorScheme)` 让外观设置独立于系统生效；
 * Android 侧由 `AppCompatDelegate.setDefaultNightMode` 在 Activity 层施加同样的效果
 * （见 `MainActivity.applyAppearance`），这里再按设置覆盖 Compose 的 `isSystemInDarkTheme`，
 * 保证「日间/暗夜」在 Compose 内部也立刻一致。
 */
@Composable
fun NoteBarTheme(
    appearance: Settings.Appearance,
    content: @Composable () -> Unit,
) {
    val dark = when (appearance) {
        Settings.Appearance.system -> isSystemInDarkTheme()
        Settings.Appearance.light -> false
        Settings.Appearance.dark -> true
    }
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        typography = Typography(),
    ) {
        CompositionLocalProvider(LocalDarkTheme provides dark) {
            content()
        }
    }
}

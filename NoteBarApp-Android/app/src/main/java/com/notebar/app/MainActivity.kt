package com.notebar.app

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import com.notebar.app.data.Settings
import com.notebar.app.ui.AppRoot
import com.notebar.app.ui.AppViewModel
import com.notebar.app.ui.theme.NoteBarTheme

/**
 * NoteBar Android 入口。
 *
 * 对应 iOS `NoteBarApp`：建容器 → 注入 `AppState` → 渲染 `RootView` →
 * 按 `settings.appearance` 施加 `preferredColorScheme`。
 * Android 侧用 [AppCompatDelegate.setDefaultNightMode] 达到同样效果：
 * 「日间 / 暗夜」独立于系统生效，与 iOS 口径一致（若退化为「只保存不生效」会违反红线 2）。
 *
 * 继承 [AppCompatActivity] 而非 `ComponentActivity`：夜间模式的视觉生效依赖
 * AppCompat 的 DayNight 主题链（见 `res/values/themes.xml`）。
 */
class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            val viewModel: AppViewModel = viewModel()
            val settings by viewModel.settings.collectAsState()

            // 外观变化立即生效；system 时交回系统跟随
            LaunchedEffect(settings.appearance) {
                applyAppearance(settings.appearance)
            }

            NoteBarTheme(appearance = settings.appearance) {
                AppRoot(viewModel = viewModel)
            }
        }
    }
}

/**
 * 外观设置 → 夜间模式。对应 iOS `Appearance.colorScheme`：
 * `system` → nil（跟随系统）、`light` → `.light`、`dark` → `.dark`。
 */
internal fun applyAppearance(appearance: Settings.Appearance) {
    AppCompatDelegate.setDefaultNightMode(
        when (appearance) {
            Settings.Appearance.system -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            Settings.Appearance.light -> AppCompatDelegate.MODE_NIGHT_NO
            Settings.Appearance.dark -> AppCompatDelegate.MODE_NIGHT_YES
        },
    )
}

package com.notebar.app.ui

import com.notebar.app.data.DefinitionModule
import com.notebar.app.domain.ReviewMode
import com.notebar.engine.Entry
import com.notebar.engine.ReinforceDraft

/**
 * 应用内的页面。对应 iOS 各 `NavigationStack` 的 push 目标。
 *
 * 用状态式导航而不是 navigation-compose：任务书要求不引入版本目录之外的新依赖，
 * 而 `navigation-compose` 不在 `gradle/libs.versions.toml` 里。
 */
sealed interface Screen {
    /** 首页（学习 Tab 根）；对应 iOS `HomeView` */
    data object Home : Screen

    /** 开始复习/学习前的词库多选页；对应 iOS `BookPickerView` */
    data class BookPicker(val mode: ReviewMode) : Screen

    /** 复习/学习（含不熟词强化）；对应 iOS `ReviewView` */
    data class Review(
        val mode: ReviewMode,
        val books: Set<String>,
        val resumeDraft: ReinforceDraft? = null,
    ) : Screen

    /** 慢游；对应 iOS `BrowseView` */
    data object Browse : Screen

    /** 听写第一步：选词库；对应 iOS `DictationBookPickerView` */
    data object DictationBookPicker : Screen

    /** 听写第二步：选日期；对应 iOS `DictationDatePickerView` */
    data class DictationDatePicker(val book: String) : Screen

    /** 听写答题；对应 iOS `DictationView` */
    data class Dictation(val books: Set<String>, val dates: Set<String>) : Screen

    /** 词表；对应 iOS `WordListView`（`book == null` 表示全部词库） */
    data class WordList(val book: String?) : Screen

    /** 词详情；对应 iOS `WordDetailView` */
    data class WordDetail(val studyKey: String) : Screen

    /** 单词编辑；对应 iOS `WordEditSheet` */
    data class WordEdit(val studyKey: String, val focusModule: DefinitionModule? = null) : Screen

    /** 统计（统计 Tab 根）；对应 iOS `StatsView` */
    data object Stats : Screen

    /** 设置（设置 Tab 根）；对应 iOS `SettingsView` */
    data object Settings : Screen
}

/** 底部导航 Tab。取值与 iOS `AppTab` 一一对应（learn/library/stats/settings）。 */
enum class AppTab(val title: String) {
    learn("学习"),
    library("词库"),
    stats("统计"),
    settings("设置");

    val root: Screen
        get() = when (this) {
            learn -> Screen.Home
            library -> Screen.WordList(null)
            stats -> Screen.Stats
            settings -> Screen.Settings
        }
}

/** 每个 Tab 各自一个返回栈（Tab 切换不互相清空，贴近 iOS TabView 的体验） */
data class TabStack(
    val tab: AppTab,
    val stack: List<Screen> = listOf(tab.root),
) {
    val current: Screen get() = stack.last()

    fun push(screen: Screen): TabStack = copy(stack = stack + screen)

    /** 返回上一页；已在根页面时返回 null（调用方据此决定是否退出） */
    fun pop(): TabStack? = if (stack.size <= 1) null else copy(stack = stack.dropLast(1))

    /** 回到本 Tab 的根页面（直接点底部 Tab 时，对应 iOS `handleTabChange`） */
    fun resetToRoot(): TabStack = copy(stack = listOf(tab.root))

    companion object {
        fun of(tab: AppTab): TabStack = TabStack(tab)
    }
}

/** 词条定位：UI 用 studyKey 查词，避免跨页面持有过期对象 */
fun List<Entry>.findByStudyKey(key: String): Entry? = firstOrNull { it.studyKey == key }

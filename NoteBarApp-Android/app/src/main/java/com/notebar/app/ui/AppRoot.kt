package com.notebar.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Book
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import com.notebar.app.audio.WordSpeaker
import com.notebar.app.data.DefinitionModule
import com.notebar.app.domain.ReviewMode
import com.notebar.app.domain.ReviewSessionState
import com.notebar.app.domain.StudyScope
import com.notebar.app.ui.screens.BookPickerScreen
import com.notebar.app.ui.screens.BrowseScreen
import com.notebar.app.ui.screens.DictationBookPickerScreen
import com.notebar.app.ui.screens.DictationDatePickerScreen
import com.notebar.app.ui.screens.DictationScreen
import com.notebar.app.ui.screens.DictationSessionState
import com.notebar.app.ui.screens.HomeScreen
import com.notebar.app.ui.screens.ReviewScreen
import com.notebar.app.ui.screens.SettingsScreen
import com.notebar.app.ui.screens.StatsScreen
import com.notebar.app.ui.screens.WordDetailScreen
import com.notebar.app.ui.screens.WordEditScreen
import com.notebar.app.ui.screens.WordListScreen
import com.notebar.app.ui.findByStudyKey
import com.notebar.app.ui.screens.pickNextBrowseEntry
import com.notebar.engine.Entry
import com.notebar.engine.FSRS
import java.time.LocalDate
import kotlinx.coroutines.launch

/** Tab 图标。对应 iOS `RootView` 的 `systemImage` 语义 */
private fun iconOf(tab: AppTab): ImageVector = when (tab) {
    AppTab.learn -> Icons.Filled.Book
    AppTab.library -> Icons.AutoMirrored.Filled.MenuBook
    AppTab.stats -> Icons.Filled.BarChart
    AppTab.settings -> Icons.Filled.Settings
}

/**
 * 应用根视图。对应 iOS `RootView` + `NoteBarApp`：
 * 四个 Tab（学习 / 词库 / 统计 / 设置）、每个 Tab 独立的返回栈、
 * 复习与听写等子页面的会话状态，以及发音与同步的接线。
 *
 * 与 iOS 的差异：
 * - iOS 用 `NavigationStack`/`TabView` 与 `@Query`；这里用状态式导航 + Room Flow，
 *   语义一致（Tab 切换保留各自栈、Tab 重击回根页面）；
 * - iOS 的「词库过滤」`libraryFilter` 用 [TabStack] 的根页面参数实现。
 */
@Composable
fun AppRoot(viewModel: AppViewModel, today: LocalDate = LocalDate.now()) {
    val entries by viewModel.entries.collectAsState()
    val settings by viewModel.settings.collectAsState()
    val draft by viewModel.reinforceDraft.collectAsState()
    val syncStatus by viewModel.syncStatus.collectAsState()
    val conflicts by viewModel.conflicts.collectAsState()
    val syncRootPath by viewModel.syncRootPath.collectAsState()
    val usingBaiduPan by viewModel.usingBaiduPan.collectAsState()

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val speaker = remember { WordSpeaker(context) }
    DisposableEffect(Unit) { onDispose { speaker.shutdown() } }

    var tab by remember { mutableStateOf(AppTab.learn) }
    var stack by remember { mutableStateOf(TabStack.of(AppTab.learn)) }

    // 复习会话：进入 Review 页面时构建一次
    var reviewSession by remember { mutableStateOf<ReviewSessionState?>(null) }
    var reviewVersion by remember { mutableIntStateOf(0) }
    // 听写会话
    var dictationSession by remember { mutableStateOf<DictationSessionState?>(null) }
    var dictationVersion by remember { mutableIntStateOf(0) }
    // 慢游
    var browseCurrent by remember { mutableStateOf<Entry?>(null) }
    var browseFlipped by remember { mutableStateOf(false) }
    var browseHistory by remember { mutableStateOf(listOf<Entry>()) }

    val todayString = FSRS.dayString(today)

    fun push(screen: Screen) {
        stack = stack.push(screen)
    }

    fun pop() {
        stack.pop()?.let { stack = it }
    }

    /**
     * 强化草稿的落库策略：会话还在（未走完）→ 存草稿；会话已结束 → 清空草稿。
     *
     * 对应 iOS：`answerReinforce` 里的 `if reinforce != nil { persistDraft() }`
     * 与 `finishReinforce` 里的 `appState.clearReinforceDraft()` 的组合。
     */
    fun persistOrClearDraft(session: ReviewSessionState) {
        val draft = session.draftSnapshot()
        scope.launch {
            if (draft != null) viewModel.saveReinforceDraft(draft) else viewModel.clearReinforceDraft()
        }
    }

    fun switchTab(next: AppTab) {
        if (next == tab) {
            // 直接点当前 Tab → 回根页面（对应 iOS Tab 重复点击的语义）
            stack = stack.resetToRoot()
        } else {
            tab = next
            stack = TabStack.of(next)
        }
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                AppTab.entries.forEach { item ->
                    NavigationBarItem(
                        selected = tab == item,
                        onClick = { switchTab(item) },
                        icon = { Icon(iconOf(item), contentDescription = item.title) },
                        label = { Text(item.title) },
                    )
                }
            }
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            when (val screen = stack.current) {
                is Screen.Home -> HomeScreen(
                    entries = entries,
                    pinnedBooks = settings.pinnedBooks,
                    defaultBooks = settings.defaultBooks,
                    today = todayString,
                    draft = draft,
                    onStartReview = { push(Screen.BookPicker(ReviewMode.review)) },
                    onStartLearn = { push(Screen.BookPicker(ReviewMode.learn)) },
                    onStartBrowse = {
                        browseCurrent = pickNextBrowseEntry(entries, null, kotlin.random.Random)
                        browseFlipped = false
                        browseHistory = emptyList()
                        push(Screen.Browse)
                    },
                    onStartDictation = { push(Screen.DictationBookPicker) },
                    onResumeReinforce = { d ->
                        val restored = ReviewSessionState(
                            mode = ReviewMode.learn,
                            books = d.books.toSet(),
                            initialQueue = emptyList(),
                            reinforceEntries = entries.associateBy { it.studyKey },
                        )
                        if (restored.restoreReinforce(d)) {
                            reviewSession = restored
                            reviewVersion += 1
                            push(Screen.Review(ReviewMode.learn, d.books.toSet(), d))
                        } else {
                            // 草稿已无待办（例如队列被清空）→ 清掉它，不进入页面
                            scope.launch { viewModel.clearReinforceDraft() }
                        }
                    },
                    onDiscardReinforce = { scope.launch { viewModel.clearReinforceDraft() } },
                    onOpenBook = { book ->
                        tab = AppTab.library
                        stack = TabStack(AppTab.library).push(Screen.WordList(book))
                    },
                    onToggleDefault = { book ->
                        scope.launch { viewModel.updateSettings { it.setDefault(book) } }
                    },
                    onTogglePinned = { book ->
                        scope.launch { viewModel.updateSettings { it.setPinned(book) } }
                    },
                    onDeleteBook = { book -> scope.launch { viewModel.deleteBook(book) } },
                )

                is Screen.BookPicker -> BookPickerScreen(
                    entries = entries,
                    mode = screen.mode,
                    defaultBooks = settings.defaultBooks,
                    onStart = { books ->
                        val limit = if (screen.mode == ReviewMode.review) {
                            settings.dailyReviewLimit
                        } else {
                            settings.dailyNewWordLimit
                        }
                        val queue = StudyScope.buildQueue(
                            entries = entries,
                            books = books,
                            mode = screen.mode,
                            limit = limit,
                            today = todayString,
                        )
                        if (queue.isEmpty()) {
                            pop()
                            return@BookPickerScreen
                        }
                        reviewSession = ReviewSessionState(
                            mode = screen.mode,
                            books = books,
                            initialQueue = queue,
                            reinforceEntries = entries.associateBy { it.studyKey },
                        )
                        reviewVersion += 1
                        push(Screen.Review(screen.mode, books))
                    },
                )

                is Screen.Review -> {
                    val session = reviewSession
                    if (session == null) {
                        pop()
                    } else {
                        ReviewScreen(
                            state = session,
                            autoPronounce = settings.autoPronounce,
                            definitionOrder = settings.definitionOrder,
                            version = reviewVersion,
                            onSpeak = { speaker.speak(it, settings.ttsTemplate) },
                            onRate = { _, dir ->
                                // 评分逻辑全在 session（纯逻辑，可单测）；这里只负责落库 + 写边车
                                val result = session.rate(dir)
                                if (result != null) {
                                    scope.launch {
                                        viewModel.persistOutcome(result.updated, result.outcome)
                                    }
                                }
                                session.advance()
                                reviewVersion += 1
                            },
                            onUndo = { entry, progress ->
                                scope.launch { viewModel.restore(entry, progress) }
                            },
                            onReinforceAnswer = { known ->
                                session.refreshEntryIndex(entries)
                                session.answerReinforce(known)
                                // 强化环节只走内存状态机：这里**只保存本环节草稿**，
                                // 不写评分、不写进度字段、不写边车（红线 3）。
                                // 全部通过后会话置空 → 草稿必须清掉，否则首页会留下
                                // 一个点不进去的「继续强化」入口（对应 iOS finishReinforce）。
                                persistOrClearDraft(session)
                                reviewVersion += 1
                            },
                            onReinforcePassWord = {
                                session.passCurrentWordManually()
                                persistOrClearDraft(session)
                                reviewVersion += 1
                            },
                            onReinforceContinue = {
                                session.continueAfterLimit()
                                reviewVersion += 1
                            },
                            onReinforceExit = {
                                persistOrClearDraft(session)
                                pop()
                            },
                            onEditModule = { entry, module ->
                                push(Screen.WordEdit(entry.studyKey, module))
                            },
                            onFinishGroup = { pop() },
                            onAnotherGroup = {
                                session.startAnotherGroup(entries, settings.dailyNewWordLimit, todayString)
                                reviewVersion += 1
                            },
                        )
                    }
                }

                is Screen.Browse -> BrowseScreen(
                    entries = entries,
                    definitionOrder = settings.definitionOrder,
                    current = browseCurrent,
                    flipped = browseFlipped,
                    historySize = browseHistory.size,
                    onFlip = { browseFlipped = !browseFlipped },
                    onSpeak = { speaker.speak(it, settings.ttsTemplate) },
                    onNext = {
                        browseHistory = browseHistory + listOfNotNull(browseCurrent)
                        browseCurrent = pickNextBrowseEntry(entries, browseCurrent, kotlin.random.Random)
                        browseFlipped = false
                    },
                    onPrevious = {
                        val last = browseHistory.lastOrNull()
                        if (last != null) {
                            browseHistory = browseHistory.dropLast(1)
                            browseCurrent = last
                            browseFlipped = false
                        }
                    },
                    onEditModule = { entry, module -> push(Screen.WordEdit(entry.studyKey, module)) },
                )

                is Screen.DictationBookPicker -> DictationBookPickerScreen(
                    entries = entries,
                    onPickBook = { book -> push(Screen.DictationDatePicker(book)) },
                )

                is Screen.DictationDatePicker -> DictationDatePickerScreen(
                    entries = entries,
                    book = screen.book,
                    onStart = { dates ->
                        dictationSession = DictationSessionState(
                            StudyScope.buildDictationQueue(
                                entries = entries,
                                books = setOf(screen.book),
                                dates = dates,
                                limit = settings.dictationPerSession,
                            ),
                        )
                        dictationVersion += 1
                        push(Screen.Dictation(setOf(screen.book), dates))
                    },
                )

                is Screen.Dictation -> {
                    val session = dictationSession
                    if (session == null) {
                        pop()
                    } else {
                        DictationScreen(
                            state = session,
                            autoAdvance = settings.dictationAutoAdvance,
                            version = dictationVersion,
                            onSpeak = { speaker.speak(it, settings.ttsTemplate) },
                            onNextGroup = {
                                session.nextGroup(
                                    all = entries,
                                    books = screen.books,
                                    dates = screen.dates,
                                    limit = settings.dictationPerSession,
                                )
                                dictationVersion += 1
                            },
                        )
                    }
                }

                is Screen.WordList -> WordListScreen(
                    entries = entries,
                    book = screen.book,
                    onOpenWord = { push(Screen.WordDetail(it.studyKey)) },
                    onEditWord = { push(Screen.WordEdit(it.studyKey, null)) },
                )

                is Screen.WordDetail -> {
                    val entry = entries.findByStudyKey(screen.studyKey)
                    if (entry == null) {
                        pop()
                    } else {
                        WordDetailScreen(
                            entry = entry,
                            definitionOrder = settings.definitionOrder,
                            onSpeak = { speaker.speak(it, settings.ttsTemplate) },
                            onEditModule = { module -> push(Screen.WordEdit(entry.studyKey, module)) },
                            onEdit = { push(Screen.WordEdit(entry.studyKey, null)) },
                            onDelete = {
                                scope.launch { viewModel.deleteWord(entry) }
                                pop()
                            },
                        )
                    }
                }

                is Screen.WordEdit -> {
                    val entry = entries.findByStudyKey(screen.studyKey)
                    if (entry == null) {
                        pop()
                    } else {
                        WordEditScreen(
                            entry = entry,
                            definitionOrder = settings.definitionOrder,
                            focusModule = screen.focusModule,
                            onCancel = { pop() },
                            onSave = { word, aliases, contents ->
                                scope.launch {
                                    viewModel.saveWordEdit(
                                        original = entry,
                                        word = word,
                                        aliases = aliases,
                                        contents = contents,
                                        order = settings.definitionOrder,
                                    )
                                }
                                pop()
                            },
                        )
                    }
                }

                is Screen.Stats -> StatsScreen(
                    entries = entries,
                    today = today,
                    onOpenWord = { push(Screen.WordDetail(it.studyKey)) },
                )

                is Screen.Settings -> SettingsScreen(
                    settings = settings,
                    syncStatus = syncStatus,
                    syncRoot = syncRootPath,
                    conflicts = conflicts,
                    usingBaiduPan = usingBaiduPan,
                    onSetSyncRoot = { path -> scope.launch { viewModel.setSyncRoot(path) } },
                    onSyncNow = { scope.launch { viewModel.runScan() } },
                    onUpdate = { transform -> scope.launch { viewModel.updateSettings(transform) } },
                    onResolveConflict = { conflict, keepCopy ->
                        scope.launch { viewModel.resolveConflict(conflict, keepCopy) }
                    },
                    onExchangeAuthCode = { code, onResult ->
                        scope.launch { onResult(viewModel.exchangeBaiduPanAuthCode(code)) }
                    },
                )
            }
        }
    }
}

/** 默认设置编辑辅助：切换某词库的「默认」标记（对应 iOS `toggleDefault`） */
private fun com.notebar.app.data.Settings.setDefault(book: String): com.notebar.app.data.Settings =
    copy(
        defaultBooks = if (defaultBooks.contains(book)) {
            defaultBooks.filterNot { it == book }
        } else {
            defaultBooks + book
        },
    )

/** 默认设置编辑辅助：切换某词库的「置顶」标记（对应 iOS `togglePinned`） */
private fun com.notebar.app.data.Settings.setPinned(book: String): com.notebar.app.data.Settings =
    copy(
        pinnedBooks = if (pinnedBooks.contains(book)) {
            pinnedBooks.filterNot { it == book }
        } else {
            pinnedBooks + book
        },
    )

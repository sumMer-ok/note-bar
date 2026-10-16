package com.notebar.app.domain

import com.notebar.engine.Entry
import com.notebar.engine.FSRS
import com.notebar.engine.StudyQueue
import com.notebar.engine.TimeIso
import java.time.LocalDate

/**
 * 视图层的队列 / 计数纯逻辑。全部逐行对应 iOS 视图里的同名计算属性，
 * 便于在不依赖 Android 框架的前提下做 JVM 单测（对齐桌面语义）。
 *
 * 红线：新词上限固定 20（`Settings.DEFAULT_NEW_WORD_LIMIT`），与桌面插件一致。
 */
object StudyScope {

    /** 首页「今日待复习」：到期复习的词数；`book` 非空时只算该词库 */
    fun dueCount(entries: List<Entry>, today: String, book: String? = null): Int =
        entries.count { entry ->
            if (book != null && entry.book != book) false
            else StudyQueue.isReviewable(entry, today)
        }

    /** 首页「新词」：还没有任何学习进度且未掌握 */
    fun newCount(entries: List<Entry>): Int = entries.count { StudyQueue.isLearnable(it) }

    /**
     * 首页词库列表顺序：置顶词库在前（按用户置顶顺序），其余按名称升序。
     * 逐行对应 iOS `HomeView.books`。
     */
    fun orderedBooks(entries: List<Entry>, pinnedBooks: List<String>): List<String> {
        val all = entries.map { it.book }.toSet().sorted()
        val pinned = pinnedBooks.filter { all.contains(it) }
        val rest = all.filterNot { pinned.contains(it) }
        return pinned + rest
    }

    /**
     * 建组（学习 / 复习）。逐行对应 iOS `ReviewView.buildQueue(excluding:)`。
     *
     * @param mode true = 复习，false = 学习
     * @param excluded 上一组已用过的 studyKey（"再学一组"时排除）
     */
    fun buildQueue(
        entries: List<Entry>,
        books: Set<String>,
        mode: ReviewMode,
        limit: Int,
        today: String,
        excluded: Set<String> = emptySet(),
    ): List<Entry> {
        val scope = if (books.isEmpty()) entries else entries.filter { books.contains(it.book) }

        fun candidates(exclude: Set<String>): List<Entry> {
            val base = scope.filter { !exclude.contains(it.studyKey) && !StudyQueue.isMastered(it) }
            return filterByMode(base, mode, today)
        }

        var list = candidates(excluded)
        if (list.isEmpty() && excluded.isNotEmpty()) {
            // 没有剩余候选时，退化为允许重复当前组
            list = filterByMode(scope.filter { !StudyQueue.isMastered(it) }, mode, today)
        }
        return list.take(limit)
    }

    private fun filterByMode(base: List<Entry>, mode: ReviewMode, today: String): List<Entry> =
        when (mode) {
            ReviewMode.review -> base
                .filter { StudyQueue.isReviewable(it, today) }
                .sortedBy { it.dueDate ?: "" }

            ReviewMode.learn -> base.filter { StudyQueue.isLearnable(it) }
        }

    /**
     * 听写队列。逐行对应 iOS `DictationView.buildQueue(excluding:)`：
     * 先排除 retired / archived，再按词库 + 添加日期筛选，随机取 `limit` 个。
     *
     * @param random 注入随机源，便于单测固定结果
     */
    fun buildDictationQueue(
        entries: List<Entry>,
        books: Set<String>,
        dates: Set<String>,
        limit: Int,
        excluded: Set<String> = emptySet(),
        random: kotlin.random.Random = kotlin.random.Random.Default,
    ): List<Entry> {
        fun pool(exclude: Set<String>, enforceExclude: Boolean): List<Entry> =
            entries.filter { entry ->
                (!enforceExclude || !exclude.contains(entry.studyKey)) &&
                    entry.lifecycle != "retired" &&
                    entry.lifecycle != "archived" &&
                    StudyQueue.dictationMatch(entry, books, dates)
            }

        var active = pool(excluded, enforceExclude = true)
        if (active.isEmpty()) {
            // 排除后为空 → 退化为不排除（对应 iOS 的 `if pool.isEmpty` 回退分支）
            active = pool(emptySet(), enforceExclude = false)
        }
        return active.shuffled(random).take(limit)
    }

    /**
     * 词表「熟练度」分档。逐行对应 iOS `WordListView.proficiency(_:)`。
     */
    fun proficiency(entry: Entry): ProficiencyBand {
        if (entry.mastered == true || entry.status == "mastered" || entry.lifecycle == "graduated") {
            return ProficiencyBand.mastered
        }
        val s = entry.s ?: return ProficiencyBand.notStarted
        return when {
            s >= 30 -> ProficiencyBand.mastered
            s < 2 -> ProficiencyBand.fresh
            s < 15 -> ProficiencyBand.consolidating
            else -> ProficiencyBand.familiar
        }
    }
}

/** 学习 / 复习模式；对应 iOS `ReviewView.Mode` */
enum class ReviewMode { review, learn }

/**
 * 熟练度分档；文案与 iOS `WordListView.proficiency(_:)` 的返回串逐字一致。
 * `bands` 的顺序就是「按熟练度」分组的展示顺序。
 */
enum class ProficiencyBand(val label: String) {
    notStarted("未开始"),
    fresh("新学"),
    consolidating("巩固"),
    familiar("熟悉"),
    mastered("已掌握");

    companion object {
        /** 对应 iOS `WordListView.sections` 里 `bands` 数组的顺序 */
        val bands: List<ProficiencyBand> = listOf(notStarted, fresh, consolidating, familiar, mastered)
    }
}

/**
 * 统计口径。逐行对应 iOS `StatsView` 的 `byDay` / `streak` / `learnEntries` / `reviewEntries`。
 */
object StatsCalculator {

    /** 一条复习记录（词 + 质量），对应 iOS `DayRecord` */
    data class DayRecord(val word: String, val quality: String)

    /**
     * 按**本地日期**聚合每天的复习记录。对应 iOS `StatsView.byDay`。
     * 历史里的 ISO8601 串先转本地日期，解析失败时退化为取前 10 个字符（iOS 同）。
     */
    fun byDay(entries: List<Entry>): Map<String, List<DayRecord>> {
        val map = LinkedHashMap<String, MutableList<DayRecord>>()
        for (entry in entries) {
            for (record in entry.history ?: emptyList()) {
                val day = localDay(record.date)
                map.getOrPut(day) { ArrayList() }.add(DayRecord(entry.word, record.quality))
            }
        }
        return map
    }

    /** 本地日期串；解析失败退化为 `iso.take(10)` */
    fun localDay(iso: String): String {
        val instant = com.notebar.engine.TimeIso.parse(iso)
        return if (instant != null) FSRS.dayString(TimeIso.startOfDay(instant)) else iso.take(10)
    }

    /** 连续天数：从今天往前逐日检查是否有记录。对应 iOS `streak(days:)` */
    fun streak(days: Map<String, List<DayRecord>>, today: LocalDate = FSRS.today()): Int {
        val keys = days.keys
        var count = 0
        var cursor = today
        while (keys.contains(FSRS.dayString(cursor))) {
            count += 1
            cursor = cursor.minusDays(1)
        }
        return count
    }

    /** 当天首次学习的词（用 firstLearnedDate 判定）。对应 iOS `learnEntries(on:)` */
    fun learnEntries(entries: List<Entry>, day: String): List<Entry> =
        entries.filter { it.firstLearnedDate == day }

    /** 当天复习过的词：有当天记录且当天不是首次学习。对应 iOS `reviewEntries(on:)` */
    fun reviewEntries(entries: List<Entry>, day: String): List<Entry> =
        entries.filter { entry ->
            val history = entry.history ?: return@filter false
            if (history.none { localDay(it.date) == day }) return@filter false
            entry.firstLearnedDate != day
        }

    /** 当天最后一次评分。对应 iOS `latestQuality(_:on:)` */
    fun latestQuality(entry: Entry, day: String): String? =
        entry.history?.lastOrNull { localDay(it.date) == day }?.quality

    /** 评分文案。逐字对应 iOS `StatsView.qualityLabel(_:)` */
    fun qualityLabel(quality: String): String = when (quality) {
        "again" -> "不认识"
        "hard" -> "模糊"
        "easy" -> "太简单"
        else -> "认识"
    }

    /**
     * 本月日历网格：返回 7 列 / N 行的日期格（null = 空白）。
     * 逐行对应 iOS `CalendarGrid.weeksOfCurrentMonth()`，包括
     * 「周一起始」的 `leading = (weekday + 5) % 7` 对齐方式。
     */
    fun weeksOfCurrentMonth(today: LocalDate): List<List<LocalDate?>> {
        val first = today.withDayOfMonth(1)
        // java.time: MONDAY = 1 ... SUNDAY = 7，与 Calendar 的 weekday(SUNDAY=1) 换算一致
        val leading = first.dayOfWeek.value - 1
        val cells = ArrayList<LocalDate?>()
        repeat(leading) { cells.add(null) }
        val daysInMonth = first.lengthOfMonth()
        for (day in 1..daysInMonth) cells.add(first.withDayOfMonth(day))
        while (cells.size % 7 != 0) cells.add(null)
        return cells.chunked(7)
    }

    /** 近 18 周（126 天）的日期序列（含今天）。对应 iOS `Heatmap.last18Weeks()` */
    fun last18Weeks(today: LocalDate): List<LocalDate> {
        val start = today.minusDays(17L * 7)
        return (0 until 18 * 7).map { start.plusDays(it.toLong()) }
    }
}

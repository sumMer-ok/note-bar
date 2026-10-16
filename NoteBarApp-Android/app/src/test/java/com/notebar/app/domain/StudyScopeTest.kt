package com.notebar.app.domain

import com.notebar.engine.Entry
import com.notebar.engine.FSRS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * 学习 / 复习计数与队列口径。必须与桌面插件 / iOS 一致（红线 1）：
 * 新词 = 无任何学习进度且未掌握；到期 = 有进度、未掌握、dueDate 为空或 <= 今天；新词上限 20。
 */
class StudyScopeTest {

    private val today = "2026-08-20"

    private fun newWord(word: String, book: String = "Words/a.canvas", addedDate: String? = "2026-08-01") =
        Entry(
            studyKey = "en:word:$word",
            book = book,
            source = book,
            nodeId = "n-$word",
            word = word,
            addedDate = addedDate,
        )

    private fun studiedWord(
        word: String,
        dueDate: String?,
        status: String = "review",
        book: String = "Words/a.canvas",
    ) = newWord(word, book).copy(
        status = status,
        s = 3.0,
        d = 5.0,
        dueDate = dueDate,
        lastReview = "2026-08-01T00:00:00Z",
    )

    private fun masteredWord(word: String) = newWord(word).copy(
        status = "mastered",
        lifecycle = "graduated",
    )

    @Test
    fun newCountCountsOnlyUntouchedWords() {
        val entries = listOf(
            newWord("apple"),
            newWord("banana"),
            studiedWord("cherry", "2026-08-20"),
            masteredWord("date"),
        )
        assertEquals(2, StudyScope.newCount(entries))
    }

    @Test
    fun dueCountCountsOnlyUnmasteredWithDueDateReached() {
        val entries = listOf(
            studiedWord("apple", "2026-08-19"),   // 已到期
            studiedWord("banana", "2026-08-20"),  // 今天到期
            studiedWord("cherry", "2026-08-21"),  // 未到期
            studiedWord("date", null),            // 无到期日 → 视为到期
            masteredWord("elder"),                // 已掌握 → 不算
            newWord("fig"),                       // 无进度 → 不算
        )
        assertEquals(3, StudyScope.dueCount(entries, today))
    }

    @Test
    fun dueCountScopedToBook() {
        val entries = listOf(
            studiedWord("apple", "2026-08-19", book = "Words/a.canvas"),
            studiedWord("banana", "2026-08-19", book = "Words/b.canvas"),
        )
        assertEquals(1, StudyScope.dueCount(entries, today, "Words/a.canvas"))
        assertEquals(1, StudyScope.dueCount(entries, today, "Words/b.canvas"))
    }

    @Test
    fun buildLearnQueueCapsAtLimit() {
        val entries = (1..30).map { newWord("w$it") }
        val queue = StudyScope.buildQueue(
            entries = entries,
            books = emptySet(),
            mode = ReviewMode.learn,
            limit = 20,
            today = today,
        )
        assertEquals(20, queue.size)
    }

    @Test
    fun buildLearnQueueExcludesMasteredAndStudied() {
        val entries = listOf(
            newWord("apple"),
            studiedWord("banana", "2026-09-01"),
            masteredWord("cherry"),
        )
        val queue = StudyScope.buildQueue(entries, emptySet(), ReviewMode.learn, 20, today)
        assertEquals(listOf("apple"), queue.map { it.word })
    }

    @Test
    fun buildReviewQueueSortsByDueDateThenCaps() {
        val entries = listOf(
            studiedWord("c", "2026-08-18"),
            studiedWord("a", "2026-08-15"),
            studiedWord("b", "2026-08-20"),
            studiedWord("d", "2026-09-30"), // 未到期，不入队
        )
        val queue = StudyScope.buildQueue(entries, emptySet(), ReviewMode.review, 50, today)
        assertEquals(listOf("a", "c", "b"), queue.map { it.word })
    }

    @Test
    fun buildQueueScopedToSelectedBooks() {
        val entries = listOf(
            newWord("apple", book = "Words/a.canvas"),
            newWord("banana", book = "Words/b.canvas"),
        )
        val queue = StudyScope.buildQueue(
            entries, setOf("Words/b.canvas"), ReviewMode.learn, 20, today,
        )
        assertEquals(listOf("banana"), queue.map { it.word })
    }

    @Test
    fun buildQueueFallsBackToRepeatWhenExclusionEmptiesIt() {
        val entries = listOf(newWord("apple"))
        val queue = StudyScope.buildQueue(
            entries = entries,
            books = emptySet(),
            mode = ReviewMode.learn,
            limit = 20,
            today = today,
            excluded = setOf("en:word:apple"),
        )
        // 没有剩余候选 → 退化为允许重复当前组（与 iOS 一致）
        assertEquals(listOf("apple"), queue.map { it.word })
    }

    @Test
    fun orderedBooksPutsPinnedFirstThenAlphabetical() {
        val entries = listOf(
            newWord("a", book = "Words/z.canvas"),
            newWord("b", book = "Words/a.canvas"),
            newWord("c", book = "Words/m.canvas"),
        )
        val ordered = StudyScope.orderedBooks(entries, listOf("Words/z.canvas"))
        assertEquals(listOf("Words/z.canvas", "Words/a.canvas", "Words/m.canvas"), ordered)
    }

    @Test
    fun orderedBooksIgnoresPinnedBooksThatNoLongerExist() {
        val entries = listOf(newWord("a", book = "Words/a.canvas"))
        val ordered = StudyScope.orderedBooks(entries, listOf("Words/gone.canvas"))
        assertEquals(listOf("Words/a.canvas"), ordered)
    }

    @Test
    fun dictationQueueRespectsBookDateAndLimit() {
        val entries = listOf(
            newWord("a", addedDate = "2026-08-01"),
            newWord("b", addedDate = "2026-08-01"),
            newWord("c", addedDate = "2026-08-02"),
        )
        val queue = StudyScope.buildDictationQueue(
            entries = entries,
            books = emptySet(),
            dates = setOf("2026-08-01"),
            limit = 20,
            random = kotlin.random.Random(1),
        )
        assertEquals(setOf("a", "b"), queue.map { it.word }.toSet())
    }

    @Test
    fun dictationQueueIncludesUndatedWhenSelected() {
        val entries = listOf(newWord("a", addedDate = null), newWord("b", addedDate = "2026-08-01"))
        val queue = StudyScope.buildDictationQueue(
            entries = entries,
            books = emptySet(),
            dates = setOf(com.notebar.engine.StudyQueue.undatedLabel),
            limit = 20,
            random = kotlin.random.Random(1),
        )
        assertEquals(listOf("a"), queue.map { it.word })
    }

    @Test
    fun dictationQueueExcludesRetiredAndArchived() {
        val entries = listOf(
            newWord("a").copy(lifecycle = "retired"),
            newWord("b").copy(lifecycle = "archived"),
            newWord("c"),
        )
        val queue = StudyScope.buildDictationQueue(
            entries, emptySet(), emptySet(), 20, random = kotlin.random.Random(1),
        )
        assertEquals(listOf("c"), queue.map { it.word })
    }

    @Test
    fun proficiencyBandsMatchIosThresholds() {
        assertEquals(ProficiencyBand.notStarted, StudyScope.proficiency(newWord("a")))
        assertEquals(ProficiencyBand.fresh, StudyScope.proficiency(newWord("a").copy(s = 1.5)))
        assertEquals(ProficiencyBand.consolidating, StudyScope.proficiency(newWord("a").copy(s = 2.0)))
        assertEquals(ProficiencyBand.familiar, StudyScope.proficiency(newWord("a").copy(s = 15.0)))
        assertEquals(ProficiencyBand.mastered, StudyScope.proficiency(newWord("a").copy(s = 30.0)))
        // 显式 mastered 标记优先于 s
        assertEquals(
            ProficiencyBand.mastered,
            StudyScope.proficiency(newWord("a").copy(status = "mastered", s = 1.0)),
        )
        assertEquals(
            ProficiencyBand.mastered,
            StudyScope.proficiency(newWord("a").copy(lifecycle = "graduated", s = 1.0)),
        )
        assertEquals(
            ProficiencyBand.mastered,
            StudyScope.proficiency(newWord("a").copy(mastered = true, s = 1.0)),
        )
    }

    @Test
    fun proficiencyBandLabelsMatchIosSections() {
        assertEquals(
            listOf("未开始", "新学", "巩固", "熟悉", "已掌握"),
            ProficiencyBand.bands.map { it.label },
        )
    }

    @Test
    fun streakCountsConsecutiveDaysFromToday() {
        val entries = listOf(
            newWord("a").copy(
                history = listOf(
                    com.notebar.engine.ReviewRecord("2026-08-20T10:00:00Z", "good"),
                    com.notebar.engine.ReviewRecord("2026-08-19T10:00:00Z", "good"),
                    com.notebar.engine.ReviewRecord("2026-08-18T10:00:00Z", "good"),
                ),
            ),
        )
        val dayMap = StatsCalculator.byDay(entries)
        assertEquals(3, StatsCalculator.streak(dayMap, LocalDate.of(2026, 8, 20)))
    }

    @Test
    fun streakIsZeroWhenTodayHasNoRecord() {
        val entries = listOf(
            newWord("a").copy(
                history = listOf(com.notebar.engine.ReviewRecord("2026-08-18T10:00:00Z", "good")),
            ),
        )
        val dayMap = StatsCalculator.byDay(entries)
        assertEquals(0, StatsCalculator.streak(dayMap, LocalDate.of(2026, 8, 20)))
    }

    @Test
    fun learnAndReviewEntriesSplitByFirstLearnedDate() {
        val learnedToday = newWord("a").copy(
            firstLearnedDate = "2026-08-20",
            history = listOf(com.notebar.engine.ReviewRecord("2026-08-20T10:00:00Z", "good")),
        )
        val reviewedToday = newWord("b").copy(
            firstLearnedDate = "2026-07-01",
            history = listOf(com.notebar.engine.ReviewRecord("2026-08-20T10:00:00Z", "hard")),
        )
        val entries = listOf(learnedToday, reviewedToday)
        assertEquals(listOf("a"), StatsCalculator.learnEntries(entries, "2026-08-20").map { it.word })
        assertEquals(listOf("b"), StatsCalculator.reviewEntries(entries, "2026-08-20").map { it.word })
    }

    @Test
    fun qualityLabelsMatchIos() {
        assertEquals("不认识", StatsCalculator.qualityLabel("again"))
        assertEquals("模糊", StatsCalculator.qualityLabel("hard"))
        assertEquals("太简单", StatsCalculator.qualityLabel("easy"))
        assertEquals("认识", StatsCalculator.qualityLabel("good"))
    }

    @Test
    fun calendarGridStartsOnMondayAndPadsTrailingCells() {
        // 2026-08-01 是周六 → 周一开头应有 5 个空位
        val weeks = StatsCalculator.weeksOfCurrentMonth(LocalDate.of(2026, 8, 20))
        assertEquals(5, weeks.first().takeWhile { it == null }.size)
        assertEquals(7, weeks.first().size)
        weeks.forEach { assertEquals(7, it.size) }
        assertEquals(31, weeks.flatten().filterNotNull().size)
    }

    @Test
    fun heatmapCoversExactlyEighteenWeeks() {
        // 与 iOS `Heatmap.last18Weeks()` 逐行一致：从 today-17周 起算 126 天，
        // 因此末尾会延伸到今天之后 6 天（iOS 行为如此，不做"修正"）
        val today = LocalDate.of(2026, 8, 20)
        val days = StatsCalculator.last18Weeks(today)
        assertEquals(126, days.size)
        assertEquals(today.minusDays(17L * 7), days.first())
        assertEquals(today.plusDays(6), days.last())
    }

    @Test
    fun localDayFallsBackToDatePrefixOnUnparsableTimestamp() {
        assertEquals("2026-08-20", StatsCalculator.localDay("2026-08-20T10:00:00Z"))
        assertEquals("2026-08-20", StatsCalculator.localDay("2026-08-20-broken"))
    }

    @Test
    fun todayStringMatchesFsrsFormat() {
        val day = FSRS.dayString(LocalDate.of(2026, 1, 5))
        assertEquals("2026-01-05", day)
    }
}

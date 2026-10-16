package com.notebar.app.data

import com.notebar.engine.Entry
import com.notebar.engine.ReviewRecord
import com.notebar.engine.StudyProgress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [EntryEntity] ↔ engine [Entry] 的映射必须**无损**。
 *
 * 这是同步正确性的地基：任何字段丢失都会让 `applyRemote` 的
 * textChanged / pendingPush 分支判断走样，或让统计（firstLearnedDate）出错。
 */
class EntryCodecTest {

    private fun fullEntry() = Entry(
        studyKey = "en:word:apple",
        book = "Words/英语词库.canvas",
        source = "Words/英语词库.canvas",
        nodeId = "node-1",
        word = "apple",
        aliases = listOf("apples", "apple tree"),
        definition = "--- 词典释义 ---\nn. 苹果",
        color = "4",
        addedDate = "2026-08-01",
        mastered = true,
        s = 12.5,
        d = 6.25,
        lapses = 3,
        dueDate = "2026-09-01",
        lastReview = "2026-08-20T10:00:00Z",
        history = listOf(ReviewRecord("2026-08-20T10:00:00Z", "good")),
        lifecycle = "graduated",
        pinned = true,
        status = "review",
        stage = 2,
        firstLearnedDate = "2026-07-15",
        localEditedAt = "2026-08-21T08:30:00Z",
    )

    @Test
    fun roundTripIsLossless() {
        val original = fullEntry()
        val restored = EntryCodec.toEntry(EntryCodec.toEntity(original))
        assertEquals(original, restored)
    }

    @Test
    fun firstLearnedDateAndLocalEditedAtAreNotDropped() {
        val original = fullEntry()
        val row = EntryCodec.toEntity(original)
        assertEquals("2026-07-15", row.firstLearnedDate)
        assertEquals("2026-08-21T08:30:00Z", row.localEditedAt)
        assertEquals("2026-07-15", EntryCodec.toEntry(row).firstLearnedDate)
    }

    @Test
    fun nullFieldsStayNull() {
        val sparse = Entry(
            studyKey = "k",
            book = "Words/a.canvas",
            source = "Words/a.canvas",
            nodeId = "n",
            word = "w",
        )
        val restored = EntryCodec.toEntry(EntryCodec.toEntity(sparse))
        assertEquals(sparse, restored)
        assertNull(restored.s)
        assertNull(restored.dueDate)
        assertNull(restored.localEditedAt)
        assertNull(restored.history)
        assertNull(restored.firstLearnedDate)
    }

    @Test
    fun emptyAliasesEncodeToEmptyJsonArray() {
        val row = EntryCodec.toEntity(
            Entry(studyKey = "k", book = "b", source = "b", nodeId = "n", word = "w"),
        )
        assertEquals("[]", row.aliasesJson)
        assertEquals(emptyList<String>(), EntryCodec.decodeAliases(row.aliasesJson))
    }

    @Test
    fun aliasesWithCommasAndUnicodeSurvive() {
        val aliases = listOf("苹果", "a,b", "\"quoted\"", "line\nbreak")
        val row = EntryCodec.toEntity(
            Entry(
                studyKey = "k", book = "b", source = "b", nodeId = "n", word = "w",
                aliases = aliases,
            ),
        )
        assertEquals(aliases, EntryCodec.decodeAliases(row.aliasesJson))
    }

    @Test
    fun historyOrderIsPreserved() {
        val history = listOf(
            ReviewRecord("2026-08-01T00:00:00Z", "again"),
            ReviewRecord("2026-08-02T00:00:00Z", "hard"),
            ReviewRecord("2026-08-03T00:00:00Z", "good"),
        )
        val row = EntryCodec.toEntity(
            Entry(
                studyKey = "k", book = "b", source = "b", nodeId = "n", word = "w",
                history = history,
            ),
        )
        assertEquals(history, EntryCodec.decodeHistory(row.historyJson))
    }

    @Test
    fun brokenStoredJsonDegradesGracefully() {
        assertEquals(emptyList<String>(), EntryCodec.decodeAliases("{oops"))
        assertNull(EntryCodec.decodeHistory("{oops"))
        assertNull(EntryCodec.decodeHistory(null))
    }

    @Test
    fun progressViewMatchesEngineEntryProgress() {
        // Entry.progress 是散字段的打包视图；映射后必须等价
        val original = fullEntry()
        val restored = EntryCodec.toEntry(EntryCodec.toEntity(original))
        assertEquals(original.progress, restored.progress)
    }

    @Test
    fun studyProgressFieldsSurviveThroughEntity() {
        val entry = fullEntry()
        val restored = EntryCodec.toEntry(EntryCodec.toEntity(entry))
        val p: StudyProgress = restored.progress
        assertEquals("review", p.status)
        assertEquals(2, p.stage)
        assertEquals(12.5, p.s!!, 1e-9)
        assertEquals(6.25, p.d!!, 1e-9)
        assertEquals(3, p.lapses)
        assertEquals("2026-09-01", p.dueDate)
        assertEquals("2026-08-20T10:00:00Z", p.lastReview)
        assertEquals("graduated", p.lifecycle)
        assertEquals(true, p.pinned)
    }

    @Test
    fun bookDisplayNameMatchesIosRule() {
        assertEquals(
            "英语词库",
            EntryCodec.toEntry(EntryCodec.toEntity(fullEntry())).bookDisplayName,
        )
    }

    @Test
    fun fieldsOutsideProgressAreCarriedThroughEntity() {
        // s / d / lapses / dueDate... 之外的字段（color / addedDate / mastered / stage）也不能丢
        val row = EntryCodec.toEntity(fullEntry())
        assertEquals("4", row.color)
        assertEquals("2026-08-01", row.addedDate)
        assertEquals(true, row.mastered)
        assertEquals(2, row.stage)
        assertEquals("node-1", row.nodeId)
    }

    @Test
    fun entityEqualityReflectsAllColumns() {
        val row = EntryCodec.toEntity(fullEntry())
        val changed = row.copy(word = "other")
        assertTrue(row != changed)
    }
}

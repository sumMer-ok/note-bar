package com.notebar.app.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Room 与 DataStore 的**设备上**测试。
 *
 * 这些路径依赖 Android 框架（SQLite、DataStore 文件锁），JVM 单测无法覆盖，
 * 因此放在 `androidTest/`。没有模拟器/真机时 `connectedAndroidTest` 不会执行，
 * 但 `assembleDebugAndroidTest` 会保证它们能编译。
 */
@RunWith(AndroidJUnit4::class)
class EntryDaoTest {

    private lateinit var db: NoteBarDatabase
    private lateinit var dao: EntryDao

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, NoteBarDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = db.entryDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    private fun row(
        key: String = "en:word:apple",
        word: String = "apple",
        book: String = "Words/a.canvas",
    ) = EntryCodec.toEntity(
        com.notebar.engine.Entry(
            studyKey = key,
            book = book,
            source = book,
            nodeId = "n-$word",
            word = word,
            definition = "n. 苹果",
            addedDate = "2026-08-01",
            firstLearnedDate = "2026-08-02",
            s = 3.5,
        ),
    )

    @Test
    fun upsertThenReadBackIsLossless() = runBlocking {
        val entity = row()
        dao.upsert(entity)
        assertEquals(entity, dao.findByKey(entity.studyKey))
    }

    @Test
    fun upsertOverwritesExistingRow() = runBlocking {
        val entity = row()
        dao.upsert(entity)
        val changed = entity.copy(word = "apples", s = 9.0)
        dao.upsert(changed)
        assertEquals(changed, dao.findByKey(entity.studyKey))
        assertEquals(1, dao.count())
    }

    @Test
    fun deleteByBookRemovesOnlyThatBook() = runBlocking {
        dao.upsert(row(key = "k1", word = "a", book = "Words/a.canvas"))
        dao.upsert(row(key = "k2", word = "b", book = "Words/b.canvas"))
        dao.deleteByBook("Words/a.canvas")
        assertNull(dao.findByKey("k1"))
        assertNotNull(dao.findByKey("k2"))
    }

    @Test
    fun historyAndAliasesSurviveRealSqliteRoundTrip() = runBlocking {
        val entry = com.notebar.engine.Entry(
            studyKey = "k",
            book = "Words/a.canvas",
            source = "Words/a.canvas",
            nodeId = "n",
            word = "sustain",
            aliases = listOf("sustained", "维持"),
            history = listOf(
                com.notebar.engine.ReviewRecord("2026-08-01T00:00:00Z", "again"),
                com.notebar.engine.ReviewRecord("2026-08-02T00:00:00Z", "good"),
            ),
        )
        val entity = EntryCodec.toEntity(entry)
        dao.upsert(entity)
        assertEquals(entry, EntryCodec.toEntry(dao.findByKey("k")!!))
    }

    @Test
    fun localEditedAtIsPersisted() = runBlocking {
        val entity = row().copy(localEditedAt = "2026-08-21T08:30:00Z")
        dao.upsert(entity)
        assertEquals("2026-08-21T08:30:00Z", dao.findByKey(entity.studyKey)?.localEditedAt)
    }
}

/** DataStore Preferences 的设备上回归：写入后必须能读回，且默认值正确 */
@RunWith(AndroidJUnit4::class)
class SettingsRepositoryTest {

    private lateinit var repo: SettingsRepository

    @Before
    fun setUp() = runBlocking {
        repo = SettingsRepository(ApplicationProvider.getApplicationContext())
        // 隔离：DataStore 是进程级单文件，上一个用例写入的值会漏到下一个用例
        // （曾把 defaultsAreIosDefaultsOnFreshInstall 误判成"生产默认值错了"——实际默认值是对的）。
        // 每个用例开始前显式清空，保证「全新安装」语义成立。
        repo.resetForTest()
    }

    @Test
    fun defaultsAreIosDefaultsOnFreshInstall() = runBlocking {
        assertEquals(20, repo.currentSettings().dailyNewWordLimit)
        assertEquals(Settings.Appearance.system, repo.currentSettings().appearance)
    }

    @Test
    fun updatePersistsAcrossReads() = runBlocking {
        repo.update { it.copy(appearance = Settings.Appearance.dark, dailyNewWordLimit = 7) }
        val read = repo.currentSettings()
        assertEquals(Settings.Appearance.dark, read.appearance)
        assertEquals(7, read.dailyNewWordLimit)
    }

    @Test
    fun reinforceDraftRoundTripsAndClears() = runBlocking {
        val draft = com.notebar.engine.ReinforceDraft(
            weakKeys = listOf("k1"),
            currentRound = listOf("k1"),
            nextRound = emptyList(),
            round = 1,
            totalAnswers = 2,
            tallies = emptyMap(),
            books = listOf("Words/a.canvas"),
            answerLimit = 50,
            updatedAt = "2026-08-20T10:00:00Z",
        )
        repo.saveReinforceDraft(draft)
        assertEquals(draft, repo.reinforceDraft.first())
        repo.clearReinforceDraft()
        assertNull(repo.reinforceDraft.first())
    }

    @Test
    fun nonResumableDraftIsTreatedAsAbsent() = runBlocking {
        val empty = com.notebar.engine.ReinforceDraft(
            weakKeys = emptyList(),
            currentRound = emptyList(),
            nextRound = emptyList(),
            round = 1,
            totalAnswers = 3,
            tallies = emptyMap(),
            books = emptyList(),
            answerLimit = 50,
            updatedAt = "2026-08-20T10:00:00Z",
        )
        repo.saveReinforceDraft(empty)
        // 队列已空 → 不该再让用户点进来（对应 iOS loadReinforceDraft 的 isResumable 闸门）
        assertNull(repo.reinforceDraft.first())
    }

    @Test
    fun syncRootRoundTrips() = runBlocking {
        repo.setSyncRoot("/tmp/notebar")
        assertEquals("/tmp/notebar", repo.syncRoot.first())
        repo.setSyncRoot(null)
        assertNull(repo.syncRoot.first())
    }

    @Test
    fun defaultAndPinnedBooksToggle() = runBlocking {
        repo.setDefaultBook("Words/a.canvas", true)
        repo.setPinnedBook("Words/a.canvas", true)
        var s = repo.currentSettings()
        assertEquals(listOf("Words/a.canvas"), s.defaultBooks)
        assertEquals(listOf("Words/a.canvas"), s.pinnedBooks)

        repo.setDefaultBook("Words/a.canvas", false)
        repo.setPinnedBook("Words/a.canvas", false)
        s = repo.currentSettings()
        assertEquals(emptyList<String>(), s.defaultBooks)
        assertEquals(emptyList<String>(), s.pinnedBooks)
    }
}

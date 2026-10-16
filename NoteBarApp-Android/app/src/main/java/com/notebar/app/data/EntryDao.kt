package com.notebar.app.data

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/**
 * 词条读写。
 *
 * Room 表只是本地缓存；`.canvas` / `.nb-sync.json` 才是 source of truth（红线 2）。
 * 因此这里**不提供**任何"以本地覆盖云端"的接口，同步方向一律由
 * `SyncEngine.applyRemote` / `SyncEngine.writeSidecar` 决定。
 */
@Dao
interface EntryDao {

    @Query("SELECT * FROM entries")
    fun observeAll(): Flow<List<EntryEntity>>

    @Query("SELECT * FROM entries")
    suspend fun all(): List<EntryEntity>

    @Query("SELECT * FROM entries WHERE studyKey = :key LIMIT 1")
    suspend fun findByKey(key: String): EntryEntity?

    @Query("SELECT * FROM entries WHERE studyKey = :key LIMIT 1")
    fun observeByKey(key: String): Flow<EntryEntity?>

    @Query("SELECT * FROM entries WHERE book = :book")
    suspend fun byBook(book: String): List<EntryEntity>

    @Query("SELECT COUNT(*) FROM entries")
    suspend fun count(): Int

    @Upsert
    suspend fun upsert(entry: EntryEntity)

    @Upsert
    suspend fun upsertAll(entries: List<EntryEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(entry: EntryEntity)

    @Query("DELETE FROM entries WHERE studyKey = :key")
    suspend fun deleteByKey(key: String)

    @Query("DELETE FROM entries WHERE book = :book")
    suspend fun deleteByBook(book: String)
}

@Database(entities = [EntryEntity::class], version = 1, exportSchema = false)
abstract class NoteBarDatabase : RoomDatabase() {
    abstract fun entryDao(): EntryDao

    companion object {
        const val NAME = "notebar.db"
    }
}

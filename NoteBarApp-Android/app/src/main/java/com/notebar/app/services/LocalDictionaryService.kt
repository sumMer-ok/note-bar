package com.notebar.app.services

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.io.InputStream

/**
 * 一个词典词条。
 *
 * phonetic 对应 JSON 的 p 字段（音标，可缺失）；definitions 对应 d（中文释义）；
 * aliases 对应 a（别名）。缺失的字段一律退化成 null / 空列表，不会让整条词条失败。
 */
data class DictionaryEntry(
    val phonetic: String?,
    val definitions: List<String>,
    val aliases: List<String>,
)

/**
 * 本地中文词典服务（对齐桌面 LocalDictionaryService 的中文词典部分）。
 *
 * 数据源是扁平 JSON：顶层是一个对象，键是小写词形，值含 p 音标、d 释义数组、a 别名数组。
 *
 * 查词口径与桌面 lookupSync 完全一致：word.trim().lowercase() 作为键直查，
 * 只 trim 前后空白，不去标点、不做词形还原、不做模糊匹配。
 *
 * 加载策略：
 * - 延迟加载，首次查询才读流；
 * - 去重，重复查询不会重复解析；
 * - 失败缓存，解析或读取失败后不再重试，之后一直返回 null。
 *
 * 线程安全：@Volatile 快照 + synchronized 双重检查，并发首次查询只会解析一次。
 *
 * 调用方注意（坑）：词典尚未加载完成、加载失败、或词确实不在词典里，
 * lookupSync 都会返回 null。所以不能只凭 null 判断「这个词不在词典里」，
 * 需要区分时请先看 wordCount() 是否大于 0。
 */
class LocalDictionaryService(private val open: () -> InputStream) {

    /** 已解析的词典快照；null 表示还没成功加载过。 */
    @Volatile
    private var entries: Map<String, DictionaryEntry>? = null

    /** 是否已经尝试过加载（成功或失败都算），用于失败缓存。 */
    private var loadAttempted = false

    private val lock = Any()

    /**
     * 同步查词。命中返回词条，未命中 / 未加载完成 / 加载失败均返回 null。
     */
    fun lookupSync(word: String): DictionaryEntry? {
        val key = word.trim().lowercase()
        if (key.isEmpty()) return null
        return loadedEntries()[key]
    }

    /** 词条数量。未加载完成或加载失败时返回 0。 */
    fun wordCount(): Int = loadedEntries().size

    private fun loadedEntries(): Map<String, DictionaryEntry> {
        entries?.let { return it }
        synchronized(lock) {
            entries?.let { return it }
            if (loadAttempted) return EMPTY
            loadAttempted = true
            val parsed = try {
                parse(readAll(open()))
            } catch (t: Throwable) {
                // 失败缓存：不再重试，之后一直走 EMPTY 分支。
                null
            }
            if (parsed == null) return EMPTY
            entries = parsed
            return parsed
        }
    }

    private fun readAll(stream: InputStream): String = stream.use { it.readBytes().toString(Charsets.UTF_8) }

    private fun parse(raw: String): Map<String, DictionaryEntry> {
        val root = Json.parseToJsonElement(raw).jsonObject
        val result = HashMap<String, DictionaryEntry>(root.size * 2)
        for ((word, element) in root) {
            val obj = element as? JsonObject ?: continue
            val key = word.trim().lowercase()
            if (key.isEmpty()) continue
            result[key] = DictionaryEntry(
                phonetic = (obj["p"] as? JsonPrimitive)?.contentOrNullIfString(),
                definitions = obj.stringList("d"),
                aliases = obj.stringList("a"),
            )
        }
        return result
    }

    private fun JsonObject.stringList(field: String): List<String> {
        val array = this[field] as? JsonArray ?: return emptyList()
        return array.mapNotNull { (it as? JsonPrimitive)?.contentOrNullIfString() }
    }

    private fun JsonPrimitive.contentOrNullIfString(): String? = if (this is kotlinx.serialization.json.JsonNull) null else content

    private companion object {
        val EMPTY: Map<String, DictionaryEntry> = emptyMap()
    }
}

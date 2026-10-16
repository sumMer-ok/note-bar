package com.notebar.engine

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * FSRS 冻结向量测试。
 *
 * 数据源 `sync-vectors.json` 与 iOS（NoteBarAppTests/Fixtures）和桌面端
 * （tests/fixtures）**逐字节相同**，三方共用同一份黄金数据：
 * 只要 Kotlin 侧全绿，就证明三端算法数值一致。
 */
class FsrsVectorTests {

    private fun loadVectors(): List<Pair<Map<String, kotlinx.serialization.json.JsonElement>, Map<String, kotlinx.serialization.json.JsonElement>>> {
        val stream = javaClass.getResourceAsStream("/sync-vectors.json")
            ?: error("找不到测试向量 /sync-vectors.json")
        val root = Json.parseToJsonElement(stream.readBytes().decodeToString()).jsonObject
        return root.getValue("fsrs").jsonArray.map { element ->
            val obj = element.jsonObject
            obj.getValue("input").jsonObject to obj.getValue("output").jsonObject
        }
    }

    private fun nullableDouble(element: kotlinx.serialization.json.JsonElement?): Double? =
        if (element == null || element is JsonNull) null else element.jsonPrimitive.doubleOrNull

    @Test
    fun frozenVectors() {
        val vectors = loadVectors()
        assertTrue(vectors.isNotEmpty(), "向量文件不应为空")

        for ((input, output) in vectors) {
            val s = nullableDouble(input["s"])
            val d = nullableDouble(input["d"])
            val elapsed = input.getValue("elapsedDays").jsonPrimitive.doubleOrNull!!
            val grade = FsrsGrade.of(input.getValue("grade").jsonPrimitive.int)

            val nextS: Double
            val nextD: Double
            if (s != null && d != null) {
                val r = FSRS.retrievability(elapsed, s)
                nextS = if (grade == FsrsGrade.Again) {
                    FSRS.nextForgetStability(d, s, r)
                } else {
                    FSRS.nextRecallStability(d, s, r, grade)
                }
                nextD = FSRS.nextDifficulty(d, grade)
            } else {
                nextS = FSRS.initStability(grade)
                nextD = FSRS.initDifficulty(grade)
            }

            val expectedS = output.getValue("s").jsonPrimitive.doubleOrNull!!
            val expectedD = output.getValue("d").jsonPrimitive.doubleOrNull!!
            val expectedInterval = output.getValue("interval").jsonPrimitive.int

            assertEquals(expectedS, nextS, 1e-9, "s 不匹配，输入=$input")
            assertEquals(expectedD, nextD, 1e-9, "d 不匹配，输入=$input")
            assertEquals(expectedInterval, FSRS.nextInterval(nextS), "interval 不匹配，输入=$input")
        }
    }

    /** schedule() 的 dueDate 口径：基准日 + interval 天，格式 YYYY-MM-DD */
    @Test
    fun scheduleComputesDueDateFromToday() {
        val today = java.time.LocalDate.of(2026, 8, 17)
        val result = FSRS.schedule(
            s = null, d = null, lapses = null,
            elapsedDays = 0.0, grade = FsrsGrade.Good, today = today,
        )
        assertEquals(3, result.interval)
        assertEquals("2026-08-20", result.dueDate)
        assertEquals(0, result.lapses)
        assertTrue(!result.graduated, "s=3.173 未达 30 天毕业线")
    }
}

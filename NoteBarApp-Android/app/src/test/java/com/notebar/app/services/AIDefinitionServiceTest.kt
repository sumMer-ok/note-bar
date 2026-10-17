package com.notebar.app.services

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [AIDefinitionService] 单测：全部走假 HTTP，永不触网。
 *
 * 覆盖契约里最容易回归的两块：容错解析链的顺序，以及 8 个错误分支的文案/优先级。
 */
class AIDefinitionServiceTest {

    // ---------- ① 纯 JSON ----------

    @Test
    fun `parses pure json payload`() {
        val content = """{"definition":"1）英/ test /\n2）n. 测试","aliases":["tests","testing"]}"""
        val result = parseContent(content, "stop")

        assertEquals("1）英/ test /\n2）n. 测试", result.definition)
        assertEquals(listOf("tests", "testing"), result.aliases)
    }

    // ---------- ② markdown 围栏包裹 ----------

    @Test
    fun `unwraps markdown fenced json`() {
        val content = """
            ```json
            {"definition":"n. 维持","aliases":["Sustain"]}
            ```
        """.trimIndent()
        val result = parseContent(content, "stop")

        assertEquals("n. 维持", result.definition)
        assertEquals(listOf("sustain"), result.aliases)
    }

    // ---------- ③ 前后有废话，只有大括号块是正文 ----------

    @Test
    fun `extracts braces block surrounded by prose`() {
        val content = "好的，这是结果：\n{\"definition\": \"v. 支撑\", \"aliases\": [\"Sustained\"]}\n希望对你有帮助。"
        val result = parseContent(content, "stop")

        assertEquals("v. 支撑", result.definition)
        assertEquals(listOf("sustained"), result.aliases)
    }

    // ---------- ④ 尾随逗号 repaired ----------

    @Test
    fun `repairs trailing commas`() {
        val content = """{"definition":"v. 遭受","aliases":["sustains",],}"""
        val result = parseContent(content, "stop")

        assertEquals("v. 遭受", result.definition)
        assertEquals(listOf("sustains"), result.aliases)
    }

    @Test
    fun `repairs unescaped newlines inside strings`() {
        val content = "{\"definition\":\"第一行\n第二行\",\"aliases\":[\"a\"]}"
        val result = parseContent(content, "stop")

        assertEquals("第一行\n第二行", result.definition)
        assertEquals(listOf("a"), result.aliases)
    }

    // ---------- ⑤ 完全坏掉但有 definition 字段可抠 ----------

    @Test
    fun `extracts fields when json is unrepairable`() {
        // 少了一个逗号：严格解析与 repair 都救不回来，只能靠字段抠取
        val content = """{"definition":"v. 保持" "aliases":["Kept","keeping"]}"""
        val result = parseContent(content, "stop")

        assertEquals("v. 保持", result.definition)
        assertEquals(listOf("kept", "keeping"), result.aliases)
    }

    // ---------- ⑥ finish_reason=length → truncated ----------

    @Test
    fun `throws truncated when finish reason is length and content empty`() {
        val error = assertThrows(AIDefinitionError.Truncated::class.java) {
            parseContent("   ", "length")
        }
        assertEquals(
            "AI 输出被截断（推理模型的思考消耗了全部 max_tokens），请调大模型或更换模型",
            error.message,
        )
    }

    @Test
    fun `empty content without length finish reason is invalid response`() {
        assertThrows(AIDefinitionError.InvalidResponse::class.java) {
            parseContent("", "stop")
        }
    }

    @Test
    fun `non empty content is still parsed when finish reason is length`() {
        // 与 iOS 一致：只有内容为空时才判定截断
        val result = parseContent("""{"definition":"d","aliases":[]}""", "length")
        assertEquals("d", result.definition)
    }

    // ---------- ⑦ HTTP 400 → http(400) ----------

    @Test
    fun `http error code is surfaced`() = runBlocking {
        val http = FakeHttpPost(status = 400, responseBody = """{"error":{"message":"bad request"}}""")
        val error = assertThrows(AIDefinitionError.Http::class.java) {
            runBlocking { fetchDefinition("sustain", config = config(), http = http) }
        }
        assertEquals(400, error.code)
        assertEquals("HTTP 400", error.message)
    }

    // ---------- ⑧ chatCompletionsURL 去重斜杠 ----------

    @Test
    fun `chat completions url trims slashes and appends suffix`() {
        assertEquals(
            "https://api.openai.com/v1/chat/completions",
            chatCompletionsURL("https://api.openai.com/v1"),
        )
        assertEquals(
            "https://api.openai.com/v1/chat/completions",
            chatCompletionsURL("https://api.openai.com/v1/"),
        )
        assertEquals(
            "https://api.openai.com/v1/chat/completions",
            chatCompletionsURL("https://api.openai.com/v1///"),
        )
        // 已经是完整路径时不要重复拼接
        assertEquals(
            "https://api.openai.com/v1/chat/completions",
            chatCompletionsURL("https://api.openai.com/v1/chat/completions"),
        )
    }

    // ---------- ⑨ 缺 key / 缺 model 抛对应错误 ----------

    @Test
    fun `missing key is rejected`() = runBlocking {
        val error = assertThrows(AIDefinitionError.MissingKey::class.java) {
            runBlocking { fetchDefinition("sustain", config = config(apiKey = "   "), http = FakeHttpPost()) }
        }
        assertEquals("API Key 未配置", error.message)
    }

    @Test
    fun `missing model is rejected`() = runBlocking {
        val error = assertThrows(AIDefinitionError.MissingModel::class.java) {
            runBlocking { fetchDefinition("sustain", config = config(model = ""), http = FakeHttpPost()) }
        }
        assertEquals("模型 ID 不能为空", error.message)
    }

    @Test
    fun `blank word is rejected before anything else`() = runBlocking {
        val error = assertThrows(AIDefinitionError.InvalidWord::class.java) {
            runBlocking {
                fetchDefinition("  \n ", config = config(apiUrl = "", apiKey = "", model = ""), http = FakeHttpPost())
            }
        }
        assertEquals("单词不能为空", error.message)
    }

    @Test
    fun `missing and malformed urls are rejected`() = runBlocking {
        assertThrows(AIDefinitionError.MissingURL::class.java) {
            runBlocking { fetchDefinition("sustain", config = config(apiUrl = "  "), http = FakeHttpPost()) }
        }
        val invalid = assertThrows(AIDefinitionError.InvalidURL::class.java) {
            runBlocking { fetchDefinition("sustain", config = config(apiUrl = "not a url"), http = FakeHttpPost()) }
        }
        assertEquals("API 地址格式无效", invalid.message)
    }

    // ---------- 请求体契约 ----------

    @Test
    fun `request body carries model messages and merged extra params`() = runBlocking {
        val http = FakeHttpPost(status = 200, responseBody = completion("""{"definition":"d","aliases":[]}"""))
        val cfg = config(extraParams = """{"temperature":0.9,"top_p":0.5}""")

        fetchDefinition("sustain", sentence = "The court sustained the objection.", config = cfg, http = http)

        assertEquals("https://api.example.com/v1/chat/completions", http.lastUrl)
        assertEquals("Bearer sk-test", http.lastHeaders["Authorization"])
        assertEquals("application/json", http.lastHeaders["Content-Type"])

        val body = Json.parseToJsonElement(assertNotNull(http.lastBody).let { http.lastBody!! }).jsonObject
        assertEquals("gpt-4o-mini", body["model"]!!.jsonPrimitive.content)
        assertEquals("4096", body["max_tokens"]!!.jsonPrimitive.content)
        // extraParams 覆盖顶层同名键
        assertEquals("0.9", body["temperature"]!!.jsonPrimitive.content)
        assertEquals("0.5", body["top_p"]!!.jsonPrimitive.content)

        val message = body["messages"]!!.jsonArray.single().jsonObject
        assertEquals("user", message["role"]!!.jsonPrimitive.content)
        val prompt = message["content"]!!.jsonPrimitive.content
        assertTrue(prompt, prompt.contains("sustain"))
        assertTrue(prompt, prompt.contains("The court sustained the objection."))
    }

    @Test
    fun `unparsable extra params are ignored`() = runBlocking {
        val http = FakeHttpPost(status = 200, responseBody = completion("""{"definition":"d","aliases":[]}"""))
        fetchDefinition("sustain", config = config(extraParams = "not json"), http = http)

        val body = Json.parseToJsonElement(http.lastBody!!).jsonObject
        assertEquals("0.3", body["temperature"]!!.jsonPrimitive.content)
    }

    @Test
    fun `response without choices is invalid response`() = runBlocking<Unit> {
        val http = FakeHttpPost(status = 200, responseBody = """{"id":"x"}""")
        assertThrows(AIDefinitionError.InvalidResponse::class.java) {
            runBlocking { fetchDefinition("sustain", config = config(), http = http) }
        }
    }

    // ---------- 兜底：没有任何大括号时整段当释义 ----------

    @Test
    fun `plain text without braces falls back to whole text`() {
        val result = parseContent("  n. 维持，保持  ", "stop")

        assertEquals("n. 维持，保持", result.definition)
        assertTrue(result.aliases.isEmpty())
    }

    @Test
    fun `aliases are trimmed lowercased and blank entries dropped`() {
        val content = """{"definition":"d","aliases":["  Sue ","","SUING"]}"""
        val result = parseContent(content, "stop")

        assertEquals(listOf("sue", "suing"), result.aliases)
    }

    // ---------- 测试替身 ----------

    private fun config(
        apiUrl: String = "https://api.example.com/v1",
        apiKey: String = "sk-test",
        model: String = "gpt-4o-mini",
        extraParams: String = "{}",
        prompt: String = "单词：{{word}}；上下文：{{sentence}}",
    ): AIConfig = AIConfig(
        apiUrl = apiUrl,
        apiKey = apiKey,
        model = model,
        extraParams = extraParams,
        prompt = prompt,
    )

    private fun completion(content: String, finishReason: String? = "stop"): String = buildJsonObject {
        putJsonArray("choices") {
            addJsonObject {
                put("finish_reason", finishReason)
                putJsonObject("message") {
                    put("role", "assistant")
                    put("content", content)
                }
            }
        }
    }.toString()

    private class FakeHttpPost(
        private val status: Int = 200,
        private val responseBody: String = "",
    ) : HttpPost {
        var lastUrl: String? = null
            private set
        var lastHeaders: Map<String, String> = emptyMap()
            private set
        var lastBody: String? = null
            private set

        override suspend fun post(
            url: String,
            headers: Map<String, String>,
            body: String,
        ): HttpPostResult {
            lastUrl = url
            lastHeaders = headers
            lastBody = body
            return HttpPostResult(status, responseBody)
        }
    }
}

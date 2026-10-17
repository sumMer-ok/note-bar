package com.notebar.app.services

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * AI 释义（英汉词典）服务，逐条对齐 iOS `NoteBarApp/Services/AIDefinitionService.swift`。
 *
 * 三端行为口径一致是硬约束：请求体字段、`{{word}}`/`{{sentence}}` 占位符替换顺序、
 * 容错解析链（代码块 → 大括号块 → 严格 JSON → repair → 字段抠取 → 整体兜底）、
 * 8 个错误分支的文案，全部与 iOS 逐字相同。改动前请先对照 Swift 原件。
 *
 * 红线：不新增第三方依赖——JSON 用工程已有的 kotlinx-serialization-json，
 * HTTP 用 JDK 内置 `HttpURLConnection`（见 [HttpUrlConnectionHttpPost]）。
 */

/** 一次 AI 释义的结果。[aliases] 已去首尾空白、转小写、去掉空串 */
data class AIDefinitionResult(val definition: String, val aliases: List<String>)

/**
 * 与 iOS `AIDefinitionError` 的 8 个 case 一一对应；[message] 即 iOS 的 `errorDescription`，
 * UI 直接展示它，不要改写文案。
 */
sealed class AIDefinitionError(message: String) : Exception(message) {
    /** 单词不能为空 */
    object InvalidWord : AIDefinitionError("单词不能为空")

    /** API 地址不能为空 */
    object MissingURL : AIDefinitionError("API 地址不能为空")

    /** API Key 未配置 */
    object MissingKey : AIDefinitionError("API Key 未配置")

    /** 模型 ID 不能为空 */
    object MissingModel : AIDefinitionError("模型 ID 不能为空")

    /** API 地址格式无效 */
    object InvalidURL : AIDefinitionError("API 地址格式无效")

    /** HTTP 错误码（>= 400 时抛出，错误体不参与判断，与 iOS 一致） */
    data class Http(val code: Int) : AIDefinitionError("HTTP $code")

    /** API 返回了无效的响应格式 */
    object InvalidResponse : AIDefinitionError("API 返回了无效的响应格式")

    /** AI 输出被截断（推理模型的思考消耗了全部 max_tokens），请调大模型或更换模型 */
    object Truncated : AIDefinitionError(
        "AI 输出被截断（推理模型的思考消耗了全部 max_tokens），请调大模型或更换模型",
    )
}

/** 与 iOS `AIDefinitionService.Config` 同构：五个字段都来自设置页（Settings） */
data class AIConfig(
    val apiUrl: String,
    val apiKey: String,
    val model: String,
    val extraParams: String,
    val prompt: String,
)

/** 一次 HTTP POST 的结果；[status] 是 HTTP 状态码，[body] 是 UTF-8 响应文本 */
data class HttpPostResult(val status: Int, val body: String)

/**
 * HTTP 端口：把「怎么发请求」与「请求什么」拆开，单测据此注入假实现，**永不触网**。
 *
 * 不复用 `sync/HttpTransport` 的原因：它的 [com.notebar.app.sync.HttpBody] 只有
 * 表单与 multipart 两种请求体，没有原始 JSON；而 chat/completions 必须发 JSON。
 * 语义对齐 `fetch`：**传输层失败抛 IOException，HTTP 错误码不抛**（错误码由上层判定）。
 */
interface HttpPost {
    suspend fun post(url: String, headers: Map<String, String>, body: String): HttpPostResult
}

/** [HttpPost] 的默认实现：JDK 内置 `HttpURLConnection`，不新增任何依赖 */
class HttpUrlConnectionHttpPost(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 120_000,
) : HttpPost {

    override suspend fun post(url: String, headers: Map<String, String>, body: String): HttpPostResult =
        withContext(Dispatchers.IO) {
            val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
                instanceFollowRedirects = true
                for ((name, value) in headers) setRequestProperty(name, value)
            }
            try {
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
                val status = connection.responseCode
                // 4xx/5xx 时 getInputStream 会抛，错误体必须从 errorStream 读
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val bytes = stream?.use { it.readBytes() } ?: ByteArray(0)
                HttpPostResult(status, String(bytes, StandardCharsets.UTF_8))
            } finally {
                connection.disconnect()
            }
        }
}

/** 生产默认端口；单测传入自己的假实现 */
val defaultHttpPost: HttpPost = HttpUrlConnectionHttpPost()

/** 与 iOS `Bundle.main.url(forResource: "ai-definition-prompt", withExtension: "txt")` 同名资产 */
const val AI_DEFINITION_PROMPT_ASSET: String = "ai-definition-prompt.txt"

/** iOS `loadPrompt()` 里资源缺失时的最小兜底文案，逐字相同 */
private const val FALLBACK_PROMPT: String =
    "请为单词 \"{{word}}\" 生成英汉词典释义。只输出 JSON：{\"aliases\": [], \"definition\": \"\"}"

/**
 * 从 assets 加载与插件逐字一致的提示词；读不到或读到空串时回落内置常量（对齐 iOS `loadPrompt`）。
 *
 * 注意：这里不做缓存——调用方（ViewModel）在设置页改完提示词后应当重新调用。
 */
fun loadPrompt(context: Context): String {
    val text = runCatching {
        context.assets.open(AI_DEFINITION_PROMPT_ASSET).use { input ->
            String(input.readBytes(), StandardCharsets.UTF_8)
        }
    }.getOrNull()
    return if (!text.isNullOrEmpty()) text else FALLBACK_PROMPT
}

/** 法律词典 OCR 校对提示词（`{{sentence}}` 位置传入待纠正的原文）；与 iOS 同名字段逐字相同 */
val legalCorrectionPrompt: String = """
你是法律词典校对助手。下面是经过 OCR 识别的英文法律词典释义（来自 Black's Law Dictionary），可能存在错字、乱码、断行错误、标点错误和多余空格。请在不改变原意的前提下：
1）纠正所有 OCR 识别错误；
2）按编号条目（1. 2. 3.）重新组织段落，删除多余换行；
3）保持英文原文，不翻译、不增删词义。
只输出纠正后的纯文本，不要任何解释、不要 markdown 标题、不要 JSON。

待纠正的原文：
{{sentence}}
""".trimIndent()

/**
 * 请求一次 AI 释义，行为逐条对齐 iOS `fetchDefinition`：
 * 1）按顺序校验 word / apiUrl / apiKey / model（文案即错误信息）；
 * 2）把 `{{word}}` 与 `{{sentence}}` 替换进提示词；
 * 3）拼 `/chat/completions`，body = model + messages + temperature 0.3 + max_tokens 4096，
 *    `extraParams` 能解析成 JSON 对象时深合并进顶层；
 * 4）status >= 400 抛 [AIDefinitionError.Http]；
 * 5）取 `choices[0].message.content` 与 `choices[0].finish_reason` 交给 [parseContent]。
 */
suspend fun fetchDefinition(
    word: String,
    sentence: String = "",
    config: AIConfig,
    http: HttpPost = defaultHttpPost,
): AIDefinitionResult {
    val cleanWord = word.trim()
    if (cleanWord.isEmpty()) throw AIDefinitionError.InvalidWord
    if (config.apiUrl.trim().isEmpty()) throw AIDefinitionError.MissingURL
    if (config.apiKey.trim().isEmpty()) throw AIDefinitionError.MissingKey
    if (config.model.trim().isEmpty()) throw AIDefinitionError.MissingModel

    val prompt = config.prompt
        .replace("{{word}}", cleanWord)
        .replace("{{sentence}}", sentence)

    val url = chatCompletionsURL(config.apiUrl)
    // iOS 用 URL(string:) 校验；Kotlin 侧 URL 要求带协议，相对地址在此即被拒
    runCatching { URL(url) }.getOrElse { throw AIDefinitionError.InvalidURL }

    var body = buildJsonObject {
        put("model", config.model)
        putJsonArray("messages") {
            addJsonObject {
                put("role", "user")
                put("content", prompt)
            }
        }
        put("temperature", 0.3)
        // 4096：推理模型会先把预算花在 reasoning tokens 上，500 会导致 content 为空
        put("max_tokens", 4096)
    }
    val extra = runCatching { Json.parseToJsonElement(config.extraParams.trim()) as? JsonObject }
        .getOrNull()
    if (extra != null) body = deepMerge(body, extra)

    val response = http.post(
        url = url,
        headers = mapOf(
            "Content-Type" to "application/json",
            "Authorization" to "Bearer ${config.apiKey}",
        ),
        body = body.toString(),
    )
    if (response.status >= 400) throw AIDefinitionError.Http(response.status)

    val json = runCatching { Json.parseToJsonElement(response.body) }.getOrNull() as? JsonObject
        ?: throw AIDefinitionError.InvalidResponse
    val choices = json["choices"] as? JsonArray ?: throw AIDefinitionError.InvalidResponse
    val first = choices.firstOrNull() as? JsonObject ?: throw AIDefinitionError.InvalidResponse
    val message = first["message"] as? JsonObject ?: throw AIDefinitionError.InvalidResponse
    val content = stringValue(message["content"]) ?: throw AIDefinitionError.InvalidResponse
    return parseContent(content, stringValue(first["finish_reason"]))
}

/**
 * 空内容说明请求成功但正文没吐出来：`finish_reason == "length"` 即被 max_tokens 截断
 * （推理模型常见）。直接报错，避免把空字符串当作生成结果写回释义。
 */
fun parseContent(content: String, finishReason: String?): AIDefinitionResult {
    if (content.trim().isEmpty()) {
        throw if (finishReason == "length") AIDefinitionError.Truncated else AIDefinitionError.InvalidResponse
    }
    return parse(content)
}

/**
 * 与插件 `parseDefinitionResponse` 相同的容错解析链，**顺序不可变**：
 * 1）提取 ```json ... ``` 代码块；
 * 2）提取第一个 `{...}` 块，依次尝试 严格 JSON → repair → 字段抠取；
 * 3）全都失败时把整段内容当作释义。
 */
fun parse(content: String): AIDefinitionResult {
    var text = content.trim()

    CODE_BLOCK_PATTERN.find(text)?.let { match ->
        text = match.groupValues[1].trim()
    }

    JSON_OBJECT_PATTERN.find(text)?.let { match ->
        val raw = match.value
        parseJsonObject(raw)?.let { return it }
        parseJsonObject(repair(raw))?.let { return it }
        extractFields(raw)?.let { return it }
    }

    return AIDefinitionResult(definition = text, aliases = emptyList())
}

/** 去首尾 `/` 后拼 `/chat/completions`；已是该后缀时原样返回（对齐 iOS `chatCompletionsURL`） */
fun chatCompletionsURL(base: String): String {
    val normalized = base.trim('/')
    return if (normalized.endsWith(CHAT_COMPLETIONS_SUFFIX)) normalized else normalized + CHAT_COMPLETIONS_SUFFIX
}

private const val CHAT_COMPLETIONS_SUFFIX: String = "/chat/completions"

// 与 Swift 正则逐字对应（顺序与语义不可改）
private val CODE_BLOCK_PATTERN = Regex("```(?:json)?\\s*([\\s\\S]*?)\\s*```")
private val JSON_OBJECT_PATTERN = Regex("\\{[\\s\\S]*\\}")
private val TRAILING_COMMA_PATTERN = Regex(",\\s*([}\\]])")
private val DEFINITION_FIELD_PATTERN = Regex("\"definition\"\\s*:\\s*\"([\\s\\S]*?)(?<!\\\\)\"")
private val ALIASES_FIELD_PATTERN = Regex("\"aliases\"\\s*:\\s*\\[([\\s\\S]*?)\\]")
private val ALIAS_ITEM_PATTERN = Regex("\"([^\"]*)\"")

/** 取 JSON 字符串值；null/非字符串/数字一律返回 null（对应 Swift 的 `as? String`） */
private fun stringValue(element: JsonElement?): String? {
    if (element is JsonNull) return null
    val primitive = element as? JsonPrimitive ?: return null
    return if (primitive.isString) primitive.content else null
}

private fun parseJsonObject(raw: String): AIDefinitionResult? {
    val obj = runCatching { Json.parseToJsonElement(raw) }.getOrNull() as? JsonObject ?: return null
    val definition = (stringValue(obj["definition"]) ?: "").trim()
    val aliases = (obj["aliases"] as? JsonArray ?: JsonArray(emptyList()))
        .mapNotNull { stringValue(it) }
        .map { it.trim().lowercase() }
        .filter { it.isNotEmpty() }
    if (definition.isEmpty() && aliases.isEmpty()) return null
    return AIDefinitionResult(definition = definition, aliases = aliases)
}

/** 修复常见错误：尾随逗号、字符串内的未转义换行 */
private fun repair(raw: String): String {
    val repaired = TRAILING_COMMA_PATTERN.replace(raw, "$1")
    return escapeNewlinesInStrings(repaired)
}

private fun escapeNewlinesInStrings(json: String): String {
    val result = StringBuilder(json.length)
    var inString = false
    var i = 0
    while (i < json.length) {
        val ch = json[i]
        if (inString) {
            if (ch == '\\' && i + 1 < json.length) {
                result.append(ch)
                result.append(json[i + 1])
                i += 2
                continue
            }
            when {
                ch == '"' -> {
                    inString = false
                    result.append(ch)
                }
                ch == '\n' -> result.append("\\n")
                else -> result.append(ch)
            }
        } else {
            if (ch == '"') inString = true
            result.append(ch)
        }
        i += 1
    }
    return result.toString()
}

/** JSON 整体解析失败时按字段抠取 */
private fun extractFields(raw: String): AIDefinitionResult? {
    var definition = ""
    DEFINITION_FIELD_PATTERN.find(raw)?.let { match ->
        definition = unescape(match.groupValues[1]).trim()
    }

    var aliases: List<String> = emptyList()
    ALIASES_FIELD_PATTERN.find(raw)?.let { match ->
        val inner = match.groupValues[1]
        aliases = ALIAS_ITEM_PATTERN.findAll(inner)
            .mapNotNull { it.groupValues.getOrNull(1) }
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
            .toList()
    }

    if (definition.isEmpty() && aliases.isEmpty()) return null
    return AIDefinitionResult(definition = definition, aliases = aliases)
}

private fun unescape(value: String): String = value
    .replace("\\n", "\n")
    .replace("\\\"", "\"")
    .replace("\\\\", "\\")

/** 递归深合并：两边都是对象才下钻，否则后者覆盖（对齐 iOS `deepMerge`） */
private fun deepMerge(base: JsonObject, extra: JsonObject): JsonObject {
    val output = base.toMutableMap()
    for ((key, value) in extra) {
        val existing = output[key]
        output[key] = if (value is JsonObject && existing is JsonObject) {
            deepMerge(existing, value)
        } else {
            value
        }
    }
    return JsonObject(output)
}

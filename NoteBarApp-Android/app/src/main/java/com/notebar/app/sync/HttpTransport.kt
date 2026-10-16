package com.notebar.app.sync

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * HTTP 传输端口：把「怎么发请求」与「请求什么」拆开，单测据此注入假实现，**永不触网**。
 *
 * 为什么要有这一层（Android 特有）：桌面端直接注入 `fetchImpl`；Android 若在客户端里
 * 硬编码 `HttpURLConnection`，单测就只能靠 MockWebServer 之类的额外依赖或真的联网。
 * 任务红线是「不新增依赖」，因此这里只声明一个接口，真实实现用 JDK 内置的
 * [HttpURLConnection]（见 [HttpUrlConnectionTransport]），单测用内存假实现。
 *
 * 语义与 `fetch` 对齐：**传输层失败抛 [IOException]，HTTP 错误码不抛**——
 * 错误码是业务信息（errno/5xx 退避都由上层决定），不能在这里被吞成异常。
 */
interface HttpTransport {
    /** 同步执行一次请求；网络层失败（连不上/超时/IO 错）抛 [IOException] */
    fun execute(request: HttpRequest): HttpResponse
}

/** 一次 HTTP 请求。[body] 为 null 表示无请求体（GET） */
data class HttpRequest(
    val url: String,
    val method: String = "GET",
    val headers: Map<String, String> = emptyMap(),
    val body: HttpBody? = null,
)

/** 请求体：表单（`application/x-www-form-urlencoded`）或 multipart 单文件 */
sealed interface HttpBody {

    /** 对应桌面端 `new URLSearchParams(body).toString()` */
    data class Form(val fields: Map<String, String>) : HttpBody

    /**
     * 对应桌面端 `FormData + Blob`。
     * Content-Type 必须由传输层按 [boundary] 生成，调用方不得手工设置（与 `fetch` 一致）。
     */
    data class Multipart(
        val fieldName: String,
        val fileName: String,
        val bytes: ByteArray,
    ) : HttpBody
}

/** 一次 HTTP 响应；[body] 为原始字节（调用方按需当文本/文件处理） */
data class HttpResponse(
    val status: Int,
    val body: ByteArray,
    val contentType: String?,
) {
    /** 对应 `fetch` 的 `response.ok` */
    val isSuccessful: Boolean get() = status in 200..299

    /** 按 UTF-8 解码响应体 */
    fun text(): String = String(body, StandardCharsets.UTF_8)

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is HttpResponse) return false
        return status == other.status &&
            contentType == other.contentType &&
            body.contentEquals(other.body)
    }

    override fun hashCode(): Int {
        var result = status
        result = 31 * result + body.contentHashCode()
        result = 31 * result + (contentType?.hashCode() ?: 0)
        return result
    }
}

/**
 * [HttpTransport] 的默认实现：JDK 内置 `java.net.HttpURLConnection`，**不新增任何依赖**
 * （Android 平台自带；也不需要用 OkHttp）。
 *
 * 超时全部显式设置：移动网络下「无超时的连接」会把同步线程永久挂住，
 * 而对显式关闭了 `setDoInput` 之类默认值的实现，连错误都看不到。
 */
class HttpUrlConnectionTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 60_000,
) : HttpTransport {

    override fun execute(request: HttpRequest): HttpResponse {
        val connection = (URL(request.url).openConnection() as HttpURLConnection).apply {
            requestMethod = request.method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            // 默认跟随跳转（dlink 会 302 到实际存储节点），但只跟随同协议的安全跳转
            instanceFollowRedirects = true
            for ((name, value) in request.headers) setRequestProperty(name, value)
        }

        try {
            when (val body = request.body) {
                null -> Unit
                is HttpBody.Form -> {
                    val encoded = panEncodeForm(body.fields).toByteArray(StandardCharsets.UTF_8)
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", FORM_CONTENT_TYPE)
                    connection.outputStream.use { it.write(encoded) }
                }
                is HttpBody.Multipart -> {
                    val boundary = "----NoteBarBoundary${System.nanoTime()}"
                    connection.doOutput = true
                    connection.setRequestProperty(
                        "Content-Type",
                        "multipart/form-data; boundary=$boundary",
                    )
                    connection.outputStream.use { it.write(encodeMultipart(body, boundary)) }
                }
            }

            val status = connection.responseCode
            // 4xx/5xx 时 getInputStream 会抛，错误体必须从 errorStream 读（否则丢掉 errno）
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val bytes = stream?.use { readAll(it) } ?: ByteArray(0)
            return HttpResponse(
                status = status,
                body = bytes,
                contentType = connection.getHeaderField("Content-Type"),
            )
        } catch (error: IOException) {
            throw error
        } finally {
            connection.disconnect()
        }
    }

    private fun readAll(stream: java.io.InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val read = stream.read(buffer)
            if (read <= 0) break
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    /** 与 `URLSearchParams({...}).toString()` 一致的编码（空格编码为 `+`） */
    private fun encodeMultipart(body: HttpBody.Multipart, boundary: String): ByteArray {
        val out = ByteArrayOutputStream()
        fun writeLine(text: String) = out.write(text.toByteArray(StandardCharsets.UTF_8))

        writeLine("--$boundary\r\n")
        writeLine(
            "Content-Disposition: form-data; name=\"${body.fieldName}\"; filename=\"${body.fileName}\"\r\n",
        )
        writeLine("Content-Type: application/octet-stream\r\n\r\n")
        out.write(body.bytes)
        writeLine("\r\n--$boundary--\r\n")
        return out.toByteArray()
    }

    companion object {
        /** 与 `URLSearchParams` 一致：application/x-www-form-urlencoded */
        const val FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8"
    }
}

/**
 * 与 JS `URLSearchParams` 一致的百分号编码（空格 → `+`，`/` → `%2F`，`.` 不编码）。
 *
 * 桌面端所有 query 都由 `URLSearchParams` 生成，这里保持同一编码口径，
 * 便于逐字对照两端的实际请求（例如路径批量查询的 `target=%5B%22%2Fapps%2F…%22%5D`）。
 */
internal fun panUrlEncode(value: String): String = URLEncoder.encode(value, "UTF-8")

/** 按插入顺序拼出 query 串（不排序，与 `URLSearchParams` 一致） */
internal fun panEncodeQuery(params: List<Pair<String, String>>): String =
    params.joinToString("&") { (key, value) -> "${panUrlEncode(key)}=${panUrlEncode(value)}" }

/** 与 `URLSearchParams(body).toString()` 等价的表单体 */
internal fun panEncodeForm(fields: Map<String, String>): String =
    panEncodeQuery(fields.entries.map { it.key to it.value })

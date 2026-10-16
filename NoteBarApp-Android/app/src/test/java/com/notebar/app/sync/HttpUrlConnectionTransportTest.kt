package com.notebar.app.sync

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedInputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * [HttpUrlConnectionTransport] 的真实 HTTP 往返测试。
 *
 * 为什么需要它：[BaiduPanClientTest] / [BaiduPanFileStoreTest] 都注入假传输，
 * 因此**生产用的传输层一次都没被跑过**——而它恰恰是最容易悄悄写错的一层
 * （表单编码、multipart boundary、错误体读取）。这里用 `java.net.ServerSocket`
 * 起一个**只监听回环地址**的最小 HTTP/1.1 服务端：不新增依赖（ServerSocket 是 JDK/Android
 * 内置）、不访问外网，但走的是真实 `HttpURLConnection` + 真实 socket 的代码路径。
 *
 * 不用 `com.sun.net.httpserver`：它在 Android 的编译类路径上不存在（JDK 私有模块），
 * 用了会让 `:app:testDebugUnitTest` 编不过。
 */
class HttpUrlConnectionTransportTest {

    private val servers = ArrayList<ServerSocket>()

    @After
    fun tearDown() {
        for (socket in servers) runCatching { socket.close() }
        servers.clear()
    }

    /** 一次已解析的请求 */
    private data class ReceivedRequest(
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val headers: Map<String, String>,
        val body: ByteArray,
    ) {
        val bodyText: String get() = String(body, StandardCharsets.ISO_8859_1)
    }

    /**
     * 起一个最小 HTTP/1.1 服务端，返回 `baseUrl` 与「收到的请求」列表。
     * [respond] 依据请求给出 (状态码, 响应体, Content-Type)。
     */
    private fun startServer(
        respond: (ReceivedRequest) -> Triple<Int, String, String>,
    ): Pair<String, List<ReceivedRequest>> {
        val received = CopyOnWriteArrayList<ReceivedRequest>()
        val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        servers.add(server)
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (_: Exception) {
                    return@thread
                }
                thread(isDaemon = true) { runCatching { handle(socket, received, respond) } }
            }
        }
        return "http://127.0.0.1:${server.localPort}" to received
    }

    private fun handle(
        socket: Socket,
        received: MutableList<ReceivedRequest>,
        respond: (ReceivedRequest) -> Triple<Int, String, String>,
    ) {
        socket.use { client ->
            val input = BufferedInputStream(client.getInputStream())
            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(' ')
            val method = parts.getOrElse(0) { "GET" }
            val rawTarget = parts.getOrElse(1) { "/" }

            val headers = LinkedHashMap<String, String>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val i = line.indexOf(':')
                if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
            }

            val body = readBody(input, headers)
            val (path, queryRaw) = rawTarget.split('?', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            val request = ReceivedRequest(
                method = method,
                path = path,
                query = MemoryPanTransport.parseQuery(queryRaw),
                headers = headers,
                body = body,
            )
            received.add(request)

            val (status, responseText, contentType) = respond(request)
            val bytes = responseText.toByteArray(StandardCharsets.UTF_8)
            val reason = when (status) {
                200 -> "OK"
                403 -> "Forbidden"
                404 -> "Not Found"
                503 -> "Service Unavailable"
                else -> "Status"
            }
            val head = buildString {
                append("HTTP/1.1 $status $reason\r\n")
                append("Content-Type: $contentType\r\n")
                append("Content-Length: ${bytes.size}\r\n")
                append("Connection: close\r\n\r\n")
            }
            client.getOutputStream().apply {
                write(head.toByteArray(StandardCharsets.ISO_8859_1))
                write(bytes)
                flush()
            }
        }
    }

    private fun readLine(input: InputStream): String? {
        val out = java.io.ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (out.size() == 0) null else out.toString("ISO-8859-1")
            if (b == '\n'.code) return out.toString("ISO-8859-1").trimEnd('\r')
            out.write(b)
        }
    }

    private fun readBody(input: InputStream, headers: Map<String, String>): ByteArray {
        val length = headers["content-length"]?.toIntOrNull() ?: return ByteArray(0)
        if (length <= 0) return ByteArray(0)
        val buffer = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(buffer, read, length - read)
            if (n < 0) break
            read += n
        }
        return if (read == length) buffer else buffer.copyOf(read)
    }

    /** 生产传输层（与 [panClient] 用的是同一份配置） */
    private val transport = HttpUrlConnectionTransport(connectTimeoutMs = 5_000, readTimeoutMs = 5_000)

    private fun panClient(base: String) = BaiduPanClient(
        initialConfig = BaiduPanSettings(
            enabled = true,
            appKey = "fake-app-key",
            secretKey = "fake-secret-key",
            accessToken = "fake-access-token-1",
            refreshToken = "fake-refresh-token-1",
            expiresAt = Long.MAX_VALUE,
        ),
        transport = transport,
        nowMs = { 1_763_000_000_000L },
        sleep = { },
        oauthBaseUrl = "$base/oauth/2.0/token",
        fileApiBaseUrl = "$base/rest/2.0/xpan/file",
        quotaBaseUrl = "$base/api/quota",
        uploadBaseUrl = "$base/rest/2.0/pcs/file",
    )

    // ------------------------------------------------------------ 传输层本身

    @Test
    fun getRequestSendsHeadersAndDecodesResponseBody() {
        val (base, received) = startServer { Triple(200, """{"errno":0}""", "application/json") }

        val response = transport.execute(
            HttpRequest(
                url = "$base/rest/2.0/xpan/file?method=list",
                headers = mapOf("User-Agent" to "pan.baidu.com"),
            ),
        )

        assertEquals(200, response.status)
        assertTrue(response.isSuccessful)
        assertEquals("""{"errno":0}""", response.text())
        assertTrue("应带 Content-Type", response.contentType?.contains("application/json") == true)
        assertEquals(1, received.size)
        assertEquals("GET", received[0].method)
        assertEquals("/rest/2.0/xpan/file", received[0].path)
        assertEquals("list", received[0].query["method"])
        assertEquals("pan.baidu.com", received[0].headers["user-agent"])
    }

    @Test
    fun queryParametersArrivePercentDecodedWithChineseAndSpaces() {
        val (base, received) = startServer { Triple(200, "{}", "application/json") }
        // 中文目录名与空格都要原样到达（URLSearchParams 口径：空格 → `+`）
        val dir = "/apps/NoteBar/Words/英语 词库"

        transport.execute(HttpRequest(url = "$base/x?${panEncodeQuery(listOf("dir" to dir))}"))

        assertEquals("中文字符串必须能真实往返", dir, received[0].query["dir"])
    }

    @Test
    fun formBodyIsUrlEncodedLikeUrlSearchParams() {
        val (base, received) = startServer { Triple(200, "{}", "application/json") }
        val target = """["/apps/NoteBar/Words/AI Agent.canvas"]"""
        val formFields: Map<String, String> = linkedMapOf("target" to target, "dlink" to "1")

        transport.execute(
            HttpRequest(
                url = "$base/rest/2.0/xpan/file?method=filemetas",
                method = "POST",
                headers = mapOf("Content-Type" to "application/x-www-form-urlencoded"),
                body = HttpBody.Form(formFields),
            ),
        )

        val sent = received[0].bodyText
        // 服务端按同一口径解码后必须拿回原值
        assertEquals(target, MemoryPanTransport.parseQuery(sent)["target"])
        assertEquals("1", MemoryPanTransport.parseQuery(sent)["dlink"])
        // 未编码的 `/` 不应出现在表单体里
        assertTrue("表单体未做百分号编码：$sent", sent.contains("%2F"))
        // URLSearchParams 把空格编码为 `+`（与桌面端逐字一致）
        assertTrue("空格应按 URLSearchParams 编码成 +：$sent", sent.contains("AI+Agent.canvas"))
    }

    @Test
    fun multipartBodyCarriesBoundaryFieldNameFileNameAndBytes() {
        val (base, received) = startServer { Triple(200, "{}", "application/json") }
        val payload = """{"nodes":[]}"""

        transport.execute(
            HttpRequest(
                url = "$base/rest/2.0/pcs/file?method=upload",
                method = "POST",
                headers = mapOf("User-Agent" to "pan.baidu.com"),
                body = HttpBody.Multipart(
                    fieldName = "file",
                    fileName = "AI.canvas",
                    bytes = payload.toByteArray(StandardCharsets.UTF_8),
                ),
            ),
        )

        val request = received[0]
        val contentType = request.headers["content-type"] ?: ""
        assertTrue("应是 multipart：$contentType", contentType.startsWith("multipart/form-data; boundary="))
        val boundary = contentType.substringAfter("boundary=").trim()
        val body = request.bodyText
        assertTrue("body 开始边界缺失", body.startsWith("--$boundary\r\n"))
        assertTrue("body 结束边界缺失", body.endsWith("\r\n--$boundary--\r\n"))
        assertTrue("字段名缺失", body.contains("""name="file""""))
        assertTrue("文件名缺失", body.contains("""filename="AI.canvas""""))
        assertTrue("文件内容缺失", body.contains(payload))
    }

    @Test
    fun errorBodyIsReadFromErrorStreamInsteadOfThrowing() {
        // 4xx/5xx 时 getInputStream 会抛 IOException；若不改读 errorStream，
        // 就会丢掉服务端给的 errno，用户只能看到「读取响应失败」这种没用的报错。
        val (base, _) = startServer { Triple(403, """{"errno":31326,"errmsg":"anti-leech"}""", "application/json") }

        val response = transport.execute(HttpRequest(url = "$base/rest/2.0/xpan/file?method=list"))

        assertEquals(403, response.status)
        assertTrue("4xx 不应视为成功", !response.isSuccessful)
        assertTrue(
            "错误体必须可读（否则 errno 丢失）：${response.text()}",
            response.text().contains("31326"),
        )
    }

    @Test
    fun http500BodyIsAlsoReadable() {
        val (base, _) = startServer { Triple(503, """{"errno":20012,"errmsg":"rate limited"}""", "application/json") }
        val response = transport.execute(HttpRequest(url = "$base/rest/2.0/xpan/file?method=list"))
        assertEquals(503, response.status)
        assertTrue(response.text().contains("20012"))
    }

    @Test
    fun getRequestWithoutBodyOmitsContentType() {
        val (base, received) = startServer { Triple(200, "{}", "application/json") }
        transport.execute(HttpRequest(url = "$base/whatever"))
        assertTrue(
            "GET 不应带 Content-Type：${received[0].headers["content-type"]}",
            received[0].headers["content-type"].isNullOrEmpty(),
        )
    }

    // ------------------------------------------------- 客户端 + 真实传输（端到端）

    @Test
    fun listDirEndToEndThroughRealSocket() {
        // 假传输层能证明「我们发出了什么」，但证明不了「那个请求在真网络上成立」——
        // 编码、路径、方法任一处写错，只有走真实 socket 才会暴露。
        val (base, received) = startServer { request ->
            when {
                request.path != "/rest/2.0/xpan/file" -> Triple(404, """{"errno":-7}""", "application/json")
                request.query["method"] == "list" -> Triple(
                    200,
                    """{"errno":0,"list":[
                        {"fs_id":1,"path":"/apps/NoteBar/Words/AI.canvas","server_filename":"AI.canvas",
                         "isdir":0,"size":12,"server_mtime":1691048400}
                    ]}""",
                    "application/json",
                )
                request.query["method"] == "create" -> Triple(200, """{"errno":0,"fs_id":2}""", "application/json")
                else -> Triple(200, """{"errno":0}""", "application/json")
            }
        }

        val client = panClient(base)
        val entries = client.listDir(client.wordsDir)

        assertEquals(1, entries.size)
        assertEquals("AI.canvas", entries[0].name)
        assertEquals(12L, entries[0].size)
        assertEquals(1691048400000L, entries[0].serverMtimeMs)
        // 真实请求确实到达了服务端，且带上了两个必备要素
        assertEquals("/apps/NoteBar/Words", received[0].query["dir"])
        assertEquals("fake-access-token-1", received[0].query["access_token"])
        assertEquals("pan.baidu.com", received[0].headers["user-agent"])

        // 中文目录名（create 走表单体）也要能真实往返
        client.createFolder("/apps/NoteBar/Words/英语词库")
        assertEquals("/apps/NoteBar/Words/英语词库", received[1].bodyText.let { MemoryPanTransport.parseQuery(it)["path"] })
    }

    @Test
    fun uploadEndToEndThroughRealSocketKeepsBytesIntact() {
        val uploaded = arrayOfNulls<ByteArray>(1)
        var uploadedName: String? = null
        val (base, _) = startServer { request ->
            if (request.query["method"] == "upload") {
                val text = request.bodyText
                uploadedName = Regex("""filename="([^"]+)"""").find(text)?.groupValues?.get(1)
                val start = text.indexOf("\r\n\r\n") + 4
                val end = text.lastIndexOf("\r\n--")
                uploaded[0] = text.substring(start, end).toByteArray(StandardCharsets.ISO_8859_1)
            }
            Triple(200, """{"errno":0,"path":"/apps/NoteBar/Words/AI.canvas","fs_id":9}""", "application/json")
        }

        val payload = """{"nodes":[{"id":"n1","text":"苹果"}]}"""
        val entry = panClient(base).uploadFile(
            "/apps/NoteBar/Words/AI.canvas",
            payload.toByteArray(StandardCharsets.UTF_8),
        )

        assertEquals("AI.canvas", uploadedName)
        // 字节级一致：UTF-8 中文不能在上传链路上被二次编码
        assertEquals("服务端收到的字节应与上传内容一致", payload, String(uploaded[0]!!, StandardCharsets.UTF_8))
        assertEquals(9L, entry.fsId)
    }

    @Test
    fun downloadEndToEndThroughRealSocket() {
        // 下载是两步：filemetas 取 dlink → GET dlink。dlink 指向同一台本地服务端。
        val payload = """{"nodes":[]}"""
        var base = ""
        val started = startServer { request ->
            when {
                request.path == "/rest/2.0/xpan/file" && request.query["method"] == "filemetas" -> Triple(
                    200,
                    """{"errno":0,"info":[{"errno":0,"fs_id":1,
                        "path":"/apps/NoteBar/Words/AI.canvas","server_filename":"AI.canvas","size":12,
                        "dlink":"$base/fake/file?path=x"}]}""",
                    "application/json",
                )
                request.path == "/fake/file" -> Triple(200, payload, "application/octet-stream")
                else -> Triple(404, """{"errno":-7}""", "application/json")
            }
        }
        base = started.first

        val client = panClient(base)
        val bytes = client.downloadFile("/apps/NoteBar/Words/AI.canvas")

        assertEquals(payload, String(bytes, StandardCharsets.UTF_8))
    }

    @Test
    fun downloadSurfacesJsonErrorBodyFromDlink() {
        // dlink 失效时服务端回 JSON 而不是文件；客户端必须报可读错误而不是把 JSON 当文件写盘
        var base = ""
        val started = startServer { request ->
            when {
                request.path == "/rest/2.0/xpan/file" -> Triple(
                    200,
                    """{"errno":0,"info":[{"errno":0,"path":"/apps/NoteBar/Words/x.canvas",
                        "dlink":"$base/fake/expired"}]}""",
                    "application/json",
                )
                else -> Triple(200, """{"errno":31360,"show_msg":"expired"}""", "application/json")
            }
        }
        base = started.first

        val error = runCatching { panClient(base).downloadFile("/apps/NoteBar/Words/x.canvas") }
            .exceptionOrNull()

        assertTrue("期望 BaiduPanError，实际 $error", error is BaiduPanError)
        assertTrue("应给出可读原因：${error!!.message}", error.message!!.contains("下载链接已过期"))
    }

    @Test
    fun oauthEndToEndThroughRealSocket() {
        val (base, received) = startServer {
            Triple(
                200,
                """{"access_token":"fresh","refresh_token":"rotated","expires_in":2592000}""",
                "application/json",
            )
        }

        val tokens = panClient(base).exchangeAuthorizationCode("fake-code")

        assertEquals("fresh", tokens.accessToken)
        assertEquals("rotated", tokens.refreshToken)
        // client_secret 必须到达服务端（且只出现在 query 里）
        assertEquals("fake-secret-key", received[0].query["client_secret"])
        assertEquals("authorization_code", received[0].query["grant_type"])
    }

    @Test
    fun connectionRefusedBecomesReadableNetworkError() {
        // 指向一个刚关闭的端口：必须变成可读的 BaiduPanError(network)，
        // 而不是把 IOException 直接抛给同步层（engine 只认 null/false）。
        val socket = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val deadPort = socket.localPort
        socket.close()

        val client = panClient("http://127.0.0.1:$deadPort")
        val error = runCatching { client.listDir("/apps/NoteBar/Words") }.exceptionOrNull()

        assertTrue("期望 BaiduPanError，实际 $error", error is BaiduPanError)
        assertEquals(BaiduPanErrorKind.NETWORK, (error as BaiduPanError).kind)
    }
}

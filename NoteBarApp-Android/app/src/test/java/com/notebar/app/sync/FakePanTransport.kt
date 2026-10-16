package com.notebar.app.sync

import java.io.IOException

/**
 * 单测用的假 HTTP 传输层：**永不触网**。
 *
 * 两种用法：
 * - [ScriptedTransport]：按脚本顺序返回响应并记录每次请求，用于断言「请求怎么构造的」
 *   （对应桌面端 `tests/sync/baidu-pan-client.test.ts` 的 `createFetchMock`）；
 * - [MemoryPanTransport]：一个够真的内存版百度网盘（OAuth / list / filemetas / upload /
 *   create / filemanager / quota，含 errno 与防盗链校验），用于验证 [BaiduPanFileStore]
 *   与 engine 端口语义的配合。它能发现「字段拼错、路径算错、编码写错」这类
 *   纯脚本假实现测不出来的问题——脚本假实现只会把调用方的错照单全收。
 */
internal class ScriptedTransport(
    private val responses: List<ScriptedResponse>,
) : HttpTransport {

    val requests = ArrayList<HttpRequest>()
    private var index = 0

    /** 传输层失败注入：非 null 时每次调用都抛它（模拟断网/超时） */
    var failure: IOException? = null

    override fun execute(request: HttpRequest): HttpResponse {
        requests.add(request)
        failure?.let { throw it }
        val scripted = responses[minOf(index, responses.lastIndex.coerceAtLeast(0))]
        index++
        return scripted.toResponse()
    }

    /** 第 n 次请求（0 起）；用于逐条断言请求构造 */
    fun request(index: Int): HttpRequest = requests[index]

    companion object {
        fun json(body: String, status: Int = 200): ScriptedResponse =
            ScriptedResponse(status, body.toByteArray(Charsets.UTF_8), "application/json")

        fun bytes(body: ByteArray, contentType: String = "application/octet-stream"): ScriptedResponse =
            ScriptedResponse(200, body, contentType)
    }
}

internal data class ScriptedResponse(
    val status: Int,
    val body: ByteArray,
    val contentType: String?,
) {
    fun toResponse(): HttpResponse = HttpResponse(status, body, contentType)
}

/**
 * 内存版百度网盘服务端：实现真实接口的**关键语义**，供 [BaiduPanFileStore] 的集成式单测使用。
 *
 * 刻意复刻的语义（都是能在真实服务端上踩到坑的地方）：
 * - 所有接口都要求 `User-Agent: pan.baidu.com`，否则 errno 31326（防盗链）；
 * - `access_token` 必须有效，否则 errno -6；
 * - `/apps/` 之外的路径一律 errno -7（越界写入被拒）；
 * - 不存在的文件：list 返回 errno -9；filemetas 的 info 项带 `errno: -9`；
 * - upload 的 `ondup=overwrite` 覆盖已有文件，`ondup=fail` 已存在则 errno -8；
 * - `method=create` 对已存在目录返回 errno -8；
 * - 配额耗尽时返回 errno 20012（频率/配额超限）。
 */
internal open class MemoryPanTransport(
    private val sandboxRoot: String = "/apps/NoteBar",
    private val validToken: String = "fake-access-token-1",
) : HttpTransport {

    /** 路径 → 内容（目录用 [dirs]） */
    val files = LinkedHashMap<String, ByteArray>()
    val dirs = LinkedHashSet<String>()

    /** 期望的 User-Agent；null 表示不校验（用于验证「不带 UA → 31326」的反例） */
    var requiredUserAgent: String? = BaiduPanClient.PAN_USER_AGENT

    /** 非 0 时所有接口都返回该 errno（模拟配额/频控耗尽） */
    var forcedErrno: Long = 0

    var requestCount = 0
        private set

    /** 最近一次请求的 URL（诊断用） */
    var lastUrl: String = ""
        private set

    fun seedFile(path: String, text: String) {
        files[path] = text.toByteArray(Charsets.UTF_8)
        // 文件存在意味着其父目录链存在（真实网盘的不变式，也让 list 能枚举到它）
        parentDirsOf(path).forEach { dirs.add(it) }
        if (path.startsWith("$sandboxRoot/")) dirs.add(sandboxRoot)
    }

    fun textOf(path: String): String? = files[path]?.toString(Charsets.UTF_8)

    override fun execute(request: HttpRequest): HttpResponse {
        requestCount++
        lastUrl = request.url

        val url = java.net.URI(request.url)
        val query = parseQuery(url.rawQuery)
        val path = url.path

        requiredUserAgent?.let { expected ->
            if (request.headers["User-Agent"] != expected) return errno(31326)
        }

        // OAuth 端点不走 access_token 校验
        if (url.host == "openapi.baidu.com") return handleOAuth(query)

        val token = query["access_token"]
        if (token != validToken) return errno(-6)

        if (forcedErrno != 0L) return errno(forcedErrno)

        // dlink 下载：真实服务端返回文件字节；Content-Type 决定客户端是否当 JSON 错误体处理
        // （注意只拦 dlink 的下载路径，上传也是发到 d.pcs.baidu.com 的 /rest/2.0/pcs/file）
        if (url.host == "d.pcs.baidu.com" && path == DLINK_PATH) return handleDlink(query["path"].orEmpty())

        return when {
            path == "/api/quota" -> json("""{"errno":0,"total":100,"used":40,"free":60}""")
            path == "/rest/2.0/xpan/file" -> handleFileApi(query, request)
            path == "/rest/2.0/pcs/file" -> handleUpload(query, request)
            else -> errno(-7)
        }
    }

    /** dlink 下载：文件不存在时按真实服务端那样回 JSON 错误体（客户端据此判 31360 类错误） */
    private fun handleDlink(target: String): HttpResponse {
        val bytes = files[target] ?: return errno(31360)
        return HttpResponse(200, bytes, "application/octet-stream")
    }

    private fun handleOAuth(query: Map<String, String>): HttpResponse {
        return when (query["grant_type"]) {
            "authorization_code" -> json(
                """{"access_token":"$validToken","refresh_token":"rotated-refresh",
                   "expires_in":2592000,"scope":"basic netdisk"}""",
            )
            "refresh_token" -> json(
                """{"access_token":"$validToken","refresh_token":"rotated-refresh","expires_in":2592000}""",
            )
            else -> json("""{"error":"unsupported_grant_type"}""")
        }
    }

    private fun handleFileApi(query: Map<String, String>, request: HttpRequest): HttpResponse {
        val rawBody = request.body?.let { bodyText(it) }.orEmpty()
        val body = parseQuery(rawBody)
        return when (query["method"]) {
            "list" -> handleList(query["dir"].orEmpty())
            "filemetas" -> handleFileMetas(body["target"].orEmpty(), body["dlink"] == "1")
            "create" -> handleCreate(body["path"].orEmpty())
            "filemanager" -> handleFileManager(query["opera"], body["filelist"].orEmpty())
            else -> errno(31023)
        }
    }

    private fun handleList(dir: String): HttpResponse {
        if (!isInsideSandbox(dir)) return errno(-7)
        if (dir !in dirs) return errno(-9)
        val prefix = if (dir == "/") "/" else "$dir/"
        val list = ArrayList<String>()
        for (d in dirs) {
            if (d != dir && d.startsWith(prefix) && !d.removePrefix(prefix).contains('/')) {
                list.add(dirEntry(d))
            }
        }
        for ((filePath, bytes) in files) {
            if (filePath.startsWith(prefix) && !filePath.removePrefix(prefix).contains('/')) {
                list.add(fileEntry(filePath, bytes.size))
            }
        }
        return json("""{"errno":0,"list":[${list.joinToString(",")}]}""")
    }

    private fun handleFileMetas(targetRaw: String, withDlink: Boolean): HttpResponse {
        val targets = parseJsonStringArray(targetRaw) ?: return errno(31023)
        val info = targets.map { target ->
            when {
                !isInsideSandbox(target) -> """{"errno":-7}"""
                target in dirs -> """{"errno":0,"path":"$target",""" +
                    """"server_filename":"${target.substringAfterLast('/')}","isdir":1,"server_mtime":1691048365}"""
                files.containsKey(target) -> {
                    val size = files.getValue(target).size
                    val dlink = if (withDlink) {
                        ""","dlink":"https://d.pcs.baidu.com$DLINK_PATH?path=${panUrlEncode(target)}""""
                    } else {
                        ""
                    }
                    """{"errno":0,"path":"$target",""" +
                        """"server_filename":"${target.substringAfterLast('/')}","isdir":0,""" +
                        """"size":$size,"server_mtime":1691048400$dlink}"""
                }
                else -> """{"errno":-9}"""
            }
        }
        return json("""{"errno":0,"info":[${info.joinToString(",")}]}""")
    }

    private fun handleCreate(path: String): HttpResponse {
        if (!isInsideSandbox(path)) return errno(-7)
        // 沙箱根由平台自动生成，应用不能创建（真实服务端返回 -8/-7）
        if (path == sandboxRoot || path == "/apps") return errno(-8)
        if (path in dirs) return errno(-8)
        dirs.add(path)
        return json("""{"errno":0,"fs_id":1}""")
    }

    private fun handleFileManager(opera: String?, filelistRaw: String): HttpResponse {
        if (opera != "delete") return errno(31023)
        val list = parseJsonStringArray(filelistRaw) ?: return errno(31023)
        for (target in list) {
            if (!isInsideSandbox(target)) return errno(-7)
            files.remove(target)
        }
        return json("""{"errno":0}""")
    }

    private fun handleUpload(query: Map<String, String>, request: HttpRequest): HttpResponse {
        val target = query["path"].orEmpty()
        if (!isInsideSandbox(target)) return errno(-7)
        val multipart = request.body as? HttpBody.Multipart ?: return errno(31023)
        if (files.containsKey(target) && query["ondup"] == "fail") return errno(-8)
        files[target] = multipart.bytes
        // 父目录不存在时真实服务端会建出来（简化：一并登记）
        parentDirsOf(target).forEach { dirs.add(it) }
        return json("""{"errno":0,"path":"$target","fs_id":7,"size":${multipart.bytes.size}}""")
    }

    private fun isInsideSandbox(path: String): Boolean =
        path == sandboxRoot || path.startsWith("$sandboxRoot/")

    private fun parentDirsOf(path: String): List<String> {
        val out = ArrayList<String>()
        var current = path.substringBeforeLast('/', "")
        while (current.isNotEmpty() && current != sandboxRoot && current.startsWith(sandboxRoot)) {
            out.add(current)
            current = current.substringBeforeLast('/', "")
        }
        return out
    }

    private fun dirEntry(path: String): String =
        """{"fs_id":1,"path":"$path","server_filename":"${path.substringAfterLast('/')}",""" +
            """"isdir":1,"server_mtime":1691048365}"""

    private fun fileEntry(path: String, size: Int): String =
        """{"fs_id":2,"path":"$path","server_filename":"${path.substringAfterLast('/')}",""" +
            """"isdir":0,"size":$size,"server_mtime":1691048400,"md5":"abc"}"""

    private fun json(body: String, status: Int = 200): HttpResponse =
        HttpResponse(status, body.toByteArray(Charsets.UTF_8), "application/json")

    private fun errno(code: Long): HttpResponse =
        json("""{"errno":$code,"errmsg":"fake server errno $code"}""")

    private fun bodyText(body: HttpBody): String = when (body) {
        is HttpBody.Form -> panEncodeForm(body.fields)
        is HttpBody.Multipart -> ""
    }

    companion object {
        /** 假 dlink 的路径（与 [handleFileMetas] 生成的 dlink 对应） */
        const val DLINK_PATH = "/fake/file"

        /** 与 `URLSearchParams` 同口径的解析（空格在 query 里以 `%20` 或 `+` 出现） */
        fun parseQuery(raw: String?): Map<String, String> {
            if (raw.isNullOrEmpty()) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (pair in raw.split('&')) {
                if (pair.isEmpty()) continue
                val i = pair.indexOf('=')
                val key = if (i < 0) pair else pair.substring(0, i)
                val value = if (i < 0) "" else pair.substring(i + 1)
                out[urlDecode(key)] = urlDecode(value)
            }
            return out
        }

        private fun urlDecode(value: String): String =
            java.net.URLDecoder.decode(value, "UTF-8")

        fun parseJsonStringArray(raw: String): List<String>? {
            if (raw.isEmpty()) return null
            return runCatching {
                val json = kotlinx.serialization.json.Json.parseToJsonElement(raw)
                (json as kotlinx.serialization.json.JsonArray).map {
                    (it as kotlinx.serialization.json.JsonPrimitive).content
                }
            }.getOrNull()
        }
    }
}

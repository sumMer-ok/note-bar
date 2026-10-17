package com.notebar.app.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.io.IOException

/**
 * 百度网盘开放平台客户端（纯逻辑模块，不 import 任何 Android 类型）。
 *
 * 逐项移植自桌面端 `src/sync/baidu-pan-client.ts`（权威实现）。所有 HTTP 都走注入的
 * [HttpTransport]，单测里永不触网；凭证只出现在请求参数里，绝不写进任何日志/错误信息
 * （见 [BaiduPanClient.sanitizeMessage]）。
 *
 * ## 沙箱约束（必须遵守）
 * 开放平台规定：每个第三方应用在网盘里**只能拥有一个** `/apps/{appname}` 目录，
 * 且产品名称即目录名。因此本客户端在做任何读写之前都会本地校验路径必须落在
 * `/apps/<dir>/` 之下，越界直接抛 [BaiduPanSandboxError]——**绝不静默降级**，
 * 避免把用户数据写到别人目录或误删 `/` 下的文件。
 *
 * ## 已核对的接口（均来自官方文档）
 * - token:    GET  https://openapi.baidu.com/oauth/2.0/token
 * - 列表:     GET  https://pan.baidu.com/rest/2.0/xpan/file?method=list
 * - 元信息:   POST https://pan.baidu.com/rest/2.0/xpan/file?method=filemetas   （target=[path], dlink=1）
 * - 建目录:   POST https://pan.baidu.com/rest/2.0/xpan/file?method=create     （isdir=1）
 * - 管理文件: POST https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager（opera=delete）
 * - 单步上传: POST https://<UPLOAD_HOST>/rest/2.0/pcs/file?method=upload      （multipart/form-data）
 * - 下载:     GET  <dlink>&access_token=<token>，必须带 User-Agent: pan.baidu.com
 * - 容量:     GET  https://pan.baidu.com/api/quota
 * 绝大多数接口都要求 `User-Agent: pan.baidu.com`（否则 errno 31326 命中防盗链）。
 *
 * ## 与桌面端的已知差异
 * 单步上传上限：桌面端按文档写 2GB；Android 侧**主动收紧到 4MB**（任务书要求「≤4MB 用；
 * 超限明确报错」）。理由是 Android 端没有实现分片上传（superfile2），
 * 而词库/边车都是几 KB 级文本——把上限设成 2GB 只会让「真要传大文件」时
 * 走到一个中途失败的路径。超过 [SINGLE_UPLOAD_MAX_BYTES] 一律**在本地明确报错**。
 */
class BaiduPanClient(
    initialConfig: BaiduPanSettings,
    private val transport: HttpTransport = HttpUrlConnectionTransport(),
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    /** 频率限制的退避基数（毫秒）。未过审应用每小时仅 10 次，默认退避 60 秒 */
    private val rateLimitBaseDelayMs: Long = 60_000L,
    /** 频率限制最多重试次数（默认 1 次，避免把配额耗光） */
    private val rateLimitMaxRetries: Int = 1,
    /** 网络/5xx 抖动重试次数（默认 2 次） */
    private val transientMaxRetries: Int = 2,
    private val transientBaseDelayMs: Long = 500L,
    /** 令牌刷新成功后的回调（调用方负责落盘新的 refresh_token） */
    private val onTokens: ((PanTokens) -> Unit)? = null,
    /** OAuth 端点基址；可注入是为了让「真实 HTTP 往返」测试能指向本地服务端 */
    private val oauthBaseUrl: String = OAUTH_TOKEN_URL,
    /** 文件 REST 基址；同上 */
    private val fileApiBaseUrl: String = PAN_FILE_API,
    /** 配额接口基址；同上 */
    private val quotaBaseUrl: String = PAN_QUOTA_API,
    /** 单步上传域名基址；同上 */
    private val uploadBaseUrl: String = "https://$UPLOAD_LOCATE_HOST/rest/2.0/pcs/file",
) {

    @Volatile
    var config: BaiduPanSettings = initialConfig
        private set

    /** 用最新配置替换（设置面板改完立即生效，无需重建客户端） */
    fun updateConfig(config: BaiduPanSettings) {
        this.config = config
    }

    /** 沙箱根路径：`/apps/<dir>` */
    val sandboxRoot: String get() = config.sandboxRoot

    /** 词库与边车目录：`/apps/<dir>/Words` */
    val wordsDir: String get() = config.wordsDir

    /** 是否已有可用令牌（仅在本地判断，不发请求） */
    fun hasUsableToken(): Boolean =
        config.accessToken.isNotEmpty() && !isTokenExpired()

    /** access_token 是否已过期（30 天有效期，留 5 分钟边界余量，`expiresAt = 0` 视为过期） */
    fun isTokenExpired(now: Long = nowMs()): Boolean {
        if (config.expiresAt <= 0L) return true
        return now + BaiduPanConfig.TOKEN_EXPIRY_SKEW_MS >= config.expiresAt
    }

    // ---------------------------------------------------------------- OAuth

    /**
     * 授权码换 token。
     * GET https://openapi.baidu.com/oauth/2.0/token?grant_type=authorization_code&code=..&client_id=..&client_secret=..&redirect_uri=oob
     */
    fun exchangeAuthorizationCode(code: String, redirectUri: String = "oob"): PanTokens =
        requestTokens(
            listOf(
                "grant_type" to "authorization_code",
                "code" to code,
                "redirect_uri" to redirectUri,
            ),
        )

    /**
     * 用 refresh_token 换新 token。
     *
     * 注意：接口会**返回新的 refresh_token**，必须落盘保存（旧值在部分场景下会失效），
     * 因此这里成功后立刻通过 [onTokens] 通知调用方写回配置。
     */
    fun refreshTokens(): PanTokens {
        if (config.refreshToken.isEmpty()) {
            throw BaiduPanError(
                BaiduPanErrorKind.AUTH,
                "缺少 refresh_token，请重新完成 OAuth 授权",
            )
        }
        return requestTokens(listOf("grant_type" to "refresh_token"))
    }

    /** 令牌快过期或已过期时自动续期；返回是否真的刷新过 */
    fun ensureFreshToken(): Boolean {
        if (!isTokenExpired()) return false
        refreshTokens()
        return true
    }

    private fun requestTokens(params: List<Pair<String, String>>): PanTokens {
        val isRefresh = params.any { it.first == "grant_type" && it.second == "refresh_token" }
        val query = params +
            // 刷新请求必须带上当前 refresh_token（一次性，用后即失效）
            (if (isRefresh) listOf("refresh_token" to config.refreshToken) else emptyList()) +
            listOf("client_id" to config.appKey, "client_secret" to config.secretKey)

        val response = rawFetch(
            HttpRequest(url = "$oauthBaseUrl?${panEncodeQuery(query)}", method = "GET"),
        )
        val data = parseJson(response)

        // OAuth 端点返回的是标准 OAuth 错误体（error/error_description），不是 errno
        val oauthError = data.stringOrNull("error")
        if (oauthError != null) {
            val description = data.stringOrNull("error_description").orEmpty()
            // invalid_grant 在授权码流程里几乎总是「码过期/已被用过」——
            // 只说 "invalid code, expired or revoked" 用户不知道该怎么办（真机实测反馈），
            // 所以这里给出可执行的下一步：重新走一次授权、10 分钟内用掉。
            val hint = if (oauthError == "invalid_client") {
                "AppKey 或 SecretKey 不正确：AppKey 是 32 位字母数字（控制台里 AppID 下方那一行），" +
                    "常见错误是把纯数字的 AppID 当成 AppKey 填了"
            } else if (oauthError == "invalid_grant" && !isRefresh) {
                "授权码无效或已过期。授权码为一次性、有效期 10 分钟，请重新打开授权链接获取新授权码后立即填入"
            } else if (oauthError == "invalid_grant") {
                "刷新令牌已失效（refresh_token 一次性，用过即废），请重新完成 OAuth 授权"
            } else {
                ""
            }
            val detail = if (description.isNotEmpty()) "：$description" else ""
            throw BaiduPanError(
                if (oauthError == "invalid_grant") BaiduPanErrorKind.AUTH else BaiduPanErrorKind.API,
                if (hint.isEmpty()) {
                    "OAuth 失败（$oauthError）$detail"
                } else {
                    "$hint（$oauthError$detail）"
                },
            )
        }
        val accessToken = data.stringOrNull("access_token").orEmpty()
        if (accessToken.isEmpty()) {
            throw BaiduPanError(BaiduPanErrorKind.AUTH, "OAuth 响应缺少 access_token")
        }
        val refreshToken = data.stringOrNull("refresh_token").orEmpty()
        val expiresInSeconds = data.longOrNull("expires_in")
        val expiresAt = if (expiresInSeconds != null && expiresInSeconds > 0) {
            nowMs() + expiresInSeconds * 1000L
        } else {
            nowMs() + BaiduPanConfig.TOKEN_TTL_SECONDS * 1000L
        }

        val tokens = PanTokens(
            accessToken = accessToken,
            // 刷新响应也会带新 refresh_token；缺失时保留旧值，避免把可用凭证清空
            refreshToken = refreshToken.ifEmpty { config.refreshToken },
            expiresAt = expiresAt,
        )
        config = config.copy(
            accessToken = tokens.accessToken,
            refreshToken = tokens.refreshToken,
            expiresAt = tokens.expiresAt,
        )
        onTokens?.invoke(tokens)
        return tokens
    }

    // ------------------------------------------------------------- 文件接口

    /**
     * 列出目录。
     * GET https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=..&order=time&desc=1&start&limit
     */
    fun listDir(dir: String, start: Int = 0, limit: Int = 1000): List<PanFileEntry> {
        val target = assertInsideSandbox(sandboxRoot, dir)
        val effectiveLimit = limit.coerceIn(1, 1000)
        val data = callApi(
            method = "GET",
            baseUrl = fileApiBaseUrl,
            query = listOf(
                "method" to "list",
                "dir" to target,
                "order" to "time",
                "desc" to "1",
                "start" to maxOf(0, start).toString(),
                "limit" to effectiveLimit.toString(),
                "folder" to "0",
            ),
        )
        val list = data["list"] as? JsonArray ?: return emptyList()
        return list.mapNotNull { (it as? JsonObject)?.let(::toEntry) }
    }

    /**
     * 查询文件元信息（可带 dlink）。
     *
     * 用 `method=filemetas` 的**路径批量**形态（`target=[path]`）而不是 multimedia+fsids：
     * fsids 形态要求先拿到 fs_id，等于多一次往返；我们每次都有路径，一次请求即可。
     *
     * 返回列表与入参**一一对应**：路径在网盘上不存在时该位置为 null（不是错误）——
     * 与桌面端 provider 的 `fileMetas` 契约一致（`[meta]` 解构后判 null）。
     */
    fun fileMetas(paths: List<String>, dlink: Boolean = false): List<PanFileEntry?> {
        val targets = paths.map { assertInsideSandbox(sandboxRoot, it) }
        val data = callApi(
            method = "POST",
            baseUrl = fileApiBaseUrl,
            query = listOf("method" to "filemetas"),
            body = linkedMapOf(
                "target" to JsonArray(targets.map { JsonPrimitive(it) }).toString(),
                "dlink" to if (dlink) "1" else "0",
            ),
            tolerateErrnos = FILE_NOT_FOUND_ERRNOS,
        )
        val info = data["info"] as? JsonArray ?: return targets.map { null }
        return targets.mapIndexed { index, path ->
            val item = info.getOrNull(index) as? JsonObject ?: return@mapIndexed null
            // 单文件级错误码（典型 -9/-3/31066 文件不存在）：按「不存在」处理，不作为失败上报
            val itemErrno = item.longOrNull("errno")
            if (itemErrno != null && itemErrno != 0L) return@mapIndexed null
            if (item.stringOrNull("path").isNullOrEmpty() && item["server_filename"] == null) {
                return@mapIndexed null
            }
            toEntry(item, fallbackPath = path)
        }
    }

    /** 查询单个文件元信息；不存在返回 null */
    fun fileMeta(path: String, dlink: Boolean = false): PanFileEntry? =
        fileMetas(listOf(path), dlink).firstOrNull()

    /**
     * 下载文件字节。
     *
     * 两步（官方「下载」文档）：先拿 dlink，再 `GET <dlink>&access_token=<token>`，
     * 且 dlink 请求必须带 `User-Agent: pan.baidu.com`（否则 31326 防盗链）。
     */
    fun downloadFile(path: String): ByteArray {
        val meta = fileMeta(path, dlink = true)
            ?: throw BaiduPanError(BaiduPanErrorKind.API, "文件或目录不存在：$path")
        val dlink = meta.dlink
        if (dlink.isNullOrEmpty()) {
            throw BaiduPanError(BaiduPanErrorKind.API, "未取得下载地址（dlink）：$path")
        }
        val separator = if (dlink.contains("?")) "&" else "?"
        val url = "$dlink$separator" + panEncodeQuery(listOf("access_token" to config.accessToken))
        val response = rawFetch(HttpRequest(url = url, method = "GET", headers = panHeaders()))
        if (!response.isSuccessful) {
            throw BaiduPanError(BaiduPanErrorKind.NETWORK, "下载失败：HTTP ${response.status}（$path）")
        }
        // dlink 失败时服务端会返回 JSON 而不是文件
        if (response.contentType?.contains("application/json") == true) {
            throw apiErrorFrom(parseJson(response), "下载 $path 失败")
        }
        return response.body
    }

    /**
     * 单步上传（官方上限 2GB，本实现按任务约定收紧到 4MB，见类注释）。
     * POST https://<UPLOAD_HOST>/rest/2.0/pcs/file?method=upload&access_token=..&path=..&ondup=..
     */
    fun uploadFile(
        path: String,
        bytes: ByteArray,
        ondup: String = "overwrite",
    ): PanFileEntry {
        val target = assertInsideSandbox(sandboxRoot, path)
        if (bytes.size > SINGLE_UPLOAD_MAX_BYTES) {
            throw BaiduPanError(
                BaiduPanErrorKind.API,
                "文件超过单步上传上限（${SINGLE_UPLOAD_MAX_BYTES} 字节），未实现分片上传：" +
                    "$target（${bytes.size} 字节）",
            )
        }
        val fileName = target.substringAfterLast('/').ifEmpty { "file" }
        val data = callApi(
            method = "POST",
            baseUrl = uploadBaseUrl,
            query = listOf(
                "method" to "upload",
                "path" to target,
                "ondup" to ondup,
            ),
            // multipart 的 Content-Type 由传输层生成 boundary，切勿手工设置
            multipart = HttpBody.Multipart(fieldName = "file", fileName = fileName, bytes = bytes),
        )
        return toEntry(data, fallbackPath = target)
    }

    /** 便捷：上传 UTF-8 文本（词库/边车都是文本） */
    fun uploadText(path: String, text: String, ondup: String = "overwrite"): PanFileEntry =
        uploadFile(path, text.toByteArray(Charsets.UTF_8), ondup)

    /**
     * 创建文件夹（已存在时视为成功，幂等）。
     * POST https://pan.baidu.com/rest/2.0/xpan/file?method=create&path=..&isdir=1&rtype=0
     */
    fun createFolder(path: String) {
        val target = assertInsideSandbox(sandboxRoot, path)
        try {
            callApi(
                method = "POST",
                baseUrl = fileApiBaseUrl,
                query = listOf("method" to "create"),
                body = linkedMapOf("path" to target, "isdir" to "1", "rtype" to "0"),
            )
        } catch (error: BaiduPanError) {
            // -8 目录已存在：幂等语义下不算失败
            if (error.errno == -8L) return
            throw error
        }
    }

    /**
     * 逐级创建目录。
     *
     * 关键点：百度网盘里沙箱根 `/apps/<应用名>` 是应用安装时**自动生成**的，
     * 应用不能自己创建 `/apps` 或 `/apps/<应用名>`。因此这里只从沙箱根**之下一级**
     * 开始建子目录；沙箱根自身只做一次 [assertInsideSandbox] 校验，不发创建请求。
     */
    fun ensureFolder(path: String) {
        val target = assertInsideSandbox(sandboxRoot, path)
        val root = normalizePanPath(sandboxRoot)
        val relative = target.removePrefix(root).trim('/')
        if (relative.isEmpty()) return // 沙箱根自身：已存在，无需创建

        var current = root
        for (segment in relative.split('/').filter { it.isNotEmpty() }) {
            current = "$current/$segment"
            createFolder(current)
        }
    }

    /**
     * 删除文件（async=2 异步删除，服务端不阻塞）。
     * POST .../xpan/file?method=filemanager&opera=delete，body 为 filelist=JSON 数组
     */
    fun deleteFile(path: String) {
        val target = assertInsideSandbox(sandboxRoot, path)
        callApi(
            method = "POST",
            baseUrl = fileApiBaseUrl,
            query = listOf("method" to "filemanager", "opera" to "delete"),
            body = linkedMapOf(
                "async" to "2",
                "filelist" to JsonArray(listOf(JsonPrimitive(target))).toString(),
            ),
        )
    }

    /** 网盘容量信息（可选能力，供设置面板展示） */
    fun getQuota(): PanQuota {
        val data = callApi(
            method = "GET",
            baseUrl = quotaBaseUrl,
            query = listOf("checkfree" to "1", "checkexpire" to "1"),
        )
        return PanQuota(
            total = data.longOrNull("total") ?: 0L,
            used = data.longOrNull("used") ?: 0L,
            free = data.longOrNull("free") ?: 0L,
        )
    }

    // ------------------------------------------------------------- 内部实现

    /** 所有百度接口统一要求的请求头 */
    private fun panHeaders(): Map<String, String> = mapOf("User-Agent" to PAN_USER_AGENT)

    private fun toEntry(item: JsonObject, fallbackPath: String = ""): PanFileEntry {
        val path = item.stringOrNull("path") ?: fallbackPath
        val serverFilename = item.stringOrNull("server_filename").orEmpty()
        val fsId = item.longOrNull("fs_id")
        return PanFileEntry(
            fsId = fsId?.takeIf { it > 0 },
            path = path,
            name = serverFilename.ifEmpty { path.substringAfterLast('/') },
            size = item.longOrNull("size") ?: 0L,
            isDir = item.longOrNull("isdir") == 1L,
            // 服务端 mtime 是秒；缺失时回落到 0（对应桌面端 serverMtimeMs）
            serverMtimeMs = (item.longOrNull("server_mtime") ?: 0L) * 1000L,
            md5 = item.stringOrNull("md5"),
            dlink = item.stringOrNull("dlink"),
        )
    }

    private fun rawFetch(request: HttpRequest): HttpResponse {
        return try {
            transport.execute(request)
        } catch (error: IOException) {
            throw BaiduPanError(
                BaiduPanErrorKind.NETWORK,
                sanitizeMessage(
                    "网络请求失败：${error.message ?: error.javaClass.simpleName}",
                    listOf(config.accessToken, config.appKey),
                ),
            )
        } catch (error: RuntimeException) {
            throw BaiduPanError(
                BaiduPanErrorKind.NETWORK,
                sanitizeMessage(
                    "网络请求失败：${error.message ?: error.javaClass.simpleName}",
                    listOf(config.accessToken, config.appKey),
                ),
            )
        }
    }

    private fun parseJson(response: HttpResponse): JsonObject {
        val text = response.text()
        if (text.isBlank()) {
            if (response.isSuccessful) return JsonObject(emptyMap())
            throw BaiduPanError(
                BaiduPanErrorKind.NETWORK,
                "接口返回空响应：HTTP ${response.status}",
            )
        }
        return runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
            ?: throw BaiduPanError(
                BaiduPanErrorKind.API,
                sanitizeMessage(
                    "接口返回非 JSON（HTTP ${response.status}）：${text.take(200)}",
                    listOf(config.accessToken),
                ),
            )
    }

    /** 把 errno/error_code 统一成 [BaiduPanError]（按 errno 分类，便于上层重试或刷新令牌） */
    private fun apiErrorFrom(data: JsonObject, prefix: String): BaiduPanError {
        val errnoRaw = data["errno"] ?: data["error_code"]
        val errno = errnoRaw.asLongOrNull()
        val errmsg = data.stringOrNull("errmsg") ?: data.stringOrNull("error_msg") ?: ""
        val text = sanitizeMessage(
            "$prefix：${describeErrno(errno ?: -1L, errmsg)}",
            listOf(config.accessToken, config.appKey, config.secretKey),
        )
        return when {
            isRateLimitErrno(errno) -> BaiduPanError(BaiduPanErrorKind.RATE_LIMIT, text, errno)
            isAuthErrno(errno) -> BaiduPanError(BaiduPanErrorKind.AUTH, text, errno)
            errno != null && errno in SANDBOX_ERRNOS -> BaiduPanError(BaiduPanErrorKind.SANDBOX, text, errno)
            else -> BaiduPanError(BaiduPanErrorKind.API, text, errno)
        }
    }

    /**
     * 调用一次 REST 接口，内含四层处理：
     * 1. 路径已由各接口自己过沙箱校验；
     * 2. 频率限制（20012/31034/111）按 [rateLimitBaseDelayMs] 指数退避后重试；
     * 3. 网络/5xx 抖动按 [transientBaseDelayMs] 指数退避重试；
     * 4. 鉴权失败先刷新一次 token 再重放（仅一次，避免死循环）。
     */
    private fun callApi(
        method: String,
        baseUrl: String,
        query: List<Pair<String, String>>,
        body: Map<String, String>? = null,
        multipart: HttpBody.Multipart? = null,
        /**
         * 业务错误码白名单：命中这些 errno 时**不抛错**，把原始响应交给调用方判断。
         * 用于「目标不存在」这类正常语义（见 [FILE_NOT_FOUND_ERRNOS]）。
         */
        tolerateErrnos: Set<Long> = emptySet(),
    ): JsonObject {
        // URL 必须在**每次重试时重新拼**：鉴权失败会先刷新 token 再重放，
        // 若沿用首轮的 access_token，重放必然再次 401（对应的桌面端实现同样在循环内 buildUrl）。
        fun buildUrl(): String =
            "$baseUrl?" + panEncodeQuery(query + listOf("access_token" to config.accessToken))

        val headers = buildMap {
            putAll(panHeaders())
            // multipart 的 Content-Type 交给传输层生成 boundary（与 fetch + FormData 一致）
            if (multipart == null && body != null) {
                put("Content-Type", "application/x-www-form-urlencoded")
            }
        }
        val requestBody: HttpBody? = when {
            multipart != null -> multipart
            body != null -> HttpBody.Form(body)
            else -> null
        }

        var rateLimitRetries = 0
        var transientRetries = 0
        var authRetried = false

        // 循环上界：三类重试各自计数，任一超限即抛出
        while (true) {
            val request = HttpRequest(
                url = buildUrl(),
                method = method,
                headers = headers,
                body = requestBody,
            )

            val response: HttpResponse
            try {
                response = rawFetch(request)
            } catch (error: BaiduPanError) {
                if (error.kind == BaiduPanErrorKind.NETWORK && transientRetries < transientMaxRetries) {
                    sleep(transientBaseDelayMs * (1L shl transientRetries))
                    transientRetries++
                    continue
                }
                throw error
            }

            if (response.status >= 500 && transientRetries < transientMaxRetries) {
                sleep(transientBaseDelayMs * (1L shl transientRetries))
                transientRetries++
                continue
            }

            val data = parseJson(response)

            // 业务错误码：errno 或 error_code（上传域名接口用后者）
            val errnoRaw = data["errno"] ?: data["error_code"]
            val errno = errnoRaw.asLongOrNull()
            val ok = if (errno == null) response.isSuccessful else errno == 0L
            if (ok) return data

            if (isRateLimitErrno(errno) && rateLimitRetries < rateLimitMaxRetries) {
                sleep(rateLimitBaseDelayMs * (1L shl rateLimitRetries))
                rateLimitRetries++
                continue
            }
            if (isAuthErrno(errno) && !authRetried && config.refreshToken.isNotEmpty()) {
                authRetried = true
                refreshTokens()
                continue
            }
            // 「目标不存在」是正常语义，不是失败：交回调用方按空结果处理
            if (errno != null && errno in tolerateErrnos) return data
            throw apiErrorFrom(data, "网盘接口调用失败")
        }
    }

    companion object {
        const val OAUTH_TOKEN_URL = "https://openapi.baidu.com/oauth/2.0/token"
        const val OAUTH_AUTHORIZE_URL = "https://openapi.baidu.com/oauth/2.0/authorize"
        const val PAN_FILE_API = "https://pan.baidu.com/rest/2.0/xpan/file"
        const val PAN_QUOTA_API = "https://pan.baidu.com/api/quota"

        /** 百度网盘开放平台的固定 scope（基础信息 + 网盘读写） */
        const val OAUTH_SCOPE = "basic,netdisk"

        /**
         * 百度应用 AppKey 的长度（32 位字母数字）。
         *
         * 真机反馈（2026-10-17）：用户在设置页把控制台的 **AppID**（`123456789`，纯数字）
         * 当成了 AppKey 填进去，授权页直接报 `invalid_client / unknown client id`——
         * 那是个百度自家的错误页，用户完全无从自查（旧标签还写着「AppKey（应用 ID）」，
         * 等于在诱导填错）。因此在进入授权页之前先用本函数做形态校验，把问题挡在 App 内。
         */
        const val APP_KEY_LENGTH = 32

        /** AppKey 形态校验：32 位字母数字。仅用于**提前提示**，不做硬性拦截（防百度改格式后卡死） */
        fun looksLikeAppKey(value: String): Boolean =
            value.length == APP_KEY_LENGTH && value.all { it.isLetterOrDigit() }

        /**
         * 拼「授权页」链接（授权码模式，`redirect_uri=oob` 即页面直接显示授权码）。
         *
         * 设置页用它提供「打开授权链接 / 复制授权链接」，**不需要用户手工拼 URL 或从别处搬运**：
         * 真机实测中用户失败的原因正是拿到了一个旧的、已被消费过的授权码——
         * 让他能在手机上现取现用，比任何错误提示都有效。
         *
         * 注意 `redirect_uri` 必须与换取 token 时用的值一致（客户端默认 `oob`）。
         */
        fun authorizeUrl(appKey: String): String =
            "$OAUTH_AUTHORIZE_URL?response_type=code&client_id=$appKey" +
                "&redirect_uri=oob&scope=$OAUTH_SCOPE&display=page"

        /** 上传/下载域名接口的固定主机；真正上传地址由 locateupload 下发（这里用官方示例域名兜底） */
        const val UPLOAD_LOCATE_HOST = "d.pcs.baidu.com"

        /** 文档明确要求固定使用该 User-Agent，否则命中防盗链（errno 31326） */
        const val PAN_USER_AGENT = "pan.baidu.com"

        /**
         * 单步上传的本地上限：任务书要求「≤4MB 用；超限明确报错」。
         * 官方单步上限其实有 2GB，但 Android 未实现分片上传，收紧到 4MB 更诚实
         * （词库与边车都是几 KB 级文本；见类注释「与桌面端的已知差异」）。
         */
        const val SINGLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024

        /** 文档中的「未过审应用」配额错误码：访问超限 / 命中接口频控 / 异步任务占用 */
        internal val RATE_LIMIT_ERRNOS = setOf(20012L, 31034L, 111L)

        /**
         * 「目标文件不存在」类错误码（**正常语义，不是失败**）。
         *
         * 实测（2026-10-17 真凭证）：`method=filemetas` 查不存在的路径时，顶层返回 `errno=12`，
         * 且 `info` 里对应项带 `errno=-9`。若当硬错误抛出，**全新账号首次同步必然全部失败**
         * （首次远端本来就没有任何 canvas/边车），表现为满屏「拉取远端词库失败/上传失败」、
         * 永远传不上去。桌面端曾有同一缺陷，两端已同步修复。
         */
        internal val FILE_NOT_FOUND_ERRNOS = setOf(12L)

        /** 鉴权类错误码：命中后先刷新 token 再重试一次 */
        internal val AUTH_ERRNOS = setOf(-6L, 20016L, 20017L, 31045L, 45018L)

        /** 路径越界类错误码：命中即视为沙箱问题，不做退避重试 */
        internal val SANDBOX_ERRNOS = setOf(20020L, -7L)

        private val json = Json { ignoreUnknownKeys = true }
    }
}

/** OAuth 令牌三件套；[expiresAt] 是**绝对**毫秒时间戳（由 `expires_in` 秒换算） */
data class PanTokens(
    val accessToken: String,
    val refreshToken: String,
    val expiresAt: Long,
)

/** 网盘容量（字节） */
data class PanQuota(val total: Long, val used: Long, val free: Long)

/** 网盘上的一个条目；[dlink] 只在 filemetas(dlink=true) 时有值 */
data class PanFileEntry(
    val fsId: Long?,
    val path: String,
    val name: String,
    val size: Long,
    val isDir: Boolean,
    val serverMtimeMs: Long,
    val md5: String?,
    val dlink: String? = null,
)

/** 错误分类：供上层决定是否刷新令牌 / 退避重试 / 直接失败 */
enum class BaiduPanErrorKind { AUTH, RATE_LIMIT, SANDBOX, NETWORK, API }

/** 统一的网盘错误：`kind` 供上层决策，`message` 保证不含凭证 */
open class BaiduPanError(
    val kind: BaiduPanErrorKind,
    message: String,
    val errno: Long? = null,
) : Exception(message)

/** 路径越界（不在应用沙箱内）：永远直接抛错，不静默改写路径 */
class BaiduPanSandboxError(
    val target: String,
    val sandboxRoot: String,
) : BaiduPanError(
    BaiduPanErrorKind.SANDBOX,
    "拒绝访问应用沙箱之外的路径：$target（只允许 $sandboxRoot/ 之下）",
)

fun isRateLimitErrno(errno: Long?): Boolean = errno != null && errno in BaiduPanClient.RATE_LIMIT_ERRNOS

fun isAuthErrno(errno: Long?): Boolean = errno != null && errno in BaiduPanClient.AUTH_ERRNOS

/** 错误码 → 可读信息（未知码回落到 errmsg 原文，不外泄凭证） */
fun describeErrno(errno: Long, errmsg: String? = null): String {
    val known = ERRNO_MESSAGES[errno]
    val detail = errmsg?.trim().orEmpty()
    return when {
        known != null && detail.isNotEmpty() -> "errno=$errno（$known）：$detail"
        known != null -> "errno=$errno（$known）"
        detail.isNotEmpty() -> "errno=$errno：$detail"
        else -> "errno=$errno"
    }
}

/** 从任意错误信息里抹掉可能混进来的凭证（日志/UI 前的最后一道闸） */
fun sanitizeMessage(message: String, secrets: List<String?>): String {
    var out = message
    for (secret in secrets) {
        if (secret != null && secret.length >= 6) out = out.replace(secret, "***")
    }
    return out
}

/**
 * 错误码 → 可读说明（来源：平台简介 > 错误码）。
 * 与桌面端 `ERRNO_MESSAGES` 逐条对齐，含那条集中说明。
 */
internal val ERRNO_MESSAGES: Map<Long, String> = mapOf(
    -1L to "权益已过期",
    -3L to "文件不存在",
    -6L to "身份验证失败（access_token 无效或授权未成功）",
    -7L to "文件或目录名错误或无权访问",
    -8L to "文件或目录已存在",
    -9L to "文件或目录不存在",
    -10L to "云端容量已满",
    2L to "参数错误",
    111L to "有其他异步任务正在执行，请稍后重试",
    31023L to "参数错误",
    31024L to "没有该接口权限（检查应用是否申请了上传/下载权限）",
    31034L to "命中接口频控，请求过于频繁",
    31045L to "access_token 验证未通过（可能过期或未勾选网盘权限）",
    31061L to "文件已存在",
    31062L to "文件名无效",
    31064L to "上传路径错误：路径必须位于 /apps/{应用名称}/ 目录下",
    31066L to "文件名不存在",
    31190L to "文件不存在（分片上传阶段参数不一致）",
    31326L to "命中防盗链：检查 User-Agent 是否为 pan.baidu.com",
    31360L to "下载链接已过期，需要重新获取 dlink",
    31362L to "签名错误：下载链接不完整，请勿截断或改写查询串",
    20011L to "应用审核中，仅限前 10 个完成 OAuth 授权的用户测试",
    20012L to "访问超限：调用次数已达上限（未过审应用为测试配额）",
    20013L to "权限不足：当前应用无该接口权限",
    20015L to "该应用已失效，暂不支持访问",
    20016L to "access_token 已过期",
    20017L to "access_token 无效（可能被解绑或撤销授权）",
    20020L to "路径不在允许的访问范围内（只能读写 /apps/{应用名称}/ 之下）",
    20021L to "无法获取应用名称（检查应用 id）",
    20022L to "路径参数格式不正确",
    20023L to "缺少必需的路径参数",
    // 注意：45018 在百度网盘开放平台官方错误码表与全部 313 个文档页面中**均无记录**
    // （桌面端已全站检索确认）。任务规约要求对 45018 给出可读错误，因此这里按「未认证」处理，
    // 但不要把它当成百度网盘的真实错误码依赖——真实遇到的鉴权失败是 -6 / 20016 / 20017 / 31045。
    45018L to "未认证：access_token 缺失、无效或已过期",
)

/**
 * 规整网盘绝对路径：
 * - 必须以 `/` 开头（否则认为调用方写错了相对路径）；
 * - 折叠 `//`、去掉 `/./`、解析 `/../`（越出根则直接判非法）；
 * - 去掉末尾多余的 `/`（根路径除外）。
 */
fun normalizePanPath(input: String): String {
    val raw = input.trim()
    if (raw.isEmpty() || !raw.startsWith("/")) {
        throw BaiduPanError(
            BaiduPanErrorKind.SANDBOX,
            "网盘路径必须是以 / 开头的绝对路径：$input",
        )
    }
    val segments = ArrayList<String>()
    for (segment in raw.split('/')) {
        when {
            segment.isEmpty() || segment == "." -> Unit
            segment == ".." -> {
                if (segments.isEmpty()) {
                    throw BaiduPanError(
                        BaiduPanErrorKind.SANDBOX,
                        "网盘路径越出根目录：$input",
                    )
                }
                segments.removeAt(segments.lastIndex)
            }
            else -> segments.add(segment)
        }
    }
    return "/${segments.joinToString("/")}"
}

/** 目标是否等于沙箱根或其子路径（纯比较，不做规整） */
private fun isInside(sandboxRoot: String, target: String): Boolean =
    target == sandboxRoot || target.startsWith("$sandboxRoot/")

/**
 * 断言目标路径位于应用沙箱内并返回规整后的路径；越界直接抛 [BaiduPanSandboxError]。
 * 每个读写接口在发出请求前都必须过这一步——**越界在本地就被拦下，一个请求都不发**。
 */
fun assertInsideSandbox(sandboxRoot: String, target: String): String {
    val root = normalizePanPath(sandboxRoot)
    val normalized = normalizePanPath(target)
    if (!isInside(root, normalized)) {
        throw BaiduPanSandboxError(normalized, root)
    }
    return normalized
}

// ------------------------------------------------------------------ JSON 小工具

/** 该值是否为 JSON 数字/数字串，并转成 Long（用于 errno / fs_id / isdir 等） */
internal fun JsonElement?.asLongOrNull(): Long? {
    val primitive = this as? JsonPrimitive ?: return null
    if (primitive is JsonNull) return null
    return primitive.longOrNull ?: primitive.doubleOrNull?.takeIf { it.isFinite() }?.toLong()
}

internal fun JsonObject.stringOrNull(key: String): String? {
    val primitive = this[key] as? JsonPrimitive ?: return null
    return if (primitive.isString) primitive.content else null
}

internal fun JsonObject.longOrNull(key: String): Long? = this[key].asLongOrNull()

internal fun JsonObject.booleanOrNull(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

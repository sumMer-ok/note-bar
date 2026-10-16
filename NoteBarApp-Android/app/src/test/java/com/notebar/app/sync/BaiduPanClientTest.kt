package com.notebar.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/**
 * 百度网盘客户端单测：**全部走假传输层，绝不触网**。
 *
 * 用例语义逐项覆盖桌面端 `tests/sync/baidu-pan-client.test.ts`（COVERED 列表）：
 *   - 授权码换 token：URL 参数、`expires_in`（秒）→ 绝对毫秒时间戳
 *   - 刷新：新 refresh_token 被保存并通过 onTokens 回调落盘；缺 refresh_token 时报可读错误
 *   - 过期判断：30 天 TTL + 5 分钟边界余量；expiresAt=0 视为过期
 *   - listDir：请求构造（method/dir/order/desc）与响应解析（含目录/文件标记、秒级 mtime）
 *   - 单步上传：multipart 请求构造、path/ondup/access_token 位置、响应解析、超限拒绝
 *   - 下载：先 filemetas(target, dlink=1) 再带 access_token + User-Agent 取字节
 *   - createFolder / ensureFolder / deleteFile 的请求构造
 *   - 沙箱：/apps/ 之外（含 `..` 逃逸）一律抛 BaiduPanSandboxError，且**不发请求**
 *   - errno → 可读信息；频率限制退避重试；鉴权失败刷新后重放
 */
class BaiduPanClientTest {

    private val fakeNow = 1_763_000_000_000L // 固定「现在」，避免时间相关的偶发

    /** 测试用假凭证：绝不用真实 appKey/secretKey/token */
    private val fakeAppKey = "fake-app-key"
    private val fakeSecretKey = "fake-secret-key"
    private val fakeAccessToken = "fake-access-token-1"
    private val fakeRefreshToken = "fake-refresh-token-1"

    private fun config(
        enabled: Boolean = true,
        expiresAt: Long = fakeNow + 30L * 24 * 3600 * 1000,
    ): BaiduPanSettings = BaiduPanSettings(
        enabled = enabled,
        appKey = fakeAppKey,
        secretKey = fakeSecretKey,
        accessToken = fakeAccessToken,
        refreshToken = fakeRefreshToken,
        expiresAt = expiresAt,
    )

    /** 退避时长记录器：把 sleep 换掉，测试就不必真的等 60 秒 */
    private class Delays {
        val recorded = ArrayList<Long>()
        fun sleep(ms: Long) {
            recorded.add(ms)
        }
    }

    private fun clientWith(
        responses: List<ScriptedResponse>,
        cfg: BaiduPanSettings = config(),
        delays: Delays = Delays(),
        onTokens: ((PanTokens) -> Unit)? = null,
        rateLimitBaseDelayMs: Long = 1000L,
    ): Pair<BaiduPanClient, ScriptedTransport> {
        val transport = ScriptedTransport(responses)
        val client = BaiduPanClient(
            initialConfig = cfg,
            transport = transport,
            nowMs = { fakeNow },
            sleep = delays::sleep,
            rateLimitBaseDelayMs = rateLimitBaseDelayMs,
            onTokens = onTokens,
        )
        return client to transport
    }

    // ------------------------------------------------------------------ OAuth

    @Test
    fun exchangeAuthorizationCodeBuildsUrlAndConvertsExpiresIn() {
        val (client, transport) = clientWith(
            listOf(ScriptedTransport.json("""{"access_token":"new-access","refresh_token":"new-refresh","expires_in":2592000,"scope":"basic netdisk"}""")),
        )

        val tokens = client.exchangeAuthorizationCode("fake-code", "oob")

        val query = MemoryPanTransport.parseQuery(java.net.URI(transport.request(0).url).rawQuery)
        assertEquals(BaiduPanClient.OAUTH_TOKEN_URL, transport.request(0).url.substringBefore('?'))
        assertEquals("authorization_code", query["grant_type"])
        assertEquals("fake-code", query["code"])
        assertEquals(fakeAppKey, query["client_id"])
        assertEquals(fakeSecretKey, query["client_secret"])
        assertEquals("oob", query["redirect_uri"])

        assertEquals("new-access", tokens.accessToken)
        assertEquals("new-refresh", tokens.refreshToken)
        // 30 天 = 2592000 秒
        assertEquals(fakeNow + 2592000L * 1000, tokens.expiresAt)
    }

    @Test
    fun refreshSavesRotatedRefreshTokenAndNotifiesCaller() {
        val saved = ArrayList<String>()
        val (client, transport) = clientWith(
            listOf(ScriptedTransport.json("""{"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_in":2592000}""")),
            onTokens = { saved.add(it.refreshToken) },
        )

        val tokens = client.refreshTokens()

        val query = MemoryPanTransport.parseQuery(java.net.URI(transport.request(0).url).rawQuery)
        assertEquals("refresh_token", query["grant_type"])
        assertEquals(fakeRefreshToken, query["refresh_token"])
        // 配置被就地更新（调用方随后落盘）
        assertEquals("rotated-access", client.config.accessToken)
        assertEquals("rotated-refresh", client.config.refreshToken)
        assertEquals("rotated-refresh", tokens.refreshToken)
        assertEquals(listOf("rotated-refresh"), saved)
    }

    @Test
    fun refreshKeepsOldRefreshTokenWhenResponseOmitsIt() {
        val (client, _) = clientWith(
            listOf(ScriptedTransport.json("""{"access_token":"only-access","expires_in":100}""")),
        )
        val tokens = client.refreshTokens()
        assertEquals("only-access", tokens.accessToken)
        assertEquals(fakeRefreshToken, client.config.refreshToken)
    }

    @Test
    fun refreshWithoutRefreshTokenFailsReadablyAndNeverCallsNetwork() {
        val (client, transport) = clientWith(
            listOf(ScriptedTransport.json("{}")),
            cfg = config().copy(refreshToken = ""),
        )
        val error = assertFails<BaiduPanError> { client.refreshTokens() }
        assertEquals(BaiduPanErrorKind.AUTH, error.kind)
        assertTrue("错误信息应提到 refresh_token：${error.message}", error.message!!.contains("refresh_token"))
        assertEquals(0, transport.requests.size)
    }

    @Test
    fun oauthErrorBodyBecomesReadableErrorWithoutLeakingSecret() {
        val (client, _) = clientWith(
            listOf(
                ScriptedTransport.json(
                    """{"error":"invalid_grant","error_description":"Authorization code has expired"}""",
                ),
            ),
        )
        val error = assertFails<BaiduPanError> { client.exchangeAuthorizationCode("expired-code") }
        assertEquals(BaiduPanErrorKind.AUTH, error.kind)
        assertTrue(error.message!!.contains("invalid_grant"))
        assertFalse(error.message!!.contains(fakeSecretKey))
    }

    @Test
    fun tokenExpiryUsesThirtyDayTtlWithFiveMinuteSkew() {
        val fresh = clientWith(listOf(ScriptedTransport.json("{}")), config(expiresAt = fakeNow + 30L * 24 * 3600 * 1000)).first
        assertFalse(fresh.isTokenExpired())
        assertTrue(fresh.hasUsableToken())

        // 只剩 1 分钟：落在 5 分钟余量内，按已过期处理
        val nearlyExpired = clientWith(listOf(ScriptedTransport.json("{}")), config(expiresAt = fakeNow + 60_000)).first
        assertTrue(nearlyExpired.isTokenExpired())

        val never = clientWith(
            listOf(ScriptedTransport.json("{}")),
            config(expiresAt = 0).copy(accessToken = ""),
        ).first
        assertTrue(never.isTokenExpired())
        assertFalse(never.hasUsableToken())
    }

    @Test
    fun ensureFreshTokenOnlyRefreshesWhenExpired() {
        val notExpired = clientWith(listOf(ScriptedTransport.json("{}"))).first
        assertFalse(notExpired.ensureFreshToken())

        val (client, transport) = clientWith(
            listOf(
                ScriptedTransport.json("""{"access_token":"refreshed","refresh_token":"r2","expires_in":2592000}"""),
            ),
            config(expiresAt = 1),
        )
        assertTrue(client.ensureFreshToken())
        assertEquals(1, transport.requests.size)
    }

    // ----------------------------------------------------------------- listDir

    @Test
    fun listDirBuildsRequestAndParsesEntries() {
        val (client, transport) = clientWith(
            listOf(
                ScriptedTransport.json(
                    """{"errno":0,"list":[
                        {"fs_id":111,"path":"/apps/NoteBar/Words","server_filename":"Words","isdir":1,"server_mtime":1691048365},
                        {"fs_id":222,"path":"/apps/NoteBar/Words/AI.canvas","server_filename":"AI.canvas","isdir":0,"size":1234,"server_mtime":1691048400,"md5":"abc"}
                    ]}""",
                ),
            ),
        )

        val entries = client.listDir("/apps/NoteBar/Words")
        val query = MemoryPanTransport.parseQuery(java.net.URI(transport.request(0).url).rawQuery)

        assertEquals("GET", transport.request(0).method)
        assertEquals("list", query["method"])
        assertEquals("/apps/NoteBar/Words", query["dir"])
        assertEquals("time", query["order"])
        assertEquals("1", query["desc"])
        assertEquals(fakeAccessToken, query["access_token"])

        assertEquals(2, entries.size)
        assertTrue(entries[0].isDir)
        assertFalse(entries[1].isDir)
        assertEquals("AI.canvas", entries[1].name)
        assertEquals(1234L, entries[1].size)
        // 秒 → 毫秒
        assertEquals(1691048400000L, entries[1].serverMtimeMs)
    }

    @Test
    fun listDirClampsLimitAndStart() {
        val (client, transport) = clientWith(listOf(ScriptedTransport.json("""{"errno":0,"list":[]}""")))
        client.listDir("/apps/NoteBar/Words", start = -5, limit = 99999)
        val query = MemoryPanTransport.parseQuery(java.net.URI(transport.request(0).url).rawQuery)
        assertEquals("1000", query["limit"])
        assertEquals("0", query["start"])

        val (client2, transport2) = clientWith(listOf(ScriptedTransport.json("""{"errno":0,"list":[]}""")))
        client2.listDir("/apps/NoteBar/Words", limit = 0)
        assertEquals(
            "1",
            MemoryPanTransport.parseQuery(java.net.URI(transport2.request(0).url).rawQuery)["limit"],
        )
    }

    // -------------------------------------------------------------- 单步上传

    @Test
    fun uploadFileSendsMultipartAndParsesResponse() {
        val (client, transport) = clientWith(
            listOf(
                ScriptedTransport.json(
                    """{"errno":0,"path":"/apps/NoteBar/Words/AI.canvas","fs_id":9,"size":10,"md5":"m"}""",
                ),
            ),
        )

        val entry = client.uploadFile(
            "/apps/NoteBar/Words/AI.canvas",
            "{}".toByteArray(Charsets.UTF_8),
            ondup = "overwrite",
        )

        val request = transport.request(0)
        val url = java.net.URI(request.url)
        val query = MemoryPanTransport.parseQuery(url.rawQuery)
        assertEquals("/rest/2.0/pcs/file", url.path)
        assertEquals("upload", query["method"])
        assertEquals("/apps/NoteBar/Words/AI.canvas", query["path"])
        assertEquals("overwrite", query["ondup"])
        assertEquals(fakeAccessToken, query["access_token"])
        assertEquals("POST", request.method)
        // multipart 的 Content-Type 由传输层生成 boundary，客户端不能手工写死
        assertNull(request.headers["Content-Type"])
        assertEquals("pan.baidu.com", request.headers["User-Agent"])
        val body = request.body
        assertTrue("上传体应是 multipart：$body", body is HttpBody.Multipart)
        assertEquals("AI.canvas", (body as HttpBody.Multipart).fileName)

        assertEquals("/apps/NoteBar/Words/AI.canvas", entry.path)
        assertEquals(9L, entry.fsId)
    }

    @Test
    fun uploadFileRejectsOversizeLocallyWithoutNetwork() {
        val (client, transport) = clientWith(listOf(ScriptedTransport.json("""{"errno":0}""")))
        val oversize = ByteArray(BaiduPanClient.SINGLE_UPLOAD_MAX_BYTES + 1)

        val error = assertFails<BaiduPanError> {
            client.uploadFile("/apps/NoteBar/Words/big.canvas", oversize)
        }
        assertTrue("错误信息应说明超限：${error.message}", error.message!!.contains("单步上传上限"))
        assertEquals(0, transport.requests.size)
    }

    // ------------------------------------------------------------------ 下载

    @Test
    fun downloadFileFetchesDlinkThenBytesWithTokenAndUserAgent() {
        val payload = "canvas-bytes"
        val (client, transport) = clientWith(
            listOf(
                ScriptedTransport.json(
                    """{"errno":0,"info":[{"fs_id":1,"errno":0,"path":"/apps/NoteBar/Words/AI.canvas","server_filename":"AI.canvas","dlink":"https://d.pcs.baidu.com/file/abc?fid=1"}]}""",
                ),
                ScriptedTransport.bytes(payload.toByteArray(Charsets.UTF_8)),
            ),
        )

        val bytes = client.downloadFile("/apps/NoteBar/Words/AI.canvas")

        // 第 1 步：filemetas + dlink=1
        val metaRequest = transport.request(0)
        assertEquals("filemetas", MemoryPanTransport.parseQuery(java.net.URI(metaRequest.url).rawQuery)["method"])
        assertEquals("POST", metaRequest.method)
        val sentBody = (metaRequest.body as HttpBody.Form).fields
        assertEquals("""["/apps/NoteBar/Words/AI.canvas"]""", sentBody["target"])
        assertEquals("1", sentBody["dlink"])

        // 第 2 步：dlink + access_token + UA
        val downloadRequest = transport.request(1)
        val downloadUrl = java.net.URI(downloadRequest.url)
        assertEquals("https", downloadUrl.scheme)
        assertEquals("d.pcs.baidu.com", downloadUrl.host)
        assertEquals("/file/abc", downloadUrl.path)
        val downloadQuery = MemoryPanTransport.parseQuery(downloadUrl.rawQuery)
        assertEquals("1", downloadQuery["fid"])
        assertEquals(fakeAccessToken, downloadQuery["access_token"])
        assertEquals("pan.baidu.com", downloadRequest.headers["User-Agent"])

        assertEquals(payload, String(bytes, Charsets.UTF_8))
    }

    @Test
    fun downloadFileSurfacesJsonErrorBodyReadably() {
        val (client, _) = clientWith(
            listOf(
                ScriptedTransport.json(
                    """{"errno":0,"info":[{"errno":0,"path":"/apps/NoteBar/Words/x.canvas","dlink":"https://d.pcs.baidu.com/f"}]}""",
                ),
                ScriptedTransport.json("""{"errno":31360,"show_msg":"download link expired"}"""),
            ),
        )
        val error = assertFails<BaiduPanError> { client.downloadFile("/apps/NoteBar/Words/x.canvas") }
        assertEquals(31360L, error.errno)
        assertTrue("应给出可读的下载链接过期说明：${error.message}", error.message!!.contains("下载链接已过期"))
    }

    @Test
    fun downloadFileWithoutDlinkFailsReadably() {
        val (client, _) = clientWith(
            listOf(
                ScriptedTransport.json(
                    """{"errno":0,"info":[{"errno":0,"path":"/apps/NoteBar/Words/x.canvas"}]}""",
                ),
            ),
        )
        val error = assertFails<BaiduPanError> { client.downloadFile("/apps/NoteBar/Words/x.canvas") }
        assertTrue("应提到 dlink：${error.message}", error.message!!.contains("dlink"))
    }

    // ------------------------------------------------ 建目录 / 删除 / 容量

    @Test
    fun createFolderIsIdempotentWhenDirectoryExists() {
        val (client, transport) = clientWith(
            listOf(ScriptedTransport.json("""{"errno":0,"fs_id":1}"""), ScriptedTransport.json("""{"errno":-8}""")),
        )
        client.createFolder("/apps/NoteBar/Words")
        val query = MemoryPanTransport.parseQuery(java.net.URI(transport.request(0).url).rawQuery)
        assertEquals("create", query["method"])
        val body = (transport.request(0).body as HttpBody.Form).fields
        assertEquals("/apps/NoteBar/Words", body["path"])
        assertEquals("1", body["isdir"])

        // 幂等：已存在（-8）不抛错
        client.createFolder("/apps/NoteBar/Words")
        assertEquals(2, transport.requests.size)
    }

    @Test
    fun ensureFolderOnlyCreatesBelowSandboxRoot() {
        val (client, transport) = clientWith(listOf(ScriptedTransport.json("""{"errno":0}""")))
        client.ensureFolder("/apps/NoteBar/Words")

        // 只发一次 create，path 为 /apps/NoteBar/Words；绝不能给 /apps 或 /apps/NoteBar 发创建请求
        assertEquals(1, transport.requests.size)
        val body = (transport.request(0).body as HttpBody.Form).fields
        assertEquals("/apps/NoteBar/Words", body["path"])
        assertEquals("1", body["isdir"])
    }

    @Test
    fun ensureFolderSupportsNestedPathsWithoutTouchingApps() {
        val (client, transport) = clientWith(listOf(ScriptedTransport.json("""{"errno":0}""")))
        client.ensureFolder("/apps/NoteBar/Words/2026")
        val paths = transport.requests.map { (it.body as HttpBody.Form).fields["path"] }
        assertEquals(listOf("/apps/NoteBar/Words", "/apps/NoteBar/Words/2026"), paths)
    }

    @Test
    fun ensureFolderOnSandboxRootItselfIsNoOp() {
        val (client, transport) = clientWith(listOf(ScriptedTransport.json("""{"errno":0}""")))
        client.ensureFolder("/apps/NoteBar")
        assertEquals(0, transport.requests.size)
    }

    @Test
    fun ensureFolderRejectsOutsidePathWithoutNetwork() {
        val (client, transport) = clientWith(listOf(ScriptedTransport.json("""{"errno":0}""")))
        assertFails<BaiduPanSandboxError> { client.ensureFolder("/apps/OtherApp/Words") }
        assertEquals(0, transport.requests.size)
    }

    @Test
    fun deleteFileSendsJsonFileList() {
        val (client, transport) = clientWith(
            listOf(ScriptedTransport.json("""{"errno":0,"info":[{"errno":0}]}""")),
        )
        client.deleteFile("/apps/NoteBar/Words/AI.canvas")

        val query = MemoryPanTransport.parseQuery(java.net.URI(transport.request(0).url).rawQuery)
        assertEquals("filemanager", query["method"])
        assertEquals("delete", query["opera"])
        val body = (transport.request(0).body as HttpBody.Form).fields
        assertEquals("""["/apps/NoteBar/Words/AI.canvas"]""", body["filelist"])
    }

    @Test
    fun getQuotaParsesFields() {
        val (client, transport) = clientWith(
            listOf(ScriptedTransport.json("""{"errno":0,"total":100,"used":40,"free":60}""")),
        )
        val quota = client.getQuota()
        assertEquals("/api/quota", java.net.URI(transport.request(0).url).path)
        assertEquals(PanQuota(total = 100, used = 40, free = 60), quota)
    }

    // ------------------------------------------------------------------ 沙箱

    @Test
    fun sandboxRejectsOutsidersWithoutAnyRequest() {
        val (client, transport) = clientWith(listOf(ScriptedTransport.json("""{"errno":0}""")))
        val outside = listOf(
            "/我的文档/a.canvas",
            "/apps/OtherApp/Words/a.canvas",
            "/apps",
            "/",
        )
        for (target in outside) {
            assertFails<BaiduPanSandboxError>("应拒绝：$target") {
                client.uploadFile(target, byteArrayOf(1))
            }
        }
        assertFails<BaiduPanSandboxError> { client.listDir("/etc") }
        assertFails<BaiduPanSandboxError> { client.deleteFile("/apps/NoteBar2/x") }
        // 越界在本地就被拦下：一个请求都没发出去
        assertEquals(0, transport.requests.size)
    }

    @Test
    fun sandboxRejectsDotDotEscape() {
        val (client, transport) = clientWith(listOf(ScriptedTransport.json("""{"errno":0}""")))
        assertFails<BaiduPanSandboxError> {
            client.uploadFile("/apps/NoteBar/../OtherApp/x.canvas", byteArrayOf(1))
        }
        assertFails<BaiduPanError> {
            client.uploadFile("/apps/NoteBar/Words/../../../etc/passwd", byteArrayOf(1))
        }
        assertEquals(0, transport.requests.size)
    }

    @Test
    fun sandboxAllowsRootAndSubpaths() {
        val (client, _) = clientWith(listOf(ScriptedTransport.json("""{"errno":0,"list":[]}""")))
        assertEquals("/apps/NoteBar", client.sandboxRoot)
        assertEquals("/apps/NoteBar/Words", client.wordsDir)
        client.listDir("/apps/NoteBar")
        client.listDir("/apps/NoteBar/Words/Nested")
    }

    @Test
    fun normalizePanPathFoldsAndResolves() {
        assertEquals("/apps/NoteBar/Words", normalizePanPath("/apps/NoteBar//Words/"))
        assertEquals("/apps/NoteBar/Words", normalizePanPath("/apps/./NoteBar/./Words"))
        assertEquals("/apps/NoteBar/Words", normalizePanPath("/apps/NoteBar/Words/../Words"))
        assertFails<BaiduPanError> { normalizePanPath("apps/NoteBar") }
        assertFails<BaiduPanError> { normalizePanPath("/../x") }
    }

    @Test
    fun customDirDeterminesSandboxRoot() {
        val (client, _) = clientWith(
            listOf(ScriptedTransport.json("""{"errno":0,"list":[]}""")),
            config().copy(dir = "MyApp"),
        )
        assertEquals("/apps/MyApp", client.sandboxRoot)
        assertEquals("/apps/MyApp/Words", client.wordsDir)
        assertFails<BaiduPanSandboxError> { client.listDir("/apps/NoteBar/Words") }
    }

    // ------------------------------------------------------ errno 与退避重试

    @Test
    fun describeErrnoGivesChineseForKnownAndFallsBackToErrmsg() {
        assertTrue(describeErrno(45018).contains("未认证"))
        assertTrue(describeErrno(-6).contains("身份验证失败"))
        assertTrue(describeErrno(31064).contains("/apps/"))
        assertTrue(describeErrno(31034).contains("频控"))
        assertTrue(describeErrno(99999, "some detail").contains("some detail"))
        assertTrue(describeErrno(99999, "some detail").contains("99999"))
    }

    @Test
    fun sanitizeMessageRemovesCredentials() {
        val message = sanitizeMessage(
            "失败 token=$fakeAccessToken key=$fakeAppKey",
            listOf(fakeAccessToken, fakeAppKey),
        )
        assertFalse(message.contains(fakeAccessToken))
        assertFalse(message.contains(fakeAppKey))
        assertTrue(message.contains("***"))
    }

    @Test
    fun unauthenticatedErrnoRefreshesTokenThenReplaysOnce() {
        val (client, transport) = clientWith(
            listOf(
                ScriptedTransport.json("""{"errno":45018,"errmsg":"unauthorized"}"""),
                ScriptedTransport.json(
                    """{"access_token":"fresh-access","refresh_token":"fresh-refresh","expires_in":2592000}""",
                ),
                ScriptedTransport.json("""{"errno":0,"list":[]}"""),
            ),
        )

        val entries = client.listDir("/apps/NoteBar/Words")

        assertTrue(entries.isEmpty())
        // 第 1 次失败 → 第 2 次刷新 → 第 3 次带新 token 重放
        assertEquals(3, transport.requests.size)
        assertEquals(
            "refresh_token",
            MemoryPanTransport.parseQuery(java.net.URI(transport.request(1).url).rawQuery)["grant_type"],
        )
        assertEquals(
            "fresh-access",
            MemoryPanTransport.parseQuery(java.net.URI(transport.request(2).url).rawQuery)["access_token"],
        )
    }

    @Test
    fun authFailureWithoutRefreshTokenFailsWithoutRetryLoop() {
        val (client, transport) = clientWith(
            listOf(ScriptedTransport.json("""{"errno":-6,"errmsg":"Invalid Bduss"}""")),
            cfg = config().copy(refreshToken = ""),
        )
        val error = assertFails<BaiduPanError> { client.listDir("/apps/NoteBar/Words") }
        assertTrue("应给出身份验证失败说明：${error.message}", error.message!!.contains("身份验证失败"))
        assertEquals(1, transport.requests.size)
    }

    @Test
    fun rateLimitBacksOffThenRetriesWithInjectableDelay() {
        val delays = Delays()
        val (client, transport) = clientWith(
            listOf(
                ScriptedTransport.json("""{"errno":31034,"errmsg":"hit freq limit"}"""),
                ScriptedTransport.json("""{"errno":0,"list":[]}"""),
            ),
            delays = delays,
            rateLimitBaseDelayMs = 1000L,
        )

        client.listDir("/apps/NoteBar/Words")

        assertEquals(2, transport.requests.size)
        assertEquals(listOf(1000L), delays.recorded)
    }

    @Test
    fun rateLimitAfterRetriesExhaustedThrowsRateLimitError() {
        val (client, transport) = clientWith(
            listOf(ScriptedTransport.json("""{"errno":20012,"show_msg":"访问超限"}""")),
        )
        val error = assertFails<BaiduPanError> { client.listDir("/apps/NoteBar/Words") }
        assertEquals(BaiduPanErrorKind.RATE_LIMIT, error.kind)
        assertEquals(20012L, error.errno)
        // 1 次初始 + 1 次重试
        assertEquals(2, transport.requests.size)
    }

    @Test
    fun networkFailureBacksOffExponentiallyThenThrows() {
        val delays = Delays()
        val transport = ScriptedTransport(listOf(ScriptedTransport.json("""{"errno":0}""")))
        transport.failure = IOException("ECONNRESET")
        val client = BaiduPanClient(
            initialConfig = config(),
            transport = transport,
            nowMs = { fakeNow },
            sleep = delays::sleep,
            transientMaxRetries = 2,
            transientBaseDelayMs = 10L,
        )

        val error = assertFails<BaiduPanError> { client.listDir("/apps/NoteBar/Words") }
        assertEquals(BaiduPanErrorKind.NETWORK, error.kind)
        assertEquals(3, transport.requests.size)
        assertEquals(listOf(10L, 20L), delays.recorded)
    }

    @Test
    fun http5xxAlsoBacksOffAndRetries() {
        val (client, transport) = clientWith(
            listOf(
                ScriptedTransport.json("""{"errno":0}""", status = 503),
                ScriptedTransport.json("""{"errno":0,"list":[]}"""),
            ),
        )
        val entries = client.listDir("/apps/NoteBar/Words")
        assertTrue(entries.isEmpty())
        assertEquals(2, transport.requests.size)
    }

    @Test
    fun unknownErrnoIsClassifiedAsApiAndKeepsErrno() {
        val (client, _) = clientWith(listOf(ScriptedTransport.json("""{"errno":12345,"errmsg":"weird"}""")))
        val error = assertFails<BaiduPanError> { client.listDir("/apps/NoteBar/Words") }
        assertEquals(BaiduPanErrorKind.API, error.kind)
        assertEquals(12345L, error.errno)
    }

    @Test
    fun everyBusinessRequestCarriesPanUserAgent() {
        val (client, transport) = clientWith(listOf(ScriptedTransport.json("""{"errno":0,"list":[]}""")))
        client.listDir("/apps/NoteBar/Words")
        assertEquals("pan.baidu.com", transport.request(0).headers["User-Agent"])
    }

    @Test
    fun nonJsonResponseBecomesReadableApiError() {
        val (client, _) = clientWith(
            listOf(ScriptedResponse(200, "<html>blocked</html>".toByteArray(Charsets.UTF_8), "text/html")),
        )
        val error = assertFails<BaiduPanError> { client.listDir("/apps/NoteBar/Words") }
        assertTrue("应说明返回非 JSON：${error.message}", error.message!!.contains("非 JSON"))
    }

    @Test
    fun fileMetasReturnsNullForMissingPathAndEntryForPresent() {
        val (client, _) = clientWith(
            listOf(
                ScriptedTransport.json(
                    """{"errno":0,"info":[
                        {"errno":0,"fs_id":1,"path":"/apps/NoteBar/Words/AI.canvas","server_filename":"AI.canvas","size":5},
                        {"errno":-9}
                    ]}""",
                ),
            ),
        )
        val metas = client.fileMetas(listOf("/apps/NoteBar/Words/AI.canvas", "/apps/NoteBar/Words/none.canvas"))
        assertEquals(2, metas.size)
        assertNotNull(metas[0])
        assertNull(metas[1])
        assertEquals("AI.canvas", metas[0]!!.name)
        assertEquals(5L, metas[0]!!.size)
    }

    /** 断言某段代码抛 [T]，并返回该异常（比 `assertThrows` 更好读，且能取到 message） */
    private inline fun <reified T : Throwable> assertFails(
        message: String? = null,
        block: () -> Unit,
    ): T {
        try {
            block()
        } catch (error: Throwable) {
            if (error is T) return error
            fail("期望抛 ${T::class.java.simpleName}，实际是 ${error.javaClass.name}：${error.message}")
        }
        throw AssertionError(message ?: "期望抛 ${T::class.java.simpleName}，但没有抛")
    }
}

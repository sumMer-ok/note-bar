/**
 * 百度网盘客户端单测（全部 mock fetch，绝不触网）。
 *
 * 覆盖（COVERED）
 *   - 授权码换 token：请求 URL 参数、expires_in（秒）→ 绝对时间戳
 *   - 刷新：新 refresh_token 被保存并通过 onTokens 回调落盘；缺 refresh_token 时报可读错误
 *   - 过期判断：30 天 TTL + 5 分钟边界余量；expiresAt=0 视为过期
 *   - listDir：请求构造（method/dir/order/desc）与响应解析（含目录/文件标记）
 *   - 单步上传：multipart 请求构造、path/ondup/access_token 位置、响应解析、>2GB 拒绝
 *   - 下载：先 filemetas(target) 拿 dlink，再带 access_token + User-Agent 取字节
 *   - createFolder / ensureFolder / deleteFile 的请求构造
 *   - 沙箱：/apps/ 之外（含 `..` 逃逸）一律抛 BaiduPanSandboxError，且不发请求
 *   - errno → 可读信息；频率限制（20012/31034/111）退避重试；鉴权失败刷新后重放
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BaiduPanClient,
  BaiduPanError,
  BaiduPanSandboxError,
  describeErrno,
  normalizePanPath,
  sanitizeMessage,
  type FetchLike,
} from "../../src/sync/baidu-pan-client";
import { defaultBaiduPanSettings } from "../../src/sync/baidu-pan-config";
import type { BaiduPanSettings } from "../../src/hiwords/utils/types";

/** 测试用假凭证：绝不用真实 appKey/secretKey/token */
const FAKE = {
  appKey: "fake-app-key",
  secretKey: "fake-secret-key",
  accessToken: "fake-access-token-1",
  refreshToken: "fake-refresh-token-1",
};

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

/** 按脚本顺序返回响应的假 fetch，并记录每次请求 */
function createFetchMock(
  responses: Array<{ status?: number; body: unknown; contentType?: string }>
): { fetchImpl: FetchLike; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const scripted = responses[Math.min(index, responses.length - 1)];
    index++;
    const status = scripted.status ?? 200;
    const isJson = typeof scripted.body !== "string";
    const text = isJson ? JSON.stringify(scripted.body) : (scripted.body as string);
    const bytes = new TextEncoder().encode(text);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? scripted.contentType ?? (isJson ? "application/json" : "application/octet-stream")
            : null,
      },
      text: async () => text,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

function config(overrides: Partial<BaiduPanSettings> = {}): BaiduPanSettings {
  return {
    ...defaultBaiduPanSettings(),
    enabled: true,
    ...FAKE,
    expiresAt: Date.parse("2026-12-31T00:00:00Z"),
    ...overrides,
  };
}

function clientWith(
  responses: Array<{ status?: number; body: unknown; contentType?: string }>,
  overrides: Partial<BaiduPanSettings> = {},
  extra: Partial<ConstructorParameters<typeof BaiduPanClient>[0]> = {}
) {
  const mock = createFetchMock(responses);
  const cfg = config(overrides);
  const client = new BaiduPanClient({
    config: cfg,
    fetchImpl: mock.fetchImpl,
    now: () => new Date("2026-10-16T00:00:00Z"),
    sleepImpl: async () => undefined,
    ...extra,
  });
  return { client, calls: mock.calls, cfg, fetchImpl: mock.fetchImpl };
}

// ------------------------------------------------------------------ OAuth

test("授权码换 token：URL 参数正确，expires_in 秒换算为绝对毫秒时间戳", async () => {
  const { client, calls } = clientWith([
    {
      body: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 2592000,
        scope: "basic netdisk",
      },
    },
  ]);
  const tokens = await client.exchangeAuthorizationCode("fake-code", "oob");
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://openapi.baidu.com/oauth/2.0/token");
  assert.equal(url.searchParams.get("grant_type"), "authorization_code");
  assert.equal(url.searchParams.get("code"), "fake-code");
  assert.equal(url.searchParams.get("client_id"), FAKE.appKey);
  assert.equal(url.searchParams.get("client_secret"), FAKE.secretKey);
  assert.equal(url.searchParams.get("redirect_uri"), "oob");
  assert.equal(tokens.accessToken, "new-access");
  assert.equal(tokens.refreshToken, "new-refresh");
  // 30 天 = 2592000 秒
  assert.equal(tokens.expiresAt, Date.parse("2026-10-16T00:00:00Z") + 2592000 * 1000);
});

test("刷新后新的 refresh_token 被保存到配置，并通过 onTokens 通知调用方落盘", async () => {
  const saved: Array<string> = [];
  const { client, calls, cfg } = clientWith(
    [{ body: { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 2592000 } }],
    {},
    { onTokens: (tokens) => void saved.push(tokens.refreshToken) }
  );
  const tokens = await client.refreshTokens();
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("grant_type"), "refresh_token");
  assert.equal(url.searchParams.get("refresh_token"), FAKE.refreshToken);
  // 配置被就地更新（main.ts 随后 saveHiWordsSettings 落盘）
  assert.equal(cfg.accessToken, "rotated-access");
  assert.equal(cfg.refreshToken, "rotated-refresh");
  assert.equal(tokens.refreshToken, "rotated-refresh");
  assert.deepEqual(saved, ["rotated-refresh"]);
});

test("刷新响应未带新 refresh_token 时保留旧值，不把可用凭证清空", async () => {
  const { client, cfg } = clientWith([{ body: { access_token: "only-access", expires_in: 100 } }]);
  await client.refreshTokens();
  assert.equal(cfg.accessToken, "only-access");
  assert.equal(cfg.refreshToken, FAKE.refreshToken);
});

test("缺少 refresh_token 时刷新抛可读错误（不触网）", async () => {
  const { client, calls } = clientWith([{ body: {} }], { refreshToken: "" });
  await assert.rejects(
    () => client.refreshTokens(),
    (error: unknown) => error instanceof BaiduPanError && error.kind === "auth" && /refresh_token/.test(error.message)
  );
  assert.equal(calls.length, 0);
});

test("OAuth 错误体（invalid_grant）转成可读错误且不泄露 secret", async () => {
  const { client } = clientWith([
    { body: { error: "invalid_grant", error_description: "Authorization code has expired" } },
  ]);
  await assert.rejects(
    () => client.exchangeAuthorizationCode("expired-code"),
    (error: unknown) => {
      assert.ok(error instanceof BaiduPanError);
      assert.equal(error.kind, "auth");
      assert.match(error.message, /invalid_grant/);
      assert.doesNotMatch(error.message, new RegExp(FAKE.secretKey));
      return true;
    }
  );
});

test("过期判断：30 天有效期 + 5 分钟余量，expiresAt=0 视为过期", async () => {
  const nowMs = Date.parse("2026-10-16T00:00:00Z");
  const fresh = clientWith([{ body: {} }], { expiresAt: nowMs + 30 * 24 * 3600 * 1000 }).client;
  assert.equal(fresh.isTokenExpired(), false);
  assert.equal(fresh.hasUsableToken(), true);

  // 只剩 1 分钟：落在 5 分钟余量内，按已过期处理
  const nearlyExpired = clientWith([{ body: {} }], { expiresAt: nowMs + 60 * 1000 }).client;
  assert.equal(nearlyExpired.isTokenExpired(), true);

  const never = clientWith([{ body: {} }], { expiresAt: 0, accessToken: "" }).client;
  assert.equal(never.isTokenExpired(), true);
  assert.equal(never.hasUsableToken(), false);
});

test("ensureFreshToken 仅在过期时刷新", async () => {
  const notExpired = clientWith([{ body: {} }]).client;
  assert.equal(await notExpired.ensureFreshToken(), false);

  const { client, calls } = clientWith(
    [{ body: { access_token: "refreshed", refresh_token: "r2", expires_in: 2592000 } }],
    { expiresAt: 1 }
  );
  assert.equal(await client.ensureFreshToken(), true);
  assert.equal(calls.length, 1);
});

// ----------------------------------------------------------------- listDir

test("listDir：GET + method=list，解析目录/文件条目与秒级 mtime", async () => {
  const { client, calls } = clientWith([
    {
      body: {
        errno: 0,
        list: [
          {
            fs_id: 111,
            path: "/apps/NoteBar/Words",
            server_filename: "Words",
            isdir: 1,
            server_mtime: 1691048365,
          },
          {
            fs_id: 222,
            path: "/apps/NoteBar/Words/AI.canvas",
            server_filename: "AI.canvas",
            isdir: 0,
            size: 1234,
            server_mtime: 1691048400,
            md5: "abc",
          },
        ],
      },
    },
  ]);
  const entries = await client.listDir("/apps/NoteBar/Words");
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("method"), "list");
  assert.equal(url.searchParams.get("dir"), "/apps/NoteBar/Words");
  assert.equal(url.searchParams.get("order"), "time");
  assert.equal(url.searchParams.get("desc"), "1");
  assert.equal(url.searchParams.get("access_token"), FAKE.accessToken);
  assert.equal((calls[0].init as RequestInit).method, "GET");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].isDir, true);
  assert.equal(entries[1].isDir, false);
  assert.equal(entries[1].name, "AI.canvas");
  assert.equal(entries[1].size, 1234);
  assert.equal(entries[1].serverMtimeMs, 1691048400_000);
});

test("listDir 的 limit 被夹到文档建议的 1..1000，start 不为负", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0, list: [] } }]);
  await client.listDir("/apps/NoteBar/Words", { limit: 99999, start: -5 });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("limit"), "1000");
  assert.equal(url.searchParams.get("start"), "0");

  const { client: client2, calls: calls2 } = clientWith([{ body: { errno: 0, list: [] } }]);
  await client2.listDir("/apps/NoteBar/Words", { limit: 0 });
  assert.equal(new URL(calls2[0].url).searchParams.get("limit"), "1");
});

// -------------------------------------------------------------- 单步上传

test("单步上传：multipart + method=upload，path/ondup/access_token 在 query 中，解析响应", async () => {
  const { client, calls } = clientWith([
    { body: { errno: 0, path: "/apps/NoteBar/Words/AI.canvas", fs_id: 9, size: 10, md5: "m" } },
  ]);
  const entry = await client.uploadFile("/apps/NoteBar/Words/AI.canvas", new TextEncoder().encode("{}"), {
    ondup: "overwrite",
  });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/rest/2.0/pcs/file");
  assert.equal(url.searchParams.get("method"), "upload");
  assert.equal(url.searchParams.get("path"), "/apps/NoteBar/Words/AI.canvas");
  assert.equal(url.searchParams.get("ondup"), "overwrite");
  assert.equal(url.searchParams.get("access_token"), FAKE.accessToken);
  const init = calls[0].init as RequestInit;
  assert.equal(init.method, "POST");
  assert.ok(init.body instanceof FormData);
  // Content-Type 必须交给 FormData/fetch 生成 boundary，不能手工写死
  assert.equal((init.headers as Record<string, string>) ["Content-Type"], undefined);
  assert.equal((init.headers as Record<string, string>)["User-Agent"], "pan.baidu.com");
  assert.equal(entry.path, "/apps/NoteBar/Words/AI.canvas");
  assert.equal(entry.fsId, 9);
});

test("单步上传超过 2GB 上限时直接拒绝（不触网）", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0 } }]);
  const huge = new Uint8Array(0);
  Object.defineProperty(huge, "byteLength", { value: 2 * 1024 * 1024 * 1024 + 1 });
  await assert.rejects(
    () => client.uploadFile("/apps/NoteBar/Words/big.canvas", huge),
    (error: unknown) => error instanceof BaiduPanError && /分片上传/.test(error.message)
  );
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ 下载

test("下载：先 filemetas(target, dlink=1) 再带 access_token 与 User-Agent 取字节", async () => {
  const metaBody = {
    errno: 0,
    info: [{ fs_id: 1, path: "/apps/NoteBar/Words/AI.canvas", server_filename: "AI.canvas", dlink: "https://d.pcs.baidu.com/file/abc?fid=1" }],
  };
  const payload = "canvas-bytes";
  const { client, calls } = clientWith(
    [{ body: metaBody }, { body: payload, contentType: "application/octet-stream" }],
    {},
    {}
  );
  const bytes = await client.downloadFile("/apps/NoteBar/Words/AI.canvas");
  const metaUrl = new URL(calls[0].url);
  assert.equal(metaUrl.searchParams.get("method"), "filemetas");
  assert.equal((calls[0].init as RequestInit).method, "POST");
  const metaBodySent = String((calls[0].init as RequestInit).body);
  assert.match(metaBodySent, /target=%5B%22%2Fapps%2FNoteBar%2FWords%2FAI.canvas%22%5D/);
  assert.match(metaBodySent, /dlink=1/);

  const downloadUrl = new URL(calls[1].url);
  assert.equal(downloadUrl.origin + downloadUrl.pathname, "https://d.pcs.baidu.com/file/abc");
  assert.equal(downloadUrl.searchParams.get("fid"), "1");
  assert.equal(downloadUrl.searchParams.get("access_token"), FAKE.accessToken);
  assert.equal((calls[1].init as RequestInit).headers!["User-Agent" as never], "pan.baidu.com");
  assert.equal(new TextDecoder().decode(bytes), payload);
});

test("下载返回 JSON 错误体时抛出可读错误（不会把 JSON 当文件写盘）", async () => {
  const { client } = clientWith([
    { body: { errno: 0, info: [{ path: "/apps/NoteBar/Words/x.canvas", dlink: "https://d.pcs.baidu.com/f" }] } },
    { body: { errno: 31360, show_msg: "download link expired" }, contentType: "application/json" },
  ]);
  await assert.rejects(
    () => client.downloadFile("/apps/NoteBar/Words/x.canvas"),
    (error: unknown) =>
      error instanceof BaiduPanError && error.errno === 31360 && /下载链接已过期/.test(error.message)
  );
});

test("未取得 dlink 时抛出可读错误", async () => {
  const { client } = clientWith([{ body: { errno: 0, info: [{ path: "/apps/NoteBar/Words/x.canvas" }] } }]);
  await assert.rejects(
    () => client.downloadFile("/apps/NoteBar/Words/x.canvas"),
    (error: unknown) => error instanceof BaiduPanError && /dlink/.test(error.message)
  );
});

// ------------------------------------------------ 建目录 / 删除 / 容量

test("createFolder：POST method=create + isdir=1；目录已存在（-8）视为成功", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0, fs_id: 1 } }, { body: { errno: -8 } }]);
  await client.createFolder("/apps/NoteBar/Words");
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("method"), "create");
  const body = new URLSearchParams(String((calls[0].init as RequestInit).body));
  assert.equal(body.get("path"), "/apps/NoteBar/Words");
  assert.equal(body.get("isdir"), "1");
  // 幂等：已存在不抛错
  await client.createFolder("/apps/NoteBar/Words");
});

test("ensureFolder 只建沙箱根之下的一级目录（/apps/<dir> 由平台自动生成，不能自建）", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0 } }]);
  await client.ensureFolder("/apps/NoteBar/Words");
  // 只发一次 create，path 为 /apps/NoteBar/Words；绝不能给 /apps 或 /apps/NoteBar 发创建请求
  assert.equal(calls.length, 1);
  const body = new URLSearchParams(String((calls[0].init as RequestInit).body));
  assert.equal(body.get("path"), "/apps/NoteBar/Words");
  assert.equal(body.get("isdir"), "1");
});

test("ensureFolder 支持多级子目录，且仍然不触碰 /apps 自身", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0 } }]);
  await client.ensureFolder("/apps/NoteBar/Words/2026");
  const paths = calls.map((call) => new URLSearchParams(String((call.init as RequestInit).body)).get("path"));
  assert.deepEqual(paths, ["/apps/NoteBar/Words", "/apps/NoteBar/Words/2026"]);
});

test("ensureFolder 对沙箱根自身是空操作（该目录已由平台创建）", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0 } }]);
  await client.ensureFolder("/apps/NoteBar");
  assert.equal(calls.length, 0);
});

test("ensureFolder 对越界路径仍然抛沙箱错误（不静默）", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0 } }]);
  await assert.rejects(
    () => client.ensureFolder("/apps/OtherApp/Words"),
    (error: unknown) => error instanceof BaiduPanSandboxError
  );
  assert.equal(calls.length, 0);
});

test("deleteFile：POST method=filemanager&opera=delete，filelist 为 JSON 数组", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0, info: [{ errno: 0 }] } }]);
  await client.deleteFile("/apps/NoteBar/Words/AI.canvas");
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("method"), "filemanager");
  assert.equal(url.searchParams.get("opera"), "delete");
  const body = new URLSearchParams(String((calls[0].init as RequestInit).body));
  assert.deepEqual(JSON.parse(body.get("filelist")!), ["/apps/NoteBar/Words/AI.canvas"]);
});

test("getQuota：GET /api/quota 并解析容量字段", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0, total: 100, used: 40, free: 60 } }]);
  const quota = await client.getQuota();
  assert.equal(new URL(calls[0].url).pathname, "/api/quota");
  assert.deepEqual(quota, { total: 100, used: 40, free: 60 });
});

// ------------------------------------------------------------------ 沙箱

test("沙箱：/apps/ 之外的路径一律抛 BaiduPanSandboxError，且绝不发请求", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0 } }]);
  const outside = [
    "/我的文档/a.canvas",
    "/apps/OtherApp/Words/a.canvas",
    "/apps",
    "/",
  ];
  for (const target of outside) {
    await assert.rejects(
      () => client.uploadFile(target, new Uint8Array([1])),
      (error: unknown) => error instanceof BaiduPanSandboxError,
      `应拒绝：${target}`
    );
  }
  await assert.rejects(
    () => client.listDir("/etc"),
    (error: unknown) => error instanceof BaiduPanSandboxError
  );
  await assert.rejects(
    () => client.deleteFile("/apps/NoteBar2/x"),
    (error: unknown) => error instanceof BaiduPanSandboxError
  );
  // 越界在本地就被拦下：一个请求都没发出去
  assert.equal(calls.length, 0);
});

test("沙箱：`..` 逃逸被规范化后拒绝", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0 } }]);
  await assert.rejects(
    () => client.uploadFile("/apps/NoteBar/../OtherApp/x.canvas", new Uint8Array([1])),
    (error: unknown) => error instanceof BaiduPanSandboxError
  );
  await assert.rejects(
    () => client.uploadFile("/apps/NoteBar/Words/../../../etc/passwd", new Uint8Array([1])),
    (error: unknown) => error instanceof BaiduPanError
  );
  assert.equal(calls.length, 0);
});

test("沙箱：允许 /apps/<dir> 自身与其子路径下的读写", async () => {
  const { client } = clientWith([{ body: { errno: 0, list: [] } }]);
  assert.equal(client.sandboxRoot, "/apps/NoteBar");
  assert.equal(client.wordsDir, "/apps/NoteBar/Words");
  await client.listDir("/apps/NoteBar");
  await client.listDir("/apps/NoteBar/Words/Nested");
});

test("normalizePanPath：折叠重复斜杠、解析 . 与 ..、去掉末尾斜杠", () => {
  assert.equal(normalizePanPath("/apps/NoteBar//Words/"), "/apps/NoteBar/Words");
  assert.equal(normalizePanPath("/apps/./NoteBar/./Words"), "/apps/NoteBar/Words");
  assert.equal(normalizePanPath("/apps/NoteBar/Words/../Words"), "/apps/NoteBar/Words");
  assert.throws(() => normalizePanPath("apps/NoteBar"), (error: unknown) => error instanceof BaiduPanError);
  assert.throws(() => normalizePanPath("/../x"), (error: unknown) => error instanceof BaiduPanError);
});

test("自定义 dir 决定沙箱根（越界判定随之变化）", async () => {
  const { client } = clientWith([{ body: { errno: 0, list: [] } }], { dir: "MyApp" });
  assert.equal(client.sandboxRoot, "/apps/MyApp");
  assert.equal(client.wordsDir, "/apps/MyApp/Words");
  await assert.rejects(
    () => client.listDir("/apps/NoteBar/Words"),
    (error: unknown) => error instanceof BaiduPanSandboxError
  );
});

// ------------------------------------------------------ errno 与退避重试

test("errno 转可读信息：已知码给中文解释，未知码回落到 errmsg", () => {
  assert.match(describeErrno(45018), /未认证/);
  assert.match(describeErrno(-6), /身份验证失败/);
  assert.match(describeErrno(31064), /\/apps\//);
  assert.match(describeErrno(31034), /频控/);
  assert.match(describeErrno(99999, "some detail"), /99999.*some detail/);
});

test("错误信息里的凭证被抹掉（绝不写日志/Notice）", () => {
  const message = sanitizeMessage(`失败 token=${FAKE.accessToken} key=${FAKE.appKey}`, [
    FAKE.accessToken,
    FAKE.appKey,
  ]);
  assert.doesNotMatch(message, new RegExp(FAKE.accessToken));
  assert.doesNotMatch(message, new RegExp(FAKE.appKey));
  assert.match(message, /\*\*\*/);
});

test("接口返回 errno=45018（未认证）时给出可读错误，并先刷新 token 重放一次", async () => {
  const { client, calls } = clientWith([
    { body: { errno: 45018, errmsg: "unauthorized" } },
    { body: { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 2592000 } },
    { body: { errno: 0, list: [] } },
  ]);
  const entries = await client.listDir("/apps/NoteBar/Words");
  assert.deepEqual(entries, []);
  // 第 1 次失败 → 第 2 次刷新 → 第 3 次带新 token 重放
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[1].url).searchParams.get("grant_type"), "refresh_token");
  assert.equal(new URL(calls[2].url).searchParams.get("access_token"), "fresh-access");
});

test("鉴权失败且无 refresh_token 时直接抛可读错误（不无限重试）", async () => {
  const { client, calls } = clientWith([{ body: { errno: -6, errmsg: "Invalid Bduss" } }], {
    refreshToken: "",
  });
  await assert.rejects(
    () => client.listDir("/apps/NoteBar/Words"),
    (error: unknown) => error instanceof BaiduPanError && /身份验证失败/.test(error.message)
  );
  assert.equal(calls.length, 1);
});

test("频率限制（31034）指数退避后重试，退避时长可注入", async () => {
  const delays: number[] = [];
  const { client, calls } = clientWith(
    [{ body: { errno: 31034, errmsg: "hit freq limit" } }, { body: { errno: 0, list: [] } }],
    {},
    { sleepImpl: async (ms: number) => void delays.push(ms), rateLimitBaseDelayMs: 1000 }
  );
  await client.listDir("/apps/NoteBar/Words");
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [1000]);
});

test("频率限制重试次数用尽后抛 rate-limit 错误（不耗尽配额继续重试）", async () => {
  const { client, calls } = clientWith([{ body: { errno: 20012, show_msg: "访问超限" } }], {}, {
    rateLimitMaxRetries: 1,
    sleepImpl: async () => undefined,
  });
  await assert.rejects(
    () => client.listDir("/apps/NoteBar/Words"),
    (error: unknown) => error instanceof BaiduPanError && error.kind === "rate-limit" && error.errno === 20012
  );
  assert.equal(calls.length, 2);
});

test("网络异常按指数退避重试，用尽后抛 network 错误", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const client = new BaiduPanClient({
    config: config(),
    fetchImpl: async () => {
      attempts++;
      throw new Error("ECONNRESET");
    },
    now: () => new Date("2026-10-16T00:00:00Z"),
    sleepImpl: async (ms: number) => void delays.push(ms),
    transientMaxRetries: 2,
    transientBaseDelayMs: 10,
  });
  await assert.rejects(
    () => client.listDir("/apps/NoteBar/Words"),
    (error: unknown) => error instanceof BaiduPanError && error.kind === "network"
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("HTTP 5xx 也会退避重试", async () => {
  const { client, calls } = clientWith(
    [{ status: 503, body: { errno: 0 } }, { body: { errno: 0, list: [] } }],
    {},
    { transientBaseDelayMs: 1 }
  );
  const entries = await client.listDir("/apps/NoteBar/Words");
  assert.deepEqual(entries, []);
  assert.equal(calls.length, 2);
});

test("未知 errno 归类为 api 错误并保留 errno 供上层判断", async () => {
  const { client } = clientWith([{ body: { errno: 12345, errmsg: "weird" } }]);
  await assert.rejects(
    () => client.listDir("/apps/NoteBar/Words"),
    (error: unknown) =>
      error instanceof BaiduPanError && error.kind === "api" && error.errno === 12345
  );
});

test("所有业务请求都带 User-Agent: pan.baidu.com（否则 31326 防盗链）", async () => {
  const { client, calls } = clientWith([{ body: { errno: 0, list: [] } }]);
  await client.listDir("/apps/NoteBar/Words");
  assert.equal((calls[0].init as RequestInit).headers!["User-Agent" as never], "pan.baidu.com");
});

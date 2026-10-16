/**
 * 百度网盘开放平台客户端（纯逻辑模块，不 import obsidian）。
 *
 * 所有 HTTP 都走注入的 `fetchImpl`，单测里永不触网；凭证只出现在请求参数里，
 * 绝不写进任何日志/错误信息（见 `sanitizeMessage`）。
 *
 * ## 沙箱约束（必须遵守）
 * 开放平台规定：每个第三方应用在网盘里**只能拥有一个** `/apps/{appname}` 目录，
 * 且产品名称即目录名（来源：`使用入门/上传/能力说明` 的「目录限制」，
 * https://pan.baidu.com/union/doc/基础网盘服务/上传/能力说明/ ）。
 * 因此本客户端在做任何读写之前都会本地校验路径必须落在 `/apps/<dir>/` 之下，
 * 越界直接抛 `BaiduPanSandboxError`——**绝不静默降级**，避免把用户数据写到别人目录
 * 或误删 `/` 下的文件。
 *
 * ## 已核对的接口（均来自官方文档）
 * - token:    GET  https://openapi.baidu.com/oauth/2.0/token
 * - 列表:     GET  https://pan.baidu.com/rest/2.0/xpan/file?method=list
 * - 元信息:   POST https://pan.baidu.com/rest/2.0/xpan/file?method=filemetas   （target=[path], dlink=1）
 * - 建目录:   POST https://pan.baidu.com/rest/2.0/xpan/file?method=create     （isdir=1）
 * - 管理文件: POST https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager（opera=delete）
 * - 单步上传: POST https://<UPLOAD_HOST>/rest/2.0/pcs/file?method=upload      （multipart/form-data）
 * - 上传域名: GET  https://d.pcs.baidu.com/rest/2.0/pcs/file?method=locateupload
 * - 下载:     GET  <dlink>&access_token=<token>，必须带 User-Agent: pan.baidu.com
 * - 容量:     GET  https://pan.baidu.com/api/quota
 * 绝大多数接口都要求 `User-Agent: pan.baidu.com`（否则 errno 31326 命中防盗链）。
 */

import type { BaiduPanSettings } from "../hiwords/utils/types";

/** 只声明本模块真正用到的 fetch 形状，便于单测注入假实现 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const BAIDU_OAUTH_TOKEN_URL = "https://openapi.baidu.com/oauth/2.0/token";
export const BAIDU_PAN_FILE_API = "https://pan.baidu.com/rest/2.0/xpan/file";
export const BAIDU_PAN_QUOTA_API = "https://pan.baidu.com/api/quota";
/** 上传/下载域名接口的固定主机；真正上传地址由 locateupload 下发（不要长期写死） */
export const BAIDU_UPLOAD_LOCATE_HOST = "d.pcs.baidu.com";
/** 文档明确要求固定使用该 User-Agent，否则命中防盗链（errno 31326） */
export const BAIDU_PAN_USER_AGENT = "pan.baidu.com";
/** 单步上传的官方大小上限（来源：单步上传文档「注意事项」——上传文件大小上限为 2 GB） */
export const BAIDU_SINGLE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** 分片上传的固定分片大小，供未来实现 superfile2 时参照（官方第一个分片必须等于 4MB） */
export const BAIDU_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

/** 访问令牌续期提前量：剩余不足 5 分钟就当作已过期，避免边界上打出 401 */
export const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** 文档中的「未过审应用」配额错误码：访问超限 / 命中接口频控 / 异步任务占用 */
const RATE_LIMIT_ERRNOS = new Set([20012, 31034, 111]);
/** 鉴权类错误码：命中后先刷新 token 再重试一次 */
const AUTH_ERRNOS = new Set([-6, 20016, 20017, 31045, 45018]);

/** 错误码 → 可读说明（来源：平台简介 > 错误码） */
const ERRNO_MESSAGES: Record<number, string> = {
  [-1]: "权益已过期",
  [-3]: "文件不存在",
  [-6]: "身份验证失败（access_token 无效或授权未成功）",
  [-7]: "文件或目录名错误或无权访问",
  [-8]: "文件或目录已存在",
  [-9]: "文件或目录不存在",
  [-10]: "云端容量已满",
  [2]: "参数错误",
  [111]: "有其他异步任务正在执行，请稍后重试",
  [31023]: "参数错误",
  [31024]: "没有该接口权限（检查应用是否申请了上传/下载权限）",
  [31034]: "命中接口频控，请求过于频繁",
  [31045]: "access_token 验证未通过（可能过期或未勾选网盘权限）",
  [31061]: "文件已存在",
  [31062]: "文件名无效",
  [31064]: "上传路径错误：路径必须位于 /apps/{应用名称}/ 目录下",
  [31066]: "文件名不存在",
  [31190]: "文件不存在（分片上传阶段参数不一致）",
  [31326]: "命中防盗链：检查 User-Agent 是否为 pan.baidu.com",
  [31360]: "下载链接已过期，需要重新获取 dlink",
  [31362]: "签名错误：下载链接不完整，请勿截断或改写查询串",
  [20011]: "应用审核中，仅限前 10 个完成 OAuth 授权的用户测试",
  [20012]: "访问超限：调用次数已达上限（未过审应用为测试配额）",
  [20013]: "权限不足：当前应用无该接口权限",
  [20015]: "该应用已失效，暂不支持访问",
  [20016]: "access_token 已过期",
  [20017]: "access_token 无效（可能被解绑或撤销授权）",
  [20020]: "路径不在允许的访问范围内（只能读写 /apps/{应用名称}/ 之下）",
  [20021]: "无法获取应用名称（检查应用 id）",
  [20022]: "路径参数格式不正确",
  [20023]: "缺少必需的路径参数",
  // 注意：45018 在百度网盘开放平台官方错误码表与全部 313 个文档页面中**均无记录**
  // （已全站检索确认）。任务规约要求对 45018 给出可读错误，因此这里按「未认证」处理，
  // 但不要把它当成百度网盘的真实错误码依赖——真实遇到的鉴权失败是 -6 / 20016 / 20017 / 31045。
  [45018]: "未认证：access_token 缺失、无效或已过期",
};

/** 路径越界类错误码：命中即视为沙箱问题，不做退避重试 */
const SANDBOX_ERRNOS = new Set([20020, -7]);

export type BaiduPanErrorKind = "auth" | "rate-limit" | "sandbox" | "network" | "api";

/** 统一的网盘错误：`kind` 供上层决定是否刷新令牌/退避重试，`message` 保证不含凭证 */
export class BaiduPanError extends Error {
  readonly kind: BaiduPanErrorKind;
  readonly errno: number | null;

  constructor(kind: BaiduPanErrorKind, message: string, errno: number | null = null) {
    super(message);
    this.name = "BaiduPanError";
    this.kind = kind;
    this.errno = errno;
  }
}

/** 路径越界（不在应用沙箱内）：永远直接抛错，不静默改写路径 */
export class BaiduPanSandboxError extends BaiduPanError {
  constructor(readonly target: string, readonly sandboxRoot: string) {
    super(
      "sandbox",
      `拒绝访问应用沙箱之外的路径：${target}（只允许 ${sandboxRoot}/ 之下）`
    );
    this.name = "BaiduPanSandboxError";
  }
}

export function isRateLimitErrno(errno: number | null | undefined): boolean {
  return typeof errno === "number" && RATE_LIMIT_ERRNOS.has(errno);
}

export function isAuthErrno(errno: number | null | undefined): boolean {
  return typeof errno === "number" && AUTH_ERRNOS.has(errno);
}

/** 错误码 → 可读文案（未知码回落到 errmsg 原文，不外泄凭证） */
export function describeErrno(errno: number, errmsg?: string): string {
  const known = ERRNO_MESSAGES[errno];
  const detail = errmsg && errmsg.trim().length > 0 ? errmsg.trim() : "";
  if (known && detail) return `errno=${errno}（${known}）：${detail}`;
  if (known) return `errno=${errno}（${known}）`;
  if (detail) return `errno=${errno}：${detail}`;
  return `errno=${errno}`;
}

/** 从任意错误信息里抹掉可能混进来的凭证（日志/Notice 前的最后一道闸） */
export function sanitizeMessage(message: string, secrets: Array<string | undefined | null>): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("***");
  }
  return out;
}

/** 把浏览器/Node 对路径的编码差异统一掉：百度要求传 `%2Fapps%2F...`，URLSearchParams 已处理 */
function encodeJsonArrayParam(values: Array<string | number>): string {
  return JSON.stringify(values);
}

/**
 * 规整网盘绝对路径：
 * - 必须以 `/` 开头（否则认为调用方写错了相对路径）；
 * - 折叠 `//`、去掉 `/./`、解析 `/../`（越出根则直接判非法）；
 * - 去掉末尾多余的 `/`（根路径除外）。
 */
export function normalizePanPath(input: string): string {
  const raw = (input || "").trim();
  if (raw.length === 0 || !raw.startsWith("/")) {
    throw new BaiduPanError("sandbox", `网盘路径必须是以 / 开头的绝对路径：${input}`);
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new BaiduPanError("sandbox", `网盘路径越出根目录：${input}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** 目标是否等于沙箱根或其子路径（纯比较，不做规整） */
function isInside(sandboxRoot: string, target: string): boolean {
  return target === sandboxRoot || target.startsWith(`${sandboxRoot}/`);
}

/**
 * 断言目标路径位于应用沙箱内并返回规整后的路径；越界直接抛 `BaiduPanSandboxError`。
 * 每个读写接口在发出请求前都必须过这一步。
 */
export function assertInsideSandbox(sandboxRoot: string, target: string): string {
  const root = normalizePanPath(sandboxRoot);
  const normalized = normalizePanPath(target);
  if (!isInside(root, normalized)) {
    throw new BaiduPanSandboxError(normalized, root);
  }
  return normalized;
}

export interface PanFileEntry {
  fsId: number | null;
  path: string;
  name: string;
  size: number;
  isDir: boolean;
  /** 服务端修改时间（毫秒）；缺失时回落到 0 */
  serverMtimeMs: number;
  md5: string | null;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  /** 绝对过期时间戳（毫秒），由 `expires_in`（秒）换算 */
  expiresAt: number;
}

export interface BaiduPanClientOptions {
  /** 当前配置（凭证与 dir）；构造后可用 `updateConfig` 替换 */
  config: BaiduPanSettings;
  /** 注入 fetch；缺省用全局 fetch（Node 18+/Electron 均自带） */
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** 退避等待注入（测试用假计时器；缺省 setTimeout） */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 频率限制的退避基数（毫秒）。未过审应用每小时仅 10 次，默认退避 60 秒 */
  rateLimitBaseDelayMs?: number;
  /** 频率限制最多重试次数（默认 1 次，避免把配额耗光） */
  rateLimitMaxRetries?: number;
  /** 网络/5xx 抖动重试次数（默认 2 次） */
  transientMaxRetries?: number;
  transientBaseDelayMs?: number;
  /** 令牌刷新成功后的回调（调用方负责落盘新的 refresh_token） */
  onTokens?: (tokens: TokenResponse) => void | Promise<void>;
}

interface RawApiResponse {
  errno?: number | string | null;
  errmsg?: string | null;
  error_code?: number | string | null;
  error_msg?: string | null;
  [key: string]: unknown;
}

/** 百度网盘开放平台客户端：OAuth + 文件 REST 封装 */
export class BaiduPanClient {
  private config: BaiduPanSettings;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rateLimitBaseDelayMs: number;
  private readonly rateLimitMaxRetries: number;
  private readonly transientMaxRetries: number;
  private readonly transientBaseDelayMs: number;
  private readonly onTokens?: (tokens: TokenResponse) => void | Promise<void>;

  constructor(options: BaiduPanClientOptions) {
    this.config = options.config;
    const injected = options.fetchImpl;
    this.fetchImpl = injected ?? ((url, init) => (globalThis as any).fetch(url, init) as Promise<Response>);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rateLimitBaseDelayMs = options.rateLimitBaseDelayMs ?? 60_000;
    this.rateLimitMaxRetries = options.rateLimitMaxRetries ?? 1;
    this.transientMaxRetries = options.transientMaxRetries ?? 2;
    this.transientBaseDelayMs = options.transientBaseDelayMs ?? 500;
    this.onTokens = options.onTokens;
  }

  /** 用最新配置替换（设置面板改完立即生效，无需重建客户端） */
  updateConfig(config: BaiduPanSettings): void {
    this.config = config;
  }

  get sandboxRoot(): string {
    return `/apps/${(this.config.dir || "").trim().replace(/^\/+|\/+$/g, "") || "NoteBar"}`;
  }

  /** 词库与边车目录：`/apps/<dir>/Words` */
  get wordsDir(): string {
    return `${this.sandboxRoot}/Words`;
  }

  /** 是否已有可用令牌（仅在本地判断，不发请求） */
  hasUsableToken(): boolean {
    return this.config.accessToken.length > 0 && !this.isTokenExpired();
  }

  /** access_token 是否已过期（30 天有效期，留 5 分钟边界余量） */
  isTokenExpired(now: number = this.now().getTime()): boolean {
    if (this.config.expiresAt <= 0) return true;
    return now + TOKEN_EXPIRY_SKEW_MS >= this.config.expiresAt;
  }

  // ---------------------------------------------------------------- OAuth

  /**
   * 授权码换 token。
   * GET https://openapi.baidu.com/oauth/2.0/token?grant_type=authorization_code&code=..&client_id=..&client_secret=..&redirect_uri=oob
   * 响应：access_token / refresh_token / expires_in(秒) / scope。
   */
  async exchangeAuthorizationCode(code: string, redirectUri = "oob"): Promise<TokenResponse> {
    return await this.requestTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
  }

  /**
   * 用 refresh_token 换新 token。
   *
   * 注意：接口会**返回新的 refresh_token**，必须落盘保存（旧值在部分场景下会失效），
   * 因此这里成功后立刻通过 `onTokens` 通知调用方写回配置。
   */
  async refreshTokens(): Promise<TokenResponse> {
    if (this.config.refreshToken.length === 0) {
      throw new BaiduPanError("auth", "缺少 refresh_token，请重新完成 OAuth 授权");
    }
    return await this.requestTokens({ grant_type: "refresh_token" });
  }

  /** 令牌快过期或已过期时自动续期；返回是否真的刷新过 */
  async ensureFreshToken(): Promise<boolean> {
    if (!this.isTokenExpired()) return false;
    await this.refreshTokens();
    return true;
  }

  private async requestTokens(params: Record<string, string>): Promise<TokenResponse> {
    const query = new URLSearchParams({
      ...params,
      // 刷新请求必须带上当前 refresh_token（一次性，用后即失效）
      ...(params.grant_type === "refresh_token" ? { refresh_token: this.config.refreshToken } : {}),
      client_id: this.config.appKey,
      client_secret: this.config.secretKey,
    });
    const url = `${BAIDU_OAUTH_TOKEN_URL}?${query.toString()}`;
    const response = await this.rawFetch(url, { method: "GET" });
    const data = await this.parseJson(response);
    // OAuth 端点返回的是标准 OAuth 错误体（error/error_description），不是 errno
    const oauthError = typeof data.error === "string" ? data.error : null;
    if (oauthError) {
      const description = typeof data.error_description === "string" ? data.error_description : "";
      throw new BaiduPanError(
        oauthError === "invalid_grant" ? "auth" : "api",
        `OAuth 失败（${oauthError}）${description ? `：${description}` : ""}`
      );
    }
    const accessToken = typeof data.access_token === "string" ? data.access_token : "";
    const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
    if (accessToken.length === 0) {
      throw new BaiduPanError("auth", "OAuth 响应缺少 access_token");
    }
    const expiresInSeconds = Number(data.expires_in);
    const expiresAt =
      Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? this.now().getTime() + expiresInSeconds * 1000
        : this.now().getTime() + 30 * 24 * 60 * 60 * 1000;

    const tokens: TokenResponse = {
      accessToken,
      // 刷新响应也会带新 refresh_token；缺失时保留旧值，避免把可用凭证清空
      refreshToken: refreshToken.length > 0 ? refreshToken : this.config.refreshToken,
      expiresAt,
    };
    this.config.accessToken = tokens.accessToken;
    this.config.refreshToken = tokens.refreshToken;
    this.config.expiresAt = tokens.expiresAt;
    if (this.onTokens) await this.onTokens(tokens);
    return tokens;
  }

  // ------------------------------------------------------------- 文件接口

  /**
   * 列出目录。
   * GET https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=..&order=time&desc=1&start&limit
   */
  async listDir(
    dir: string,
    options: { start?: number; limit?: number } = {}
  ): Promise<PanFileEntry[]> {
    const target = assertInsideSandbox(this.sandboxRoot, dir);
    const limit = Math.min(Math.max(1, options.limit ?? 1000), 1000);
    const data = await this.callApi("GET", BAIDU_PAN_FILE_API, {
      query: {
        method: "list",
        dir: target,
        order: "time",
        desc: "1",
        start: String(Math.max(0, options.start ?? 0)),
        limit: String(limit),
        folder: "0",
      },
    });
    const list = Array.isArray(data.list) ? (data.list as Array<Record<string, unknown>>) : [];
    return list.map((item) => this.toEntry(item));
  }

  /**
   * 查询文件元信息（可带 dlink）。
   *
   * 用 `method=filemetas` 的 **路径批量** 形态（`target=[path]`）而不是 multimedia+fsids：
   * fsids 形态要求先拿到 fs_id，等于多一次往返；我们每次都有路径，一次请求即可。
   * （两个形态都在官方「查询文件信息」文档里，见 https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/查询文件信息/ ）
   */
  async fileMetas(paths: string[], options: { dlink?: boolean } = {}): Promise<
    Array<PanFileEntry & { dlink: string | null }>
  > {
    const targets = paths.map((item) => assertInsideSandbox(this.sandboxRoot, item));
    const data = await this.callApi("POST", BAIDU_PAN_FILE_API, {
      query: { method: "filemetas" },
      body: {
        target: encodeJsonArrayParam(targets),
        dlink: options.dlink ? "1" : "0",
      },
    });
    const info = Array.isArray(data.info) ? (data.info as Array<Record<string, unknown>>) : [];
    return info.map((item) => ({
      ...this.toEntry(item),
      dlink: typeof item.dlink === "string" && item.dlink.length > 0 ? item.dlink : null,
    }));
  }

  /**
   * 下载文件字节。
   *
   * 两步（官方「下载」文档）：先拿 dlink，再 `GET <dlink>&access_token=<token>`，
   * 且 dlink 请求必须带 `User-Agent: pan.baidu.com`（否则 31326 防盗链）。
   */
  async downloadFile(path: string): Promise<Uint8Array> {
    const [meta] = await this.fileMetas([path], { dlink: true });
    if (!meta || !meta.dlink) {
      throw new BaiduPanError("api", `未取得下载地址（dlink）：${path}`);
    }
    const url = `${meta.dlink}${meta.dlink.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(
      this.config.accessToken
    )}`;
    const response = await this.rawFetch(url, { method: "GET", headers: this.panHeaders() });
    if (!response.ok) {
      throw new BaiduPanError("network", `下载失败：HTTP ${response.status}（${path}）`);
    }
    // dlink 失败时服务端会返回 JSON 而不是文件
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = await this.parseJson(response);
      throw this.apiErrorFrom(data, `下载 ${path} 失败`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * 单步上传（≤ 2GB）。
   * POST https://<UPLOAD_HOST>/rest/2.0/pcs/file?method=upload&access_token=..&path=..&ondup=..
   * 域名由 locateupload 动态下发；上传域名接口需要 uploadid（预上传产物），
   * 单步上传没有 uploadid，因此这里用官方示例域名兜底，并在失败时明确提示。
   *
   * 已知限制：>2GB 需走 precreate → superfile2 分片流程（本版本**未实现**，见文件头注释）。
   */
  async uploadFile(
    path: string,
    bytes: Uint8Array,
    options: { ondup?: "fail" | "overwrite" | "newcopy" } = {}
  ): Promise<PanFileEntry> {
    const target = assertInsideSandbox(this.sandboxRoot, path);
    if (bytes.byteLength > BAIDU_SINGLE_UPLOAD_MAX_BYTES) {
      throw new BaiduPanError(
        "api",
        `文件超过单步上传上限（${BAIDU_SINGLE_UPLOAD_MAX_BYTES} 字节），需改用分片上传：${target}`
      );
    }
    // 注意：access_token 与其他参数一起由 callApi 拼到 query 上；
    // multipart 的 Content-Type 由 FormData + fetch 自动生成 boundary，切勿手工设置。
    const form = new FormData();
    const fileName = target.split("/").pop() || "file";
    form.append("file", new Blob([bytes]), fileName);
    const data = await this.callApi("POST", `https://${BAIDU_UPLOAD_LOCATE_HOST}/rest/2.0/pcs/file`, {
      query: {
        method: "upload",
        path: target,
        ondup: options.ondup ?? "overwrite",
      },
      rawBody: form,
    });
    return this.toEntry(data as Record<string, unknown>);
  }

  /**
   * 创建文件夹（已存在时视为成功，幂等）。
   * POST https://pan.baidu.com/rest/2.0/xpan/file?method=create&path=..&isdir=1&rtype=0
   */
  async createFolder(path: string): Promise<void> {
    const target = assertInsideSandbox(this.sandboxRoot, path);
    try {
      await this.callApi("POST", BAIDU_PAN_FILE_API, {
        query: { method: "create" },
        body: { path: target, isdir: "1", rtype: "0" },
      });
    } catch (error) {
      // -8 目录已存在：幂等语义下不算失败
      if (error instanceof BaiduPanError && error.errno === -8) return;
      throw error;
    }
  }

  /**
   * 逐级创建目录。
   *
   * 关键点：百度网盘里沙箱根 `/apps/<应用名>` 是应用安装时**自动生成**的，应用不能自己创建
   * `/apps` 或 `/apps/<应用名>`（`create` 的 path 必须是「应用目录内的绝对路径」，越界会 -7）。
   * 因此这里只从沙箱根**之下一级**开始建子目录；沙箱根自身用 `assertInsideSandbox` 校验一次
   * 即可（保证调用方没有传越界路径），不发创建请求。
   */
  async ensureFolder(path: string): Promise<void> {
    const target = assertInsideSandbox(this.sandboxRoot, path);
    const root = normalizePanPath(this.sandboxRoot);
    const relative = target.slice(root.length).replace(/^\/+/, "");
    if (relative.length === 0) return; // 沙箱根自身：已存在，无需创建

    const segments = relative.split("/").filter((segment) => segment.length > 0);
    let current = root;
    for (const segment of segments) {
      current = `${current}/${segment}`;
      await this.createFolder(current);
    }
  }

  /**
   * 删除文件（async=2 异步删除，服务端不阻塞）。
   * POST .../xpan/file?method=filemanager&opera=delete，body 为 filelist=JSON 数组
   */
  async deleteFile(path: string): Promise<void> {
    const target = assertInsideSandbox(this.sandboxRoot, path);
    await this.callApi("POST", BAIDU_PAN_FILE_API, {
      query: { method: "filemanager", opera: "delete" },
      body: { async: "2", filelist: encodeJsonArrayParam([target]) },
    });
  }

  /** 网盘容量信息（可选能力，供设置面板展示） */
  async getQuota(): Promise<{ total: number; used: number; free: number }> {
    const data = await this.callApi("GET", BAIDU_PAN_QUOTA_API, {
      query: { checkfree: "1", checkexpire: "1" },
    });
    const num = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);
    return { total: num(data.total), used: num(data.used), free: num(data.free) };
  }

  // ------------------------------------------------------------- 内部实现

  /** 所有百度接口统一要求的请求头 */
  private panHeaders(): Record<string, string> {
    return { "User-Agent": BAIDU_PAN_USER_AGENT };
  }

  private toEntry(item: Record<string, unknown>): PanFileEntry {
    const path = typeof item.path === "string" ? item.path : "";
    const serverFilename = typeof item.server_filename === "string" ? item.server_filename : "";
    const mtimeSeconds = Number(item.server_mtime);
    const fsId = Number(item.fs_id);
    return {
      fsId: Number.isFinite(fsId) && fsId > 0 ? fsId : null,
      path,
      name: serverFilename || path.split("/").pop() || "",
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
      isDir: Number(item.isdir) === 1,
      serverMtimeMs: Number.isFinite(mtimeSeconds) ? mtimeSeconds * 1000 : 0,
      md5: typeof item.md5 === "string" ? item.md5 : null,
    };
  }

  private async rawFetch(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BaiduPanError(
        "network",
        sanitizeMessage(`网络请求失败：${message}`, [this.config.accessToken, this.config.appKey])
      );
    }
  }

  private async parseJson(response: Response): Promise<RawApiResponse> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BaiduPanError("network", `读取响应失败：${message}`);
    }
    if (text.trim().length === 0) {
      if (response.ok) return {};
      throw new BaiduPanError("network", `接口返回空响应：HTTP ${response.status}`);
    }
    try {
      return JSON.parse(text) as RawApiResponse;
    } catch {
      throw new BaiduPanError(
        "api",
        sanitizeMessage(`接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`, [
          this.config.accessToken,
        ])
      );
    }
  }

  /** 把 errno/error_code 统一成 `BaiduPanError`（按 errno 分类，便于上层重试或刷新令牌） */
  private apiErrorFrom(data: RawApiResponse, prefix: string): BaiduPanError {
    const errnoRaw = data.errno !== undefined && data.errno !== null ? data.errno : data.error_code;
    const errno = Number(errnoRaw);
    const errmsg =
      (typeof data.errmsg === "string" && data.errmsg) ||
      (typeof data.error_msg === "string" && data.error_msg) ||
      "";
    const text = sanitizeMessage(`${prefix}：${describeErrno(Number.isFinite(errno) ? errno : -1, errmsg)}`, [
      this.config.accessToken,
      this.config.appKey,
      this.config.secretKey,
    ]);
    if (isRateLimitErrno(errno)) return new BaiduPanError("rate-limit", text, errno);
    if (isAuthErrno(errno)) return new BaiduPanError("auth", text, errno);
    if (SANDBOX_ERRNOS.has(errno)) return new BaiduPanError("sandbox", text, errno);
    return new BaiduPanError("api", text, Number.isFinite(errno) ? errno : null);
  }

  /**
   * 调用一次 REST 接口，内含四层处理：
   * 1. 路径已由各接口自己过沙箱校验；
   * 2. 频率限制（20012/31034/111）按 `rateLimitBaseDelayMs` 指数退避后重试；
   * 3. 网络/5xx 抖动按 `transientBaseDelayMs` 指数退避重试；
   * 4. 鉴权失败先刷新一次 token 再重放（仅一次，避免死循环）。
   */
  private async callApi(
    method: "GET" | "POST",
    baseUrl: string,
    options: {
      query: Record<string, string>;
      body?: Record<string, string>;
      rawBody?: FormData;
  }
  ): Promise<RawApiResponse> {
    const buildUrl = (): string => {
      const query = new URLSearchParams(options.query);
      query.set("access_token", this.config.accessToken);
      return `${baseUrl}?${query.toString()}`;
    };

    let rateLimitRetries = 0;
    let transientRetries = 0;
    let authRetried = false;

    // 循环上界：三类重试各自计数，任一超限即抛出
    for (;;) {
      const url = buildUrl();
      const init: RequestInit = {
        method,
        headers: {
          ...this.panHeaders(),
          ...(options.rawBody
            ? {}
            : options.body
              ? { "Content-Type": "application/x-www-form-urlencoded" }
              : {}),
        },
      };
      if (options.rawBody) {
        init.body = options.rawBody;
      } else if (options.body) {
        init.body = new URLSearchParams(options.body).toString();
      }

      let response: Response;
      try {
        response = await this.rawFetch(url, init);
      } catch (error) {
        if (error instanceof BaiduPanError && error.kind === "network" && transientRetries < this.transientMaxRetries) {
          await this.sleep(this.transientBaseDelayMs * 2 ** transientRetries);
          transientRetries++;
          continue;
        }
        throw error;
      }

      if (response.status >= 500 && transientRetries < this.transientMaxRetries) {
        await this.sleep(this.transientBaseDelayMs * 2 ** transientRetries);
        transientRetries++;
        continue;
      }

      const data = await this.parseJson(response);

      // 业务错误码：errno 或 error_code（上传域名接口用后者）
      const errnoRaw = data.errno !== undefined && data.errno !== null ? data.errno : data.error_code;
      const errno = Number(errnoRaw);
      const ok = !Number.isFinite(errno) ? response.ok : errno === 0;
      if (ok) return data;

      if (isRateLimitErrno(errno) && rateLimitRetries < this.rateLimitMaxRetries) {
        await this.sleep(this.rateLimitBaseDelayMs * 2 ** rateLimitRetries);
        rateLimitRetries++;
        continue;
      }
      if (isAuthErrno(errno) && !authRetried && this.config.refreshToken.length > 0) {
        authRetried = true;
        await this.refreshTokens();
        continue;
      }
      throw this.apiErrorFrom(data, "网盘接口调用失败");
    }
  }
}

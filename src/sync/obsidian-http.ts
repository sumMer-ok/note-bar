import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { FetchLike } from "./baidu-pan-client";

/**
 * 把 Obsidian 官方的 `requestUrl` 适配成客户端要的 fetch 形态。
 *
 * **为什么必须这么做**（2026-10-17 真机踩坑）：插件的渲染进程里 `fetch` 是 Chromium 的 fetch，
 * 受 **CORS** 约束；百度网盘 API 不会给 `app://obsidian.md` 发 CORS 头，于是所有请求直接
 * 抛 `Failed to fetch`，同步功能整体不可用（而同一份代码在 Node 里跑得好好的——Node 的
 * fetch 不做 CORS 检查，这也是它躲过单测的原因）。`requestUrl` 走 Obsidian 主进程、不受 CORS 限制。
 *
 * 另一处差异：`requestUrl` 的 body 只接受 `string | ArrayBuffer`，**不接受 FormData**，
 * 所以 multipart 由这里手工编码（boundary 自己生成，与 fetch 行为一致）。
 *
 * 本模块只从 obsidian `import type`，运行期逻辑全部是纯函数，可单测。
 */
export type RequestUrlFn = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

interface EncodedBody {
  body?: string | ArrayBuffer;
  contentType?: string;
  /** 需要从 headers 里剔除的键（Content-Type 改由 requestUrl 的 contentType 传入） */
  headerOverrides: Record<string, string>;
}

/** 生成 multipart boundary（与浏览器行为等价，只要不与内容冲突即可） */
function makeBoundary(): string {
  return `----notebar${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

/**
 * 把 FormData 编码成 multipart/form-data 字节流。
 * 仅支持字符串字段与 Blob/File 文件字段（本插件只用这两种）。
 */
export async function encodeMultipart(form: FormData): Promise<{ body: ArrayBuffer; contentType: string }> {
  const boundary = makeBoundary();
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  // 用 forEach 收集（tsconfig 的 lib 未含 DOM.Iterable，拿不到 entries()）
  const fields: Array<[string, string | File]> = [];
  form.forEach((value, key) => {
    fields.push([key, value as string | File]);
  });

  for (const [name, value] of fields) {
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
    if (typeof value === "string") {
      chunks.push(encoder.encode(`${head}\r\n\r\n${value}\r\n`));
      continue;
    }
    const file = value as File;
    const filename = typeof file.name === "string" && file.name.length > 0 ? file.name : "file";
    const type = typeof file.type === "string" && file.type.length > 0 ? file.type : "application/octet-stream";
    chunks.push(encoder.encode(`${head}; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`));
    chunks.push(new Uint8Array(await file.arrayBuffer()));
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 规整 body：FormData 走手工编码，字符串/字节原样透传；Content-Type 统一交给 requestUrl */
async function encodeBody(init: RequestInit): Promise<EncodedBody> {
  const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
  const headerOverrides: Record<string, string> = {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "content-type") {
      headerOverrides[key] = headers[key];
      delete headers[key];
    }
  }

  const body = init.body;
  if (body instanceof FormData) {
    const encoded = await encodeMultipart(body);
    return { body: encoded.body, contentType: encoded.contentType, headerOverrides };
  }
  if (typeof body === "string" || body instanceof ArrayBuffer) {
    const contentType = Object.values(headerOverrides)[0];
    return { body, contentType, headerOverrides };
  }
  return { contentType: Object.values(headerOverrides)[0], headerOverrides };
}

/** 把 requestUrl 的响应包装成客户端用到的 Response 子集（ok/status/headers.get/text/arrayBuffer） */
export function toResponseLike(res: RequestUrlResponse): Response {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    lower[key.toLowerCase()] = value;
  }
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => res.text,
    json: async () => res.json,
    arrayBuffer: async () => res.arrayBuffer,
  } as unknown as Response;
}

/** 造一个可直接注入 BaiduPanClient 的 FetchLike */
export function createObsidianFetch(requestUrl: RequestUrlFn): FetchLike {
  return async (url: string, init: RequestInit = {}) => {
    const encoded = await encodeBody(init);
    const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") delete headers[key];
    }

    const param: RequestUrlParam = {
      url,
      method: init.method ?? "GET",
      headers,
      throw: false,
    };
    if (encoded.body !== undefined) param.body = encoded.body;
    if (encoded.contentType !== undefined) param.contentType = encoded.contentType;

    const res = await requestUrl(param);
    return toResponseLike(res);
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { createObsidianFetch, encodeMultipart, toResponseLike } from "../../src/sync/obsidian-http";

/** 构造 requestUrl 的假响应 */
function fakeResponse(over: Partial<Record<string, unknown>> = {}) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    text: '{"errno":0}',
    json: { errno: 0 },
    arrayBuffer: new TextEncoder().encode('{"errno":0}').buffer,
    ...over,
  } as any;
}

test("toResponseLike 映射 ok/status/headers.get/text/arrayBuffer", async () => {
  const res = toResponseLike(fakeResponse() as any);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json", "头部名不区分大小写");
  assert.equal(await res.text(), '{"errno":0}');
  assert.equal((await res.arrayBuffer()).byteLength, 11, "响应字节应原样返回");
});

test("非 2xx 状态映射为 ok=false（客户端据此走错误分支）", () => {
  const res = toResponseLike(fakeResponse({ status: 500 }) as any);
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
});

test("encodeMultipart：boundary 一致、含文件字节与文件名", async () => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "application/json" }), "x.nb-sync.json");
  const { body, contentType } = await encodeMultipart(form);
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? "";
  assert.ok(boundary.length > 0, "contentType 必须带 boundary");
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const text = new TextDecoder().decode(new Uint8Array(body));
  assert.match(text, /name="file"; filename="x\.nb-sync\.json"/);
  assert.match(text, /Content-Type: application\/json/);
  assert.ok(text.startsWith(`--${boundary}\r\n`), "首行必须是 boundary");
  assert.ok(text.endsWith(`--${boundary}--\r\n`), "结尾必须是结束 boundary");
  const bytes = new Uint8Array(body);
  const hasFileBytes = bytes.some((_, i) => bytes[i] === 1 && bytes[i + 1] === 2 && bytes[i + 2] === 3);
  assert.equal(hasFileBytes, true, "文件字节必须原样写入 multipart body");
});

test("createObsidianFetch：GET 透传 url/method，并把响应包成 Response", async () => {
  const seen: any[] = [];
  const fetchImpl = createObsidianFetch(async (req: any) => {
    seen.push(req);
    return fakeResponse() as any;
  });
  const res = await fetchImpl("https://pan.baidu.com/rest/2.0/xpan/file?method=list", {
    method: "GET",
    headers: { "User-Agent": "pan.baidu.com" },
  });
  assert.equal(seen[0].url, "https://pan.baidu.com/rest/2.0/xpan/file?method=list");
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].headers["User-Agent"], "pan.baidu.com");
  assert.equal(res.status, 200);
});

test("createObsidianFetch：FormData 转成 ArrayBuffer + contentType，且从 headers 剔除 Content-Type", async () => {
  let captured: any = null;
  const fetchImpl = createObsidianFetch(async (req: any) => {
    captured = req;
    return fakeResponse() as any;
  });
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([9, 9])]), "a.json");
  await fetchImpl("https://d.pcs.baidu.com/rest/2.0/pcs/file?method=upload", {
    method: "POST",
    headers: { "User-Agent": "pan.baidu.com", "Content-Type": "multipart/form-data" },
    body: form,
  });
  assert.ok(captured.contentType?.startsWith("multipart/form-data; boundary="), "handled by contentType");
  assert.ok(captured.body instanceof ArrayBuffer, "body 必须是 ArrayBuffer（requestUrl 不接受 FormData）");
  assert.equal(
    Object.keys(captured.headers).some((k) => k.toLowerCase() === "content-type"),
    false,
    "Content-Type 必须从 headers 剔除，避免与 contentType 冲突"
  );
  assert.equal(captured.headers["User-Agent"], "pan.baidu.com", "其他头必须保留");
});

test("createObsidianFetch：字符串 body 原样透传，并携带 urlencoded 类型", async () => {
  let captured: any = null;
  const fetchImpl = createObsidianFetch(async (req: any) => {
    captured = req;
    return fakeResponse() as any;
  });
  await fetchImpl("https://pan.baidu.com/rest/2.0/xpan/file?method=filemetas", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: 'target=["/apps/NoteBar/Words/x.canvas"]&dlink=0',
  });
  assert.equal(captured.body, 'target=["/apps/NoteBar/Words/x.canvas"]&dlink=0');
  assert.equal(captured.contentType, "application/x-www-form-urlencoded");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendLines,
  inboxFailedPathFor,
  inboxPathFor,
  inboxStatePathFor,
  readInboxState,
  readInboxText,
  writeInboxAtomic,
  writeInboxState,
} from "../../src/sync/inbox-store";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-inbox-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("路径构造使用约定文件名", () => {
  assert.equal(inboxPathFor("/sync"), path.join("/sync", "note-bar-inbox.jsonl"));
  assert.equal(
    inboxFailedPathFor("/sync"),
    path.join("/sync", "note-bar-inbox.failed.jsonl")
  );
  assert.equal(inboxStatePathFor("/sync"), path.join("/sync", "note-bar-inbox.state.json"));
});

test("文件不存在时读取返回空串，写入会自动建目录", async () => {
  await withTempDir(async (dir) => {
    const nested = path.join(dir, "a", "b", "inbox.jsonl");
    assert.equal(await readInboxText(nested), "");
    await writeInboxAtomic(nested, '{"v":1}\n');
    assert.equal(await readInboxText(nested), '{"v":1}\n');
  });
});

test("原子写入不残留临时文件", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "inbox.jsonl");
    await writeInboxAtomic(file, "one\n");
    await writeInboxAtomic(file, "two\n");
    assert.equal(await readInboxText(file), "two\n");
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["inbox.jsonl"]);
  });
});

test("appendLines 按行追加、空数组不建文件", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "failed.jsonl");
    await appendLines(file, []);
    await assert.rejects(readdir(dir).then(() => readInboxText(file)), () => false).catch(() => undefined);
    await appendLines(file, ["a", "b"]);
    await appendLines(file, ["c"]);
    assert.equal(await readInboxText(file), "a\nb\nc\n");
  });
});

test("状态文件缺失或损坏时回落到空状态，合法内容可往返", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    assert.deepEqual(await readInboxState(file), { processedIds: [], lastRunAt: undefined });

    await writeFile(file, "{broken", "utf8");
    assert.deepEqual(await readInboxState(file), { processedIds: [], lastRunAt: undefined });

    await writeFile(file, JSON.stringify({ processedIds: ["a", 5, ""] }), "utf8");
    assert.deepEqual(await readInboxState(file), { processedIds: ["a"], lastRunAt: undefined });

    await writeInboxState(file, { processedIds: ["a", "b"], lastRunAt: "2026-09-23T00:00:00.000Z" });
    assert.deepEqual(await readInboxState(file), {
      processedIds: ["a", "b"],
      lastRunAt: "2026-09-23T00:00:00.000Z",
    });
  });
});

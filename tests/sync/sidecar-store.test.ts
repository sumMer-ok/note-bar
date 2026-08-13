import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSidecar, sidecarPathForBook, writeSidecarAtomic } from "../../src/sync/sidecar-store";

test("原子写后可读回，版本与字段完整", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-sidecar-"));
  try {
    const p = sidecarPathForBook(dir, "English/words.canvas");
    assert.equal(p, path.join(dir, "English/words.nb-sync.json"));
    await writeSidecarAtomic(p, { version: 1, book: "English/words.canvas", words: {}, updatedAt: "2026-08-14T00:00:00+08:00" });
    const data = await readSidecar(p);
    assert.equal(data?.book, "English/words.canvas");
    assert.equal(data?.version, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("版本不符或 JSON 损坏返回 null", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-sidecar-"));
  try {
    const p = path.join(dir, "bad.nb-sync.json");
    await writeSidecarAtomic(p, { version: 99, book: "x.canvas", words: {}, updatedAt: "" } as any);
    assert.equal(await readSidecar(p), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

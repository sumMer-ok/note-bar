import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importSidecars } from "../../src/sync/sync-importer";
import { SIDECAR_VERSION } from "../../src/sync/types";

test("把边车进度合并回 studyProgress，lastReview 较新者胜", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-import-"));
  try {
    await mkdir(path.join(dir, "English"), { recursive: true });
    await writeFile(
      path.join(dir, "English", "words.nb-sync.json"),
      JSON.stringify({
        version: SIDECAR_VERSION,
        book: "English/words.canvas",
        words: {
          "English/words.canvas:n1": {
            s: 99,
            lastReview: "2026-08-13T00:00:00.000Z",
            history: [{ date: "2026-08-13T00:00:00.000Z", quality: "easy" }],
          },
        },
        updatedAt: "2026-08-13T00:00:00.000Z",
      }),
      "utf8"
    );
    const settings: any = {
      vocabularyBooks: [{ path: "English/words.canvas", name: "英语", enabled: true }],
      studyProgress: {
        "English/words.canvas:n1": { s: 10, lastReview: "2026-08-12T00:00:00.000Z" },
      },
    };
    const result = await importSidecars({ settings, syncDir: dir });
    assert.equal(result.mergedKeys, 1);
    assert.equal(settings.studyProgress["English/words.canvas:n1"].s, 99);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("嵌套目录里的冲突副本能被检测并晋升", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-import-"));
  try {
    await mkdir(path.join(dir, "English"), { recursive: true });
    const mainPath = path.join(dir, "English", "words.nb-sync.json");
    const conflictPath = path.join(dir, "English", "words 2.nb-sync.json");
    await writeFile(
      mainPath,
      JSON.stringify({
        version: SIDECAR_VERSION,
        book: "English/words.canvas",
        words: { "English/words.canvas:n1": { s: 10, lastReview: "2026-08-12T00:00:00.000Z" } },
        updatedAt: "2026-08-12T00:00:00.000Z",
      }),
      "utf8"
    );
    await writeFile(
      conflictPath,
      JSON.stringify({
        version: SIDECAR_VERSION,
        book: "English/words.canvas",
        words: { "English/words.canvas:n1": { s: 99, lastReview: "2026-08-13T00:00:00.000Z" } },
        updatedAt: "2026-08-13T00:00:00.000Z",
      }),
      "utf8"
    );
    const settings: any = {
      vocabularyBooks: [{ path: "English/words.canvas", name: "英语", enabled: true }],
      studyProgress: {},
    };
    const result = await importSidecars({ settings, syncDir: dir });
    assert.equal(result.conflictsArchived.length, 1);
    assert.equal(settings.studyProgress["English/words.canvas:n1"].s, 99);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("重复导入相同内容时 mergedKeys 不虚增", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-import-"));
  try {
    await writeFile(
      path.join(dir, "words.nb-sync.json"),
      JSON.stringify({
        version: SIDECAR_VERSION,
        book: "words.canvas",
        words: { "words.canvas:n1": { s: 5, lastReview: "2026-08-13T00:00:00.000Z" } },
        updatedAt: "2026-08-13T00:00:00.000Z",
      }),
      "utf8"
    );
    const settings: any = {
      vocabularyBooks: [{ path: "words.canvas", name: "词库", enabled: true }],
      studyProgress: { "words.canvas:n1": { s: 5, lastReview: "2026-08-13T00:00:00.000Z" } },
    };
    const result = await importSidecars({ settings, syncDir: dir });
    assert.equal(result.mergedKeys, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

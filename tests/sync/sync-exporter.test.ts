import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportProgressToSidecars } from "../../src/sync/sync-exporter";
import { sidecarPathForBook } from "../../src/sync/sidecar-store";

test("只导出已启用 Canvas 词库中、能推导出 studyKey 的进度", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-export-"));
  try {
    const manager = {
      getWordDefinitionsByBook: async (bookPath: string) =>
        bookPath === "English/words.canvas"
          ? [{ source: "English/words.canvas", nodeId: "n1", word: "hello", definition: "你好" }]
          : [],
    };
    const settings: any = {
      vocabularyBooks: [
        { path: "English/words.canvas", name: "英语", enabled: true },
        { path: "Legal/law.canvas", name: "法律", enabled: true },
        { path: "Off/off.canvas", name: "关闭", enabled: false },
      ],
      studyProgress: {
        "English/words.canvas:n1": { s: 30, d: 5, dueDate: "2026-08-20" },
        orphanKey: { s: 1 }, // 无对应词条，不导出
      },
    };
    const result = await exportProgressToSidecars({ settings, vocabularyManager: manager as any, syncDir: dir });
    assert.equal(result.written, 2);
    const raw = JSON.parse(await readFile(sidecarPathForBook(dir, "English/words.canvas"), "utf8"));
    assert.equal(raw.words["English/words.canvas:n1"].s, 30);
    assert.equal(raw.words.orphanKey, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

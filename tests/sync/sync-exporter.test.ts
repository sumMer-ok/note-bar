import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportProgressToSidecars } from "../../src/sync/sync-exporter";
import { sidecarPathForBook, writeSidecarAtomic } from "../../src/sync/sidecar-store";

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

// ---------------------------------------------------------------------------
// 回归（2026-10-17 真机）：导出会整体覆盖边车，抹掉只存在于边车里的更新进度
//
// 真实事故：iOS 按词增量写边车，桌面在「导出早于导入」的窗口里（main.ts 会单独调
// exportAll()，没有前置导入）用自己较旧的整份 data.json 覆盖了边车 →
// iOS 读本地库显示 Common Law 待复习 93，Android 读被覆盖的边车显示 201，
// 两端数字长期不一致且越差越多。修法：导出前逐键走 mergeProgress 仲裁。
// ---------------------------------------------------------------------------
async function seedSidecar(dir: string, book: string, words: Record<string, any>): Promise<void> {
  await writeSidecarAtomic(sidecarPathForBook(dir, book), {
    version: 1,
    book,
    words,
    updatedAt: "2026-10-16T12:00:00.000Z",
  });
}

test("边车里更新的进度不得被 data.json 的旧进度覆盖（lastReview 较新者胜）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-export-merge-"));
  try {
    const book = "Words/Common Law.canvas";
    const key = `${book}:nodeA`;
    const manager = {
      getWordDefinitionsByBook: async () => [
        { source: book, nodeId: "nodeA", word: "apple", definition: "苹果" },
      ],
    };
    // data.json：桌面自己的旧进度（到期日已过 → 会被算成「待复习」）
    const settings: any = {
      vocabularyBooks: [{ path: book, name: "CL", enabled: true }],
      studyProgress: {
        [key]: { reps: 1, lastReview: "2026-09-14T00:00:00.000Z", dueDate: "2026-09-20" },
      },
    };
    // 边车：手机端刚复习过的新进度（到期日在未来 → 不该被算成待复习）
    await seedSidecar(dir, book, {
      [key]: {
        reps: 4,
        lastReview: "2026-10-16T12:00:00.000Z",
        dueDate: "2026-11-05",
        ef: 2.6,
        history: [{ date: "2026-10-16T12:00:00.000Z", quality: "good" }],
      },
    });

    await exportProgressToSidecars({ settings, vocabularyManager: manager as any, syncDir: dir });

    const raw = JSON.parse(await readFile(sidecarPathForBook(dir, book), "utf8"));
    assert.equal(raw.words[key].lastReview, "2026-10-16T12:00:00.000Z", "较新的 lastReview 必须胜出");
    assert.equal(raw.words[key].dueDate, "2026-11-05", "到期日必须保留边车里较新的值");
    assert.equal(raw.words[key].ef, 2.6, "落败方缺失的字段要回落保留");
    assert.equal(raw.words[key].history.length, 1, "history 需合并保留");
    assert.equal(raw.words[key].reps, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("边车里存在、本次未覆盖的键必须保留（别端刚写入、本端尚未看到）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-export-keep-"));
  try {
    const book = "Words/CL.canvas";
    const manager = {
      getWordDefinitionsByBook: async () => [
        { source: book, nodeId: "n1", word: "apple", definition: "苹果" },
      ],
    };
    const settings: any = {
      vocabularyBooks: [{ path: book, name: "CL", enabled: true }],
      studyProgress: { [`${book}:n1`]: { reps: 1, dueDate: "2026-10-01" } },
    };
    await seedSidecar(dir, book, {
      [`${book}:n1`]: { reps: 1, dueDate: "2026-10-01" },
      "Words/CL.canvas:来自手机": { reps: 2, lastReview: "2026-10-16T00:00:00.000Z" },
    });

    await exportProgressToSidecars({ settings, vocabularyManager: manager as any, syncDir: dir });

    const raw = JSON.parse(await readFile(sidecarPathForBook(dir, book), "utf8"));
    assert.ok(raw.words["Words/CL.canvas:来自手机"], "别端写入的键不能被导出删掉");
    assert.ok(raw.words[`${book}:n1`], "本端键照常写出");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("内容等价时判定为 unchanged，不做无谓写入", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-export-same-"));
  try {
    const book = "Words/CL.canvas";
    const manager = {
      getWordDefinitionsByBook: async () => [
        { source: book, nodeId: "n1", word: "apple", definition: "苹果" },
      ],
    };
    const item = { reps: 2, lastReview: "2026-10-01T00:00:00.000Z", dueDate: "2026-10-20" };
    const settings: any = {
      vocabularyBooks: [{ path: book, name: "CL", enabled: true }],
      studyProgress: { [`${book}:n1`]: item },
    };
    await seedSidecar(dir, book, { [`${book}:n1`]: item });

    const result = await exportProgressToSidecars({ settings, vocabularyManager: manager as any, syncDir: dir });
    assert.equal(result.unchanged, 1);
    assert.equal(result.written, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

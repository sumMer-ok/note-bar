import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictCopyBaseName, isConflictCopyName, mergeHistory, mergeProgress } from "../../src/sync/merge";

test("lastReview 较新者胜，history 按去重后时间序合并", () => {
  const local = {
    s: 10,
    lastReview: "2026-08-12T00:00:00.000Z",
    history: [{ date: "2026-08-12T00:00:00.000Z", quality: "good" as const }],
  };
  const remote = {
    s: 99,
    lastReview: "2026-08-13T00:00:00.000Z",
    history: [{ date: "2026-08-13T00:00:00.000Z", quality: "again" as const }],
  };
  const merged = mergeProgress(local as any, remote as any)!;
  assert.equal(merged.s, 99);
  assert.deepEqual(merged.history, [
    { date: "2026-08-12T00:00:00.000Z", quality: "good" },
    { date: "2026-08-13T00:00:00.000Z", quality: "again" },
  ]);
});

test("重复记录去重，且最多保留最近 50 条", () => {
  const a = Array.from({ length: 50 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    quality: "good" as const,
  }));
  const b = [a[0], { date: "2026-08-14T00:00:00.000Z", quality: "hard" as const }];
  const merged = mergeHistory(a, b)!;
  assert.equal(merged.length, 50);
  assert.equal(merged[0].quality, "good");
  assert.equal(merged[49].quality, "hard");
});

test("单侧存在时直接返回该侧", () => {
  assert.equal(mergeProgress(undefined, undefined), undefined);
  assert.equal(mergeProgress({ s: 5 } as any, undefined)!.s, 5);
});

test("识别 Apple 风格冲突副本命名", () => {
  assert.equal(isConflictCopyName("英语词库 2.nb-sync.json"), true);
  assert.equal(conflictCopyBaseName("英语词库 2.nb-sync.json"), "英语词库.nb-sync.json");
  assert.equal(isConflictCopyName("英语词库.nb-sync.json"), false);
});

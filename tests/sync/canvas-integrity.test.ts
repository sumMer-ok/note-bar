/**
 * `canvas-integrity` 校验器单测。
 *
 * 覆盖（COVERED）
 *   - 合法 canvas（含 edges、四种节点类型）
 *   - **真实事故样本** tests/fixtures/canvas-truncated.canvas（57344 字节，JSON 断在字符串中间）
 *   - 重复 id / 悬空边 / 缺字段 / nodes 非数组 / 顶层非对象
 *   - 节点数骤降启发式
 *   - 可疑副本 / 冲突副本命名与识别
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canvasNodeCount,
  conflictCanvasName,
  containsNodeId,
  formatCanvasStamp,
  isConflictCopyName,
  isSuspectCopyName,
  isSuspiciousShrink,
  suspectCanvasName,
  validateCanvasText,
} from "../../src/sync/canvas-integrity";

// 测试产物在 <repo>/.tests-dist/sync/，夹具在 <repo>/tests/fixtures/
const FIXTURE = path.resolve(__dirname, "..", "..", "tests", "fixtures", "canvas-truncated.canvas");

/** 一个结构完整的 canvas：四种节点类型 + 一条合法边 */
function validCanvas(): string {
  return JSON.stringify({
    nodes: [
      { id: "g1", type: "group", x: 0, y: 0, width: 300, height: 200, label: "2026-09-27" },
      { id: "n1", type: "text", x: 24, y: 24, width: 260, height: 120, text: "sue\n*sued*" },
      { id: "n2", type: "file", x: 24, y: 160, width: 260, height: 120, file: "notes/a.md" },
      { id: "n3", type: "link", x: 24, y: 300, width: 260, height: 120, url: "https://example.com" },
    ],
    edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
  });
}

test("validateCanvasText：合法 canvas 通过并返回节点数", () => {
  const verdict = validateCanvasText(validCanvas());
  assert.deepEqual(verdict, { ok: true, nodeCount: 4 });
});

test("validateCanvasText：空 nodes 是结构合法的空画布", () => {
  assert.deepEqual(validateCanvasText('{"nodes":[],"edges":[]}'), { ok: true, nodeCount: 0 });
});

test("validateCanvasText：真实截断样本（57344 字节）判为 not-json", async () => {
  const raw = await readFile(FIXTURE, "utf8");
  assert.equal(Buffer.byteLength(raw, "utf8"), 57344, "夹具必须是事故当时的字节数");
  assert.deepEqual(validateCanvasText(raw), { ok: false, reason: "not-json" });
});

test("validateCanvasText：JSON 合法但被截断成半个数组也判非法", () => {
  // 手工模拟「截断点恰好落在 JSON 边界」的退化形态
  assert.equal(validateCanvasText('{"nodes":[{"id":"n1",').ok, false);
  assert.equal(validateCanvasText("").ok, false);
  assert.equal(validateCanvasText("null").ok, false);
});

test("validateCanvasText：顶层不是对象 → not-object", () => {
  assert.deepEqual(validateCanvasText("[]"), { ok: false, reason: "not-object" });
  assert.deepEqual(validateCanvasText('"canvas"'), { ok: false, reason: "not-object" });
  assert.deepEqual(validateCanvasText("42"), { ok: false, reason: "not-object" });
});

test("validateCanvasText：nodes 非数组 → nodes-not-array", () => {
  assert.deepEqual(validateCanvasText('{"nodes":{}}'), { ok: false, reason: "nodes-not-array" });
  assert.deepEqual(validateCanvasText('{"edges":[]}'), { ok: false, reason: "nodes-not-array" });
});

test("validateCanvasText：重复 id → duplicate-id", () => {
  const raw = JSON.stringify({
    nodes: [
      { id: "dup", type: "text", x: 0, y: 0, width: 1, height: 1, text: "a" },
      { id: "dup", type: "text", x: 0, y: 0, width: 1, height: 1, text: "b" },
    ],
  });
  assert.deepEqual(validateCanvasText(raw), { ok: false, reason: "duplicate-id" });
});

test("validateCanvasText：缺字段（id/type/x/y/width/height/text）逐个判非法", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ type: "text", x: 0, y: 0, width: 1, height: 1, text: "a" }, "node-missing-id"],
    [{ id: "n1", x: 0, y: 0, width: 1, height: 1, text: "a" }, "node-missing-type"],
    [{ id: "n1", type: "text", y: 0, width: 1, height: 1, text: "a" }, "node-missing-geometry"],
    [{ id: "n1", type: "text", x: 0, y: 0, width: 1, height: "1", text: "a" }, "node-missing-geometry"],
    [{ id: "n1", type: "text", x: 0, y: 0, width: 1, height: 1 }, "text-node-missing-text"],
    [{ id: "n1", type: "text", x: 0, y: 0, width: 1, height: 1, text: 7 }, "text-node-missing-text"],
  ];
  for (const [node, reason] of cases) {
    assert.deepEqual(validateCanvasText(JSON.stringify({ nodes: [node] })), { ok: false, reason });
  }
});

test("validateCanvasText：未知 type 与非法节点项判非法", () => {
  assert.deepEqual(
    validateCanvasText(JSON.stringify({ nodes: [{ id: "n1", type: "image", x: 0, y: 0, width: 1, height: 1 }] })),
    { ok: false, reason: "node-unknown-type" }
  );
  assert.deepEqual(validateCanvasText('{"nodes":["n1"]}'), { ok: false, reason: "node-not-object" });
});

test("validateCanvasText：悬空边与缺端点的边判非法", () => {
  const node = { id: "n1", type: "text", x: 0, y: 0, width: 1, height: 1, text: "a" };
  assert.deepEqual(
    validateCanvasText(JSON.stringify({ nodes: [node], edges: [{ id: "e1", fromNode: "n1", toNode: "n9" }] })),
    { ok: false, reason: "edge-dangling" }
  );
  assert.deepEqual(
    validateCanvasText(JSON.stringify({ nodes: [node], edges: [{ id: "e1", fromNode: "n1" }] })),
    { ok: false, reason: "edge-missing-endpoint" }
  );
  assert.deepEqual(
    validateCanvasText(JSON.stringify({ nodes: [node], edges: {} })),
    { ok: false, reason: "edges-not-array" }
  );
});

test("isSuspiciousShrink：节点数骤降才可疑", () => {
  assert.equal(isSuspiciousShrink(10, 100), true);
  assert.equal(isSuspiciousShrink(59, 100), true);
  assert.equal(isSuspiciousShrink(60, 100), false);
  assert.equal(isSuspiciousShrink(101, 100), false);
  assert.equal(isSuspiciousShrink(0, 0), false);
  assert.equal(isSuspiciousShrink(0, 689), true, "整本丢空应判可疑");
  assert.equal(isSuspiciousShrink(500, 689), false, "正常删词不该误报");
  assert.equal(isSuspiciousShrink(Number.NaN, 100), false);
});

test("命名辅助：可疑副本 / 冲突副本 / 旧命名兼容", () => {
  const date = new Date(2026, 8, 27, 17, 13, 33);
  assert.equal(formatCanvasStamp(date), "20260927-171333");
  assert.equal(suspectCanvasName("Common Law.canvas", date), "Common Law.suspect-20260927-171333.canvas");
  assert.equal(conflictCanvasName("Words/AI.canvas", date), "AI.conflict-20260927-171333.canvas");

  assert.equal(isConflictCopyName("Common Law.canvas", "Common Law.conflict-20260927-171333.canvas"), true);
  assert.equal(isConflictCopyName("Common Law.canvas", "Common Law 3.canvas"), true, "旧命名仍要认出来");
  assert.equal(isConflictCopyName("Common Law.canvas", "Common Law.canvas"), false);
  assert.equal(isConflictCopyName("Common Law.canvas", "Common Law.suspect-20260927-171333.canvas"), false);
  assert.equal(isSuspectCopyName("Common Law.canvas", "Common Law.suspect-20260927-171333.canvas"), true);
});

test("containsNodeId / canvasNodeCount：写入回执与规模比较的基础", () => {
  const raw = validCanvas();
  assert.equal(containsNodeId(raw, "n2"), true);
  assert.equal(containsNodeId(raw, "n9"), false);
  assert.equal(containsNodeId("not json", "n1"), false);
  assert.equal(canvasNodeCount(raw), 4);
  assert.equal(canvasNodeCount("not json"), null);
});

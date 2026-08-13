import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveStudyKey } from "../../src/sync/study-key";

test("Canvas 普通节点无 studyKey 时回退为 source:nodeId", () => {
  const def = { source: "English/words.canvas", nodeId: "abcd1234abcd1234" } as any;
  assert.equal(deriveStudyKey(def), "English/words.canvas:abcd1234abcd1234");
});

test("卡片词条已有 studyKey 时原样返回", () => {
  const def = { studyKey: "und:word:hello", source: "x.canvas", nodeId: "y" } as any;
  assert.equal(deriveStudyKey(def), "und:word:hello");
});

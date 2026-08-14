import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDefinitionSections } from "../../src/hiwords/utils/definition-sections";

test("把乱序分节规范化成 词典→法律→AI→笔记", () => {
  const raw = [
    "1. n. 基础释义",
    "",
    "--- AI 释义 ---",
    "1）英/ test / 美/ test /",
    "2）n.测试",
    "",
    "--- Black's Law Dictionary --- n. (2024)",
    "1. a legal definition",
    "",
    "--- 自定义笔记 ---",
    "这是我自己的笔记",
  ].join("\n");

  const normalized = normalizeDefinitionSections(raw);
  const parts = normalized.split("\n\n");

  assert.equal(parts[0], "1. n. 基础释义");
  assert.ok(parts[1].startsWith("--- Black's Law Dictionary ---"));
  assert.ok(parts[1].includes("a legal definition"));
  assert.ok(parts[2].startsWith("--- AI 释义 ---"));
  assert.ok(parts[3].startsWith("--- 自定义笔记 ---"));
  assert.ok(parts[3].includes("这是我自己的笔记"));
});

test("无标题内容归入词典释义，空模块被省略", () => {
  assert.equal(normalizeDefinitionSections("plain definition"), "plain definition");
  assert.equal(
    normalizeDefinitionSections("--- 自定义笔记 ---\n   "),
    ""
  );
});

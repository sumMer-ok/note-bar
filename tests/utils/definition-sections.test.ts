import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEFINITION_SECTION_ORDER,
  joinDefinitionSections,
  normalizeDefinitionSections,
  parseDefinitionSections,
  resolveDefinitionSectionOrder,
} from "../../src/hiwords/utils/definition-sections";

const MIXED_RAW = [
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

test("默认顺序常量与 normalize 缺省行为一致（向后兼容）", () => {
  assert.deepEqual(DEFAULT_DEFINITION_SECTION_ORDER, ["dictionary", "legal", "ai", "notes"]);
  assert.equal(normalizeDefinitionSections(MIXED_RAW), normalizeDefinitionSections(MIXED_RAW, DEFAULT_DEFINITION_SECTION_ORDER));
});

test("normalizeDefinitionSections 支持按传入顺序输出", () => {
  const normalized = normalizeDefinitionSections(MIXED_RAW, ["notes", "ai", "dictionary", "legal"]);
  assert.equal(
    normalized,
    [
      "--- 自定义笔记 ---\n这是我自己的笔记",
      "--- AI 释义 ---\n1）英/ test / 美/ test /\n2）n.测试",
      // 词典释义不在首位时必须补标题，否则再次解析会被上一个分节吞掉
      "--- 词典释义 ---\n1. n. 基础释义",
      "--- Black's Law Dictionary ---\nn. (2024)\n1. a legal definition",
    ].join("\n\n")
  );

  // 词典释义仍在首位时保持历史写法（无标题）
  const aiFirst = normalizeDefinitionSections(MIXED_RAW, ["dictionary", "ai", "legal", "notes"]);
  assert.ok(aiFirst.startsWith("1. n. 基础释义"));
  assert.ok(aiFirst.indexOf("1. n. 基础释义") < aiFirst.indexOf("--- AI 释义 ---"));
  assert.ok(aiFirst.indexOf("--- AI 释义 ---") < aiFirst.indexOf("--- Black's Law Dictionary ---"));
  assert.ok(aiFirst.endsWith("--- 自定义笔记 ---\n这是我自己的笔记"));
});

test("normalizeDefinitionSections 保留已有自定义分节标题", () => {
  const raw = "--- 法律释义 ---\n1. custom legal header";
  assert.equal(
    normalizeDefinitionSections(raw, ["legal", "dictionary"]),
    "--- 法律释义 ---\n1. custom legal header"
  );
});

test("parseDefinitionSections 把 definition 拆成 4 段独立正文", () => {
  const sections = parseDefinitionSections(MIXED_RAW);

  assert.deepEqual(Object.keys(sections).sort(), ["ai", "dictionary", "legal", "notes"]);
  assert.equal(sections.dictionary, "1. n. 基础释义");
  // 标题行后面的词性/年份元信息仍保留在正文首行
  assert.equal(sections.legal, "n. (2024)\n1. a legal definition");
  assert.equal(sections.ai, "1）英/ test / 美/ test /\n2）n.测试");
  assert.equal(sections.notes, "这是我自己的笔记");
});

test("parseDefinitionSections：无标题内容归 dictionary，缺失分节为空串", () => {
  const sections = parseDefinitionSections("plain definition");
  assert.equal(sections.dictionary, "plain definition");
  assert.equal(sections.legal, "");
  assert.equal(sections.ai, "");
  assert.equal(sections.notes, "");

  const empty = parseDefinitionSections("");
  assert.deepEqual(empty, { dictionary: "", legal: "", ai: "", notes: "" });
});

test("parseDefinitionSections 合并同类分节", () => {
  const sections = parseDefinitionSections("--- AI 释义 ---\nA\n\n--- AI 释义 ---\nB");
  assert.equal(sections.ai, "A\n\nB");
});

test("joinDefinitionSections 按给定顺序拼回 definition，空段省略", () => {
  const joined = joinDefinitionSections(
    { dictionary: "1. n. 基础释义", legal: "", ai: "AI 内容", notes: "我的笔记" },
    ["notes", "dictionary", "ai", "legal"]
  );
  assert.equal(
    joined,
    [
      "--- 自定义笔记 ---\n我的笔记",
      "--- 词典释义 ---\n1. n. 基础释义",
      "--- AI 释义 ---\nAI 内容",
    ].join("\n\n")
  );

  // 词典释义排在首位时不写标题，与既有 Canvas 数据一致
  const dictionaryFirst = joinDefinitionSections(
    { dictionary: "1. n. 基础释义", legal: "", ai: "AI 内容", notes: "我的笔记" },
    ["dictionary", "notes", "ai", "legal"]
  );
  assert.ok(dictionaryFirst.startsWith("1. n. 基础释义"));
  assert.ok(!dictionaryFirst.includes("--- 词典释义 ---"));
});

test("任意分节顺序下 parse → join → parse 都不串节（24 种排列）", () => {
  const sections = parseDefinitionSections(MIXED_RAW);
  const kinds = DEFAULT_DEFINITION_SECTION_ORDER;

  const permutations = (items: readonly string[]): string[][] =>
    items.length <= 1
      ? [items as string[]]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest])
        );

  const all = permutations(kinds);
  assert.equal(all.length, 24);
  for (const order of all) {
    const saved = joinDefinitionSections(sections, order as never);
    assert.deepEqual(parseDefinitionSections(saved), sections, `顺序 ${order.join("→")} 串节了`);
  }
});

test("joinDefinitionSections 缺省顺序与默认顺序一致", () => {
  assert.equal(
    joinDefinitionSections({ dictionary: "D", legal: "L", ai: "A", notes: "N" }),
    joinDefinitionSections({ dictionary: "D", legal: "L", ai: "A", notes: "N" }, DEFAULT_DEFINITION_SECTION_ORDER)
  );
  assert.equal(joinDefinitionSections({}), "");
});

test("joinDefinitionSections 使用合法标题，写回 Canvas 与既有数据兼容", () => {
  const joined = joinDefinitionSections({ dictionary: "D", legal: "L", ai: "A", notes: "N" });
  assert.ok(joined.startsWith("D"));
  assert.ok(joined.includes(`--- Black's Law Dictionary ---\nL`));
  assert.ok(joined.includes("--- AI 释义 ---\nA"));
  assert.ok(joined.includes("--- 自定义笔记 ---\nN"));
  assert.equal(joined, normalizeDefinitionSections(joined));
});

test("parse → join 往返：默认顺序下与 normalize 结果一致", () => {
  const roundTrip = joinDefinitionSections(parseDefinitionSections(MIXED_RAW));
  assert.equal(roundTrip, normalizeDefinitionSections(MIXED_RAW));
  // 再往返一次保持稳定
  assert.equal(joinDefinitionSections(parseDefinitionSections(roundTrip)), roundTrip);
});

test("resolveDefinitionSectionOrder 补全缺失项、去重、丢弃非法值并保序", () => {
  assert.deepEqual(resolveDefinitionSectionOrder(undefined), ["dictionary", "legal", "ai", "notes"]);
  assert.deepEqual(resolveDefinitionSectionOrder(null), ["dictionary", "legal", "ai", "notes"]);
  assert.deepEqual(resolveDefinitionSectionOrder([]), ["dictionary", "legal", "ai", "notes"]);
  assert.deepEqual(resolveDefinitionSectionOrder(["notes", "notes"]), ["notes", "dictionary", "legal", "ai"]);
  assert.deepEqual(
    resolveDefinitionSectionOrder(["ai", "bogus" as never, "dictionary"]),
    ["ai", "dictionary", "legal", "notes"]
  );
  // 已经是完整合法顺序时原样返回
  const full = resolveDefinitionSectionOrder(["legal", "notes", "ai", "dictionary"]);
  assert.deepEqual(full, ["legal", "notes", "ai", "dictionary"]);
});

test("弹窗组装：回填 4 段 → 只改 AI 段 → 按自定义顺序拼回，其余内容不丢", () => {
  // 打开弹窗：按 kind 拆开回填
  const sections = parseDefinitionSections(MIXED_RAW);
  // 用户只改「AI 释义」框
  sections.ai = "新的 AI 释义";
  // 保存：按当时的分节顺序拼回
  const saved = joinDefinitionSections(sections, ["ai", "dictionary", "legal", "notes"]);

  assert.equal(
    saved,
    [
      "--- AI 释义 ---\n新的 AI 释义",
      "--- 词典释义 ---\n1. n. 基础释义",
      "--- Black's Law Dictionary ---\nn. (2024)\n1. a legal definition",
      "--- 自定义笔记 ---\n这是我自己的笔记",
    ].join("\n\n")
  );

  // 写回后再次按 kind 解析仍然归位正确（与既有 Canvas 数据兼容）
  assert.deepEqual(parseDefinitionSections(saved), {
    dictionary: "1. n. 基础释义",
    legal: "n. (2024)\n1. a legal definition",
    ai: "新的 AI 释义",
    notes: "这是我自己的笔记",
  });
});

test("弹窗组装：本地词典/法律词典只落对应两段，AI 段留空不写入标题", () => {
  const joined = joinDefinitionSections(
    { dictionary: "1. n. 词典释义", legal: "n. (2024)\n1. legal", ai: "", notes: "" },
    ["dictionary", "legal", "ai", "notes"]
  );
  assert.equal(joined, ["1. n. 词典释义", "--- Black's Law Dictionary ---\nn. (2024)\n1. legal"].join("\n\n"));
  assert.ok(!joined.includes("--- AI 释义 ---"));
  assert.ok(!joined.includes("--- 自定义笔记 ---"));
});

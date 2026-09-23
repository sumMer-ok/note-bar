import { test } from "node:test";
import assert from "node:assert/strict";
import { INBOX_VERSION, normalizeAliases, parseInboxLine } from "../../src/sync/inbox-types";

test("合法行解析为条目并保留全部字段", () => {
  const line = JSON.stringify({
    v: INBOX_VERSION,
    id: "5f1c-a1",
    word: "consideration",
    sentence: "For valuable consideration, the parties agree.",
    definition: "n. 对价；考虑",
    aliases: ["Considerations", "consider"],
    color: "4",
    books: ["Words/Common Law.canvas"],
    origin: { app: "WPS Office", file: "/Users/x/contract.docx" },
  });
  const result = parseInboxLine(line);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.entry.word, "consideration");
  assert.equal(result.entry.definition, "n. 对价；考虑");
  assert.equal(result.entry.color, "4");
  assert.deepEqual(result.entry.books, ["Words/Common Law.canvas"]);
  assert.deepEqual(result.entry.aliases, ["considerations", "consider"]);
  assert.equal(result.entry.origin?.app, "WPS Office");
});

test("word 与 id 两端空白被裁剪，缺失则报错", () => {
  const ok = parseInboxLine(JSON.stringify({ v: INBOX_VERSION, id: " a1 ", word: "  sue  " }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.entry.word, "sue");

  const noId = parseInboxLine(JSON.stringify({ v: INBOX_VERSION, word: "sue" }));
  assert.deepEqual(noId, { ok: false, reason: "missing-id" });

  const noWord = parseInboxLine(JSON.stringify({ v: INBOX_VERSION, id: "a1", word: "   " }));
  assert.deepEqual(noWord, { ok: false, reason: "missing-word" });
});

test("空行、非法 JSON、非对象、版本不符分别给出原因", () => {
  assert.deepEqual(parseInboxLine("   "), { ok: false, reason: "blank" });
  assert.deepEqual(parseInboxLine("{oops"), { ok: false, reason: "invalid-json" });
  assert.deepEqual(parseInboxLine("[1,2]"), { ok: false, reason: "not-an-object" });
  assert.deepEqual(
    parseInboxLine(JSON.stringify({ v: 99, id: "a1", word: "sue" })),
    { ok: false, reason: "unsupported-version" }
  );
});

test("别名统一小写去重、丢弃空串、上限 10 条", () => {
  assert.deepEqual(normalizeAliases([" Sued ", "sued", "", "  ", "SUES"]), ["sued", "sues"]);
  assert.equal(normalizeAliases([]), undefined);
  assert.equal(normalizeAliases("not-an-array"), undefined);
  const many = Array.from({ length: 15 }, (_, i) => `a${i}`);
  assert.equal(normalizeAliases(many)?.length, 10);
});

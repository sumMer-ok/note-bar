import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { INBOX_VERSION, parseInboxLine } from "../../src/sync/inbox-types";

/**
 * 跨语言协议契约：macOS 助手（Swift）产出的样本行必须能被插件侧解析。
 * 样本由 NoteBarHelper/Tests/NoteBarHelperTests/InboxWriterTests.swift 的
 * testWritesContractFixture 生成；先跑 `cd NoteBarHelper && swift test` 再跑本测试。
 */
const FIXTURE = path.join(__dirname, "..", "..", "NoteBarHelper", "Tests", "Fixtures", "inbox-sample.jsonl");

test("助手产出的每一行都能被插件解析为合法条目", () => {
  const text = readFileSync(FIXTURE, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  assert.ok(lines.length >= 2, "样本至少两行");

  for (const line of lines) {
    const parsed = parseInboxLine(line);
    assert.equal(parsed.ok, true, `解析失败: ${line}`);
    if (!parsed.ok) continue;
    assert.equal(parsed.entry.v, INBOX_VERSION);
    assert.ok(parsed.entry.id.length > 0);
    assert.ok(parsed.entry.word.length > 0);
    assert.deepEqual(parsed.entry.books, ["law.canvas"]);
    assert.equal(parsed.entry.color, "4");
    assert.equal(parsed.entry.origin?.app, "WPS Office");
  }
});

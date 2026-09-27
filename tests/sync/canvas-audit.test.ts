/**
 * 审计/失败日志模块单测（P2 定位层的基础件）。
 *
 * 覆盖（COVERED）
 *   - 日志路径约定：<vault>/.obsidian/plugins/note-bar/{canvas-audit.log,canvas-write-failures.log}
 *   - 审计行格式：timestamp | actor | book | bytesBefore | bytesAfter | sha1_12_before | sha1_12_after | validated
 *   - sha1 前 12 位、UTF-8 字节数
 *   - 超过阈值轮转为 <log>.1（只留一代），目录不存在时自动创建
 *   - 写入失败绝不上抛（日志不能反过来影响词条写入）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AUDIT_LOG_ROTATE_BYTES,
  appendAuditLine,
  appendLogLine,
  canvasAuditLogPath,
  canvasWriteFailureLogPath,
  formatAuditLine,
  pluginDataDir,
  resolveVaultBasePath,
  sha1Short12,
  utf8ByteLength,
} from "../../src/sync/canvas-audit";

test("路径约定：插件数据目录与两个日志文件", () => {
  const vault = "/tmp/vault";
  assert.equal(pluginDataDir(vault), path.join(vault, ".obsidian", "plugins", "note-bar"));
  assert.equal(canvasAuditLogPath(vault), path.join(vault, ".obsidian", "plugins", "note-bar", "canvas-audit.log"));
  assert.equal(
    canvasWriteFailureLogPath(vault),
    path.join(vault, ".obsidian", "plugins", "note-bar", "canvas-write-failures.log")
  );
  assert.equal(AUDIT_LOG_ROTATE_BYTES, 512 * 1024);
});

test("resolveVaultBasePath：只有 adapter.getBasePath 存在时才有值", () => {
  assert.equal(resolveVaultBasePath({ vault: { adapter: { getBasePath: () => "/tmp/vault" } } }), "/tmp/vault");
  assert.equal(resolveVaultBasePath({ vault: { adapter: {} } }), null);
  assert.equal(resolveVaultBasePath({ vault: { adapter: { getBasePath: () => "" } } }), null);
  assert.equal(resolveVaultBasePath({}), null);
  assert.equal(resolveVaultBasePath(null), null);
});

test("sha1Short12 与 utf8ByteLength", () => {
  assert.equal(sha1Short12(""), "da39a3ee5e6b");
  assert.match(sha1Short12('{"nodes":[]}'), /^[0-9a-f]{12}$/);
  assert.notEqual(sha1Short12("a"), sha1Short12("b"));
  assert.equal(utf8ByteLength("sue"), 3);
  assert.equal(utf8ByteLength("起诉"), 6);
});

test("formatAuditLine：字段顺序与取值口径固定", () => {
  const line = formatAuditLine({
    timestamp: new Date("2026-09-27T09:13:33.000Z"),
    actor: "plugin",
    book: "Words/Common Law.canvas",
    bytesBefore: 403575,
    bytesAfter: 403789,
    sha1Before: "abcdef123456",
    sha1After: "fedcba654321",
    validated: true,
  });
  assert.equal(
    line,
    "2026-09-27T09:13:33.000Z | plugin | Words/Common Law.canvas | 403575 | 403789 | abcdef123456 | fedcba654321 | yes"
  );
  assert.equal(
    formatAuditLine({
      timestamp: new Date("2026-09-27T09:13:33.000Z"),
      actor: "mirror",
      book: "b.canvas",
      bytesBefore: 0,
      bytesAfter: 10,
      sha1Before: "-",
      sha1After: "0123456789ab",
      validated: false,
    }).split(" | ")[7],
    "no"
  );
});

test("appendLogLine：目录自动创建、逐行追加、失败不上抛", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nb-audit-"));
  try {
    const logPath = path.join(root, "deep", "dir", "canvas-audit.log");
    assert.equal(await appendLogLine(logPath, "line-1"), true);
    assert.equal(await appendLogLine(logPath, "line-2"), true);
    assert.equal(await fs.readFile(logPath, "utf8"), "line-1\nline-2\n");

    // 不可写路径（父级是文件）只返回 false，不抛
    const blocked = path.join(logPath, "nested", "x.log");
    assert.equal(await appendLogLine(blocked, "nope"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("appendLogLine：超过阈值轮转为 .1，只保留一代", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nb-audit-"));
  try {
    const logPath = path.join(root, "canvas-audit.log");
    await appendLogLine(logPath, "old-log-content", { maxBytes: 4 });
    await appendLogLine(logPath, "first-new", { maxBytes: 4 });
    // 第二次追加时旧文件已超阈值 ⇒ 轮转
    assert.equal(await fs.readFile(`${logPath}.1`, "utf8"), "old-log-content\n");
    assert.equal(await fs.readFile(logPath, "utf8"), "first-new\n");

    await appendLogLine(logPath, "second-new", { maxBytes: 4 });
    assert.equal(await fs.readFile(`${logPath}.1`, "utf8"), "first-new\n", "旧的 .1 被新一代替换");
    assert.equal(await fs.readFile(logPath, "utf8"), "second-new\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("appendAuditLine：写入一行可被逐字段解析的审计", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nb-audit-"));
  try {
    const logPath = path.join(root, "canvas-audit.log");
    const ok = await appendAuditLine(logPath, {
      timestamp: new Date("2026-09-27T09:13:33.000Z"),
      actor: "mirror",
      book: "Words/AI.canvas",
      bytesBefore: 1,
      bytesAfter: 2,
      sha1Before: "-",
      sha1After: "0123456789ab",
      validated: true,
    });
    assert.equal(ok, true);
    const fields = (await fs.readFile(logPath, "utf8")).trim().split(" | ");
    assert.equal(fields.length, 8);
    assert.equal(fields[1], "mirror");
    assert.equal(fields[2], "Words/AI.canvas");
    assert.equal(fields[7], "yes");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

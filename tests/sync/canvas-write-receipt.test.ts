/**
 * 写入回执集成测试：`addWordToCanvas({ awaitWrite: true })` 必须反映**真实落盘结果**。
 *
 * 覆盖（COVERED）
 *   - 正常 canvas：等落盘写入成功，节点真的出现在文件里，且不产生失败日志
 *   - 静默失败（vault.process 不落盘）：重试一次后仍失败 → 返回 false、写 canvas-write-failures.log、发 Notice
 *   - 真实事故截断样本：收件箱条目被归档到 note-bar-inbox.failed.jsonl（reason=apply-failed），
 *     且 id 不进 .state.json（不会被当成消费成功）
 *   - 收件箱正常路径：3 条词条全部出现在文件里，收件箱清空
 *
 * 不覆盖（NOT COVERED，故意收窄）：Obsidian 真实宿主行为、Notice 的界面呈现。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Notice, TFile } from "obsidian";
import { VocabularyManager } from "../../src/hiwords/core/vocabulary-manager";
import { createInboxVocabularyPort } from "../../src/sync/inbox-vocabulary-adapter";
import { importInbox } from "../../src/sync/inbox-importer";
import { inboxPathFor, inboxStatePathFor, readInboxState, readInboxText } from "../../src/sync/inbox-store";
import type { InboxEntry } from "../../src/sync/inbox-types";
import type { HiWordsSettings } from "../../src/hiwords/utils/types";

// CanvasEditor.genHex16() 用 window.crypto；node 的 globalThis 自带 Web Crypto
(globalThis as any).window = globalThis;

const RELATIVE_BOOK = "Words/AI Agent.canvas";
// 测试产物在 <repo>/.tests-dist/sync/，夹具在 <repo>/tests/fixtures/
const TRUNCATED_FIXTURE = path.resolve(__dirname, "..", "..", "tests", "fixtures", "canvas-truncated.canvas");
const WRITE_FAILURE_LOG = path.join(".obsidian", "plugins", "note-bar", "canvas-write-failures.log");

interface Harness {
  root: string;
  bookAbsPath: string;
  manager: VocabularyManager;
  /** vault.process 被调用次数（用来断言「失败后重试一次」） */
  processCalls: () => number;
  /** 清空并返回 Notice 记录 */
  notices: () => string[];
  cleanup: () => Promise<void>;
}

/**
 * 最小假 vault：真实临时目录 + 真实文件读写。
 * @param options.persistProcess false 时模拟「process 返回了新内容但没落盘」的静默失败
 */
async function createHarness(options: { bookContent?: string; persistProcess?: boolean } = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nb-write-receipt-"));
  const bookAbsPath = path.join(root, "vault", RELATIVE_BOOK);
  await fs.mkdir(path.dirname(bookAbsPath), { recursive: true });
  await fs.writeFile(bookAbsPath, options.bookContent ?? '{"nodes":[],"edges":[]}', "utf8");
  const persist = options.persistProcess !== false;

  const absByPath = new Map<string, string>([[RELATIVE_BOOK, bookAbsPath]]);
  let processCalls = 0;
  const vault = {
    adapter: {
      getBasePath: () => path.join(root, "vault"),
      read: async (p: string) => {
        const abs = absByPath.get(p);
        if (!abs) throw new Error(`no such file: ${p}`);
        return await fs.readFile(abs, "utf8");
      },
    },
    getAbstractFileByPath(p: string) {
      const abs = absByPath.get(p);
      return abs ? new TFile(abs) : null;
    },
    async cachedRead(file: any) {
      return await fs.readFile(file.path, "utf8");
    },
    async read(file: any) {
      return await fs.readFile(file.path, "utf8");
    },
    async process(file: any, fn: (current: string) => string) {
      processCalls++;
      const next = fn(await fs.readFile(file.path, "utf8"));
      if (persist) await fs.writeFile(file.path, next, "utf8");
      return next;
    },
  };

  const settings = {
    cardWidth: 260,
    cardHeight: 120,
    autoLayoutEnabled: false,
    masteredDetection: "group",
    vocabularyBooks: [],
  } as unknown as HiWordsSettings;

  Notice.reset();
  return {
    root,
    bookAbsPath,
    manager: new VocabularyManager({ vault } as any, settings),
    processCalls: () => processCalls,
    notices: () => Notice.instances.map((notice) => String(notice.message)),
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("awaitWrite：正常 canvas 写入后节点真的在文件里，且不产生失败日志", async () => {
  const h = await createHarness();
  try {
    for (const word of ["sue", "revoke", "tort"]) {
      const ok = await h.manager.addWordToMultipleCanvas(
        [RELATIVE_BOOK],
        word,
        `释义-${word}`,
        undefined,
        undefined,
        { awaitWrite: true }
      );
      assert.equal(ok, true, `${word} 应写入成功`);
    }

    const canvas = JSON.parse(await fs.readFile(h.bookAbsPath, "utf8"));
    const texts = canvas.nodes.filter((n: any) => n.type === "text").map((n: any) => n.text);
    assert.equal(texts.length, 3);
    assert.ok(texts.some((text: string) => text.startsWith("sue")));

    await assert.rejects(fs.stat(path.join(h.root, "vault", WRITE_FAILURE_LOG)), "成功写入不该产生失败日志");
    assert.deepEqual(
      h.notices().filter((message) => message.includes("词条写入失败")),
      []
    );
  } finally {
    await h.cleanup();
  }
});

test("awaitWrite：静默不落盘 → 返回 false、重试一次、写失败日志并发 Notice", async () => {
  const h = await createHarness({ persistProcess: false });
  try {
    const ok = await h.manager.addWordToMultipleCanvas(
      [RELATIVE_BOOK],
      "sue",
      "v. 起诉",
      undefined,
      undefined,
      { awaitWrite: true }
    );

    assert.equal(ok, false, "没落盘就不许报成功");
    const log = await fs.readFile(path.join(h.root, "vault", WRITE_FAILURE_LOG), "utf8");
    assert.match(log, /book=Words\/AI Agent\.canvas/);
    assert.match(log, /words=sue/);
    assert.match(log, /reason=node-missing-after-write/);
    assert.equal(log.trim().split("\n").length, 1, "一次刷盘只记一行");

    assert.ok(
      h.notices().some((message) => message.includes("词条写入失败")),
      "用户必须看到 Notice"
    );
    assert.equal(h.processCalls(), 2, "失败后应重试一次（共两次写入尝试）");
    // 文件仍是空的（假宿主没落盘），确认没有「假成功」
    assert.equal((await fs.readFile(h.bookAbsPath, "utf8")).includes("sue"), false);
  } finally {
    await h.cleanup();
  }
});

test("awaitWrite：真实截断样本 → 收件箱条目进失败归档，id 不进 state.json", async () => {
  const truncated = await fs.readFile(TRUNCATED_FIXTURE, "utf8");
  const h = await createHarness({ bookContent: truncated });
  const syncDir = path.join(h.root, "inbox");
  await fs.mkdir(syncDir, { recursive: true });
  try {
    const entry: InboxEntry = { v: 1, id: "broken-1", word: "sue", definition: "v. 起诉" };
    await fs.writeFile(inboxPathFor(syncDir), `${JSON.stringify(entry)}\n`, "utf8");

    const port = createInboxVocabularyPort({ manager: h.manager, dictionary: undefined });
    const result = await importInbox({
      syncDir,
      books: [RELATIVE_BOOK],
      defaultBooks: [RELATIVE_BOOK],
      duplicatePolicy: "skip",
      port,
    });

    assert.equal(result.added, 0);
    assert.equal(result.failed, 1);

    const failed = await fs.readFile(path.join(syncDir, "note-bar-inbox.failed.jsonl"), "utf8");
    const archived = JSON.parse(failed.trim());
    assert.equal(archived.id, "broken-1");
    assert.equal(archived.reason, "apply-failed");

    const state = await readInboxState(inboxStatePathFor(syncDir));
    assert.deepEqual(state.processedIds, [], "失败条目不许记成已处理");

    assert.equal(await readInboxText(inboxPathFor(syncDir)), "", "失败条目已归档，不再留在收件箱");
    assert.ok(h.notices().some((message) => message.includes("词条写入失败")));
    // 坏文件没被写坏（内容原样保留）
    assert.equal(await fs.readFile(h.bookAbsPath, "utf8"), truncated);
  } finally {
    await h.cleanup();
  }
});

test("awaitWrite：收件箱正常路径 3 条全部落盘、收件箱清空、id 全部记入 state", async () => {
  const h = await createHarness();
  const syncDir = path.join(h.root, "inbox");
  await fs.mkdir(syncDir, { recursive: true });
  try {
    const entries: InboxEntry[] = [
      { v: 1, id: "ok-1", word: "sue", definition: "v. 起诉", aliases: ["sued"] },
      { v: 1, id: "ok-2", word: "revoke", definition: "v. 撤销" },
      { v: 1, id: "ok-3", word: "tort", definition: "n. 侵权" },
    ];
    await fs.writeFile(inboxPathFor(syncDir), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const port = createInboxVocabularyPort({ manager: h.manager, dictionary: undefined });
    const result = await importInbox({
      syncDir,
      books: [RELATIVE_BOOK],
      defaultBooks: [RELATIVE_BOOK],
      duplicatePolicy: "skip",
      port,
    });

    assert.deepEqual(result, {
      added: 3,
      updated: 0,
      skipped: 0,
      failed: 0,
      badLines: 0,
      duplicatesDropped: 0,
    });

    const canvas = JSON.parse(await fs.readFile(h.bookAbsPath, "utf8"));
    const texts = canvas.nodes.filter((n: any) => n.type === "text").map((n: any) => n.text);
    assert.equal(texts.length, 3);
    assert.ok(texts.some((text: string) => text === "sue\n*sued*\n\nv. 起诉"));
    assert.equal(await readInboxText(inboxPathFor(syncDir)), "");
    const state = await readInboxState(inboxStatePathFor(syncDir));
    assert.deepEqual([...state.processedIds].sort(), ["ok-1", "ok-2", "ok-3"]);
  } finally {
    await h.cleanup();
  }
});

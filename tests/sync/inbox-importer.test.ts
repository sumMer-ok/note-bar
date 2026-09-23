import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INBOX_VERSION, type InboxEntry } from "../../src/sync/inbox-types";
import {
  appendLines,
  inboxFailedPathFor,
  inboxPathFor,
  inboxStatePathFor,
  readInboxState,
  readInboxText,
  writeInboxAtomic,
} from "../../src/sync/inbox-store";
import { importInbox, type InboxImportOptions, type InboxVocabularyPort } from "../../src/sync/inbox-importer";

interface AddCall { bookPath: string; entry: InboxEntry }
interface UpdateCall { bookPath: string; nodeId: string; entry: InboxEntry }

function makePort(seed?: { existing?: Record<string, string>; failAddFor?: string[] }) {
  const existing = new Map(Object.entries(seed?.existing ?? {}));
  const failAddFor = new Set(seed?.failAddFor ?? []);
  const added: AddCall[] = [];
  const updated: UpdateCall[] = [];
  const port: InboxVocabularyPort = {
    async findExisting(bookPath, word) {
      const nodeId = existing.get(`${bookPath}::${word.toLowerCase()}`);
      return nodeId ? { nodeId } : null;
    },
    async addWord(bookPath, entry) {
      if (failAddFor.has(bookPath)) return false;
      added.push({ bookPath, entry });
      return true;
    },
    async updateWord(bookPath, nodeId, entry) {
      updated.push({ bookPath, nodeId, entry });
      return true;
    },
    async lookupDefinition() {
      return undefined;
    },
  };
  return { port, added, updated };
}

function line(entry: Partial<InboxEntry> & { id: string; word: string }): string {
  return JSON.stringify({ v: INBOX_VERSION, ...entry });
}

async function withSyncDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-inbox-imp-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseOptions(syncDir: string, port: InboxVocabularyPort): InboxImportOptions {
  return {
    syncDir,
    books: ["Words/Common Law.canvas", "Words/AI Agent.canvas"],
    defaultBooks: ["Words/AI Agent.canvas"],
    duplicatePolicy: "skip",
    port,
  };
}

test("按条目指定的词库落库，处理成功后从收件箱移除", async () => {
  await withSyncDir(async (dir) => {
    const { port, added } = makePort();
    await writeInboxAtomic(
      inboxPathFor(dir),
      `${line({ id: "1", word: "consideration", books: ["Words/Common Law.canvas"] })}\n`
    );

    const result = await importInbox(baseOptions(dir, port));

    assert.equal(result.added, 1);
    assert.equal(result.failed, 0);
    assert.equal(added.length, 1);
    assert.equal(added[0].bookPath, "Words/Common Law.canvas");
    assert.equal(added[0].entry.word, "consideration");
    assert.equal(await readInboxText(inboxPathFor(dir)), "");
  });
});

test("未指定词库时回落到 defaultBooks，且只落在已启用词库上", async () => {
  await withSyncDir(async (dir) => {
    const { port, added } = makePort();
    await writeInboxAtomic(inboxPathFor(dir), `${line({ id: "1", word: "sue" })}\n`);

    await importInbox(baseOptions(dir, port));

    assert.deepEqual(added.map((call) => call.bookPath), ["Words/AI Agent.canvas"]);
  });
});

test("条目指定的词库若未启用则忽略该词库，仍可回落到默认词库", async () => {
  await withSyncDir(async (dir) => {
    const { port, added } = makePort();
    await writeInboxAtomic(
      inboxPathFor(dir),
      `${line({ id: "1", word: "sue", books: ["Words/Unknown.canvas"] })}\n`
    );

    await importInbox(baseOptions(dir, port));

    assert.deepEqual(added.map((call) => call.bookPath), ["Words/AI Agent.canvas"]);
  });
});

test("skip 策略下已存在的词不重复添加", async () => {
  await withSyncDir(async (dir) => {
    const { port, added, updated } = makePort({
      existing: { "Words/AI Agent.canvas::sue": "node-1" },
    });
    await writeInboxAtomic(inboxPathFor(dir), `${line({ id: "1", word: "sue" })}\n`);

    const result = await importInbox(baseOptions(dir, port));

    assert.equal(result.skipped, 1);
    assert.equal(result.added, 0);
    assert.equal(added.length, 0);
    assert.equal(updated.length, 0);
    assert.equal(await readInboxText(inboxPathFor(dir)), "");
  });
});

test("update 策略下改写既有节点", async () => {
  await withSyncDir(async (dir) => {
    const { port, updated } = makePort({ existing: { "Words/AI Agent.canvas::sue": "node-1" } });
    await writeInboxAtomic(
      inboxPathFor(dir),
      `${line({ id: "1", word: "sue", definition: "v. 起诉" })}\n`
    );

    const result = await importInbox({ ...baseOptions(dir, port), duplicatePolicy: "update" });

    assert.equal(result.updated, 1);
    assert.equal(updated.length, 1);
    assert.equal(updated[0].nodeId, "node-1");
    assert.equal(updated[0].entry.definition, "v. 起诉");
  });
});

test("未带释义时用本地词典补全，并合并词典别名", async () => {
  await withSyncDir(async (dir) => {
    const { port, added } = makePort();
    const withDictionary: InboxVocabularyPort = {
      ...port,
      async lookupDefinition() {
        return { definition: "v. 起诉；控告", aliases: ["Sued", "sues"] };
      },
    };
    await writeInboxAtomic(inboxPathFor(dir), `${line({ id: "1", word: "sue" })}\n`);

    await importInbox(baseOptions(dir, withDictionary));

    assert.equal(added[0].entry.definition, "v. 起诉；控告");
    assert.deepEqual(added[0].entry.aliases, ["sued", "sues"]);
  });
});

test("释义自带时仍会补别名，且不覆盖自带释义", async () => {
  await withSyncDir(async (dir) => {
    const { port, added } = makePort();
    const withDictionary: InboxVocabularyPort = {
      ...port,
      async lookupDefinition() {
        return { definition: "词典释义", aliases: ["Sued"] };
      },
    };
    await writeInboxAtomic(
      inboxPathFor(dir),
      `${line({ id: "1", word: "sue", definition: "自带释义" })}\n`
    );

    await importInbox(baseOptions(dir, withDictionary));

    assert.equal(added[0].entry.definition, "自带释义", "自带释义优先，不被词典覆盖");
    assert.deepEqual(added[0].entry.aliases, ["sued"], "缺失的别名由词典补上并规范化");
  });
});

test("释义与别名都齐全时不查询词典", async () => {
  await withSyncDir(async (dir) => {
    const { port } = makePort();
    let lookups = 0;
    const counting: InboxVocabularyPort = {
      ...port,
      async lookupDefinition() {
        lookups++;
        return undefined;
      },
    };
    await writeInboxAtomic(
      inboxPathFor(dir),
      `${line({ id: "1", word: "sue", definition: "自带释义", aliases: ["sued"] })}\n`
    );

    await importInbox(baseOptions(dir, counting));

    assert.equal(lookups, 0, "两者都齐全时不必查词典");
  });
});

test("坏行原样保留在收件箱，不影响其他条目处理", async () => {
  await withSyncDir(async (dir) => {
    const { port, added } = makePort();
    const bad = "{not json";
    await writeInboxAtomic(
      inboxPathFor(dir),
      `${bad}\n${line({ id: "1", word: "sue" })}\n${"   "}\n`
    );

    const result = await importInbox(baseOptions(dir, port));

    assert.equal(result.added, 1);
    assert.equal(result.badLines, 2);
    assert.equal(added.length, 1);
    assert.equal(await readInboxText(inboxPathFor(dir)), `${bad}\n   \n`);
  });
});

test("全部落库失败时条目归档到 failed 文件并移出收件箱", async () => {
  await withSyncDir(async (dir) => {
    const { port } = makePort({ failAddFor: ["Words/AI Agent.canvas"] });
    const original = `${line({ id: "1", word: "sue" })}\n`;
    await writeInboxAtomic(inboxPathFor(dir), original);

    const result = await importInbox(baseOptions(dir, port));

    assert.equal(result.failed, 1);
    assert.equal(result.added, 0);
    assert.equal(await readInboxText(inboxPathFor(dir)), "");
    const archived = JSON.parse((await readInboxText(inboxFailedPathFor(dir))).trim());
    assert.equal(archived.id, "1");
    assert.equal(archived.reason, "apply-failed");
  });
});

test("没有可用目标词库时判失败并归档（reason=no-target-book）", async () => {
  await withSyncDir(async (dir) => {
    const { port } = makePort();
    await writeInboxAtomic(inboxPathFor(dir), `${line({ id: "1", word: "sue" })}\n`);

    const result = await importInbox({
      syncDir: dir,
      books: [],
      defaultBooks: ["Words/AI Agent.canvas"],
      duplicatePolicy: "skip",
      port,
    });

    assert.equal(result.failed, 1);
    assert.equal(await readInboxText(inboxPathFor(dir)), "");
    const archived = JSON.parse((await readInboxText(inboxFailedPathFor(dir))).trim());
    assert.equal(archived.id, "1");
    assert.equal(archived.reason, "no-target-book");
  });
});

test("收件箱不存在时直接返回零结果", async () => {
  await withSyncDir(async (dir) => {
    const { port } = makePort();
    const result = await importInbox(baseOptions(dir, port));
    assert.deepEqual(result, {
      added: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      badLines: 0,
      duplicatesDropped: 0,
    });
  });
});

test("一条条目可同时落多个词库", async () => {
  await withSyncDir(async (dir) => {
    const { port, added } = makePort();
    await writeInboxAtomic(
      inboxPathFor(dir),
      `${line({
        id: "1",
        word: "sue",
        books: ["Words/Common Law.canvas", "Words/AI Agent.canvas"],
      })}\n`
    );

    const result = await importInbox(baseOptions(dir, port));

    assert.equal(result.added, 2);
    assert.equal(added.length, 2);
  });
});

test("失败的条目归档到 failed 文件并从收件箱移除", async () => {
  await withSyncDir(async (dir) => {
    const { port } = makePort({ failAddFor: ["Words/AI Agent.canvas"] });
    await writeInboxAtomic(inboxPathFor(dir), `${line({ id: "bad-1", word: "sue" })}\n`);

    const result = await importInbox(baseOptions(dir, port));

    assert.equal(result.failed, 1);
    assert.equal(await readInboxText(inboxPathFor(dir)), "");
    const failed = await readInboxText(inboxFailedPathFor(dir));
    const archived = JSON.parse(failed.trim());
    assert.equal(archived.id, "bad-1");
    assert.equal(archived.reason, "apply-failed");
    assert.equal(typeof archived.archivedAt, "string");
  });
});

test("成功处理的 id 记入状态文件，重复投递被幂等丢弃", async () => {
  await withSyncDir(async (dir) => {
    const { port, added } = makePort();
    const payload = line({ id: "dup-1", word: "sue" });
    await writeInboxAtomic(inboxPathFor(dir), `${payload}\n`);
    await importInbox(baseOptions(dir, port));
    assert.equal(added.length, 1);

    await writeInboxAtomic(inboxPathFor(dir), `${payload}\n`);
    const second = await importInbox(baseOptions(dir, port));

    assert.equal(second.added, 0);
    assert.equal(second.duplicatesDropped, 1);
    assert.equal(added.length, 1);
    assert.equal(await readInboxText(inboxPathFor(dir)), "");

    const state = await readInboxState(inboxStatePathFor(dir));
    assert.deepEqual(state.processedIds, ["dup-1"]);
    assert.equal(typeof state.lastRunAt, "string");
  });
});

test("processedIds 环形上限 500，最旧的被挤出", async () => {
  await withSyncDir(async (dir) => {
    const { port } = makePort();
    const lines = Array.from({ length: 501 }, (_, i) => line({ id: `id-${i}`, word: `w${i}` }));
    await writeInboxAtomic(inboxPathFor(dir), `${lines.join("\n")}\n`);

    await importInbox(baseOptions(dir, port));

    const state = await readInboxState(inboxStatePathFor(dir));
    assert.equal(state.processedIds.length, 500);
    assert.equal(state.processedIds.includes("id-0"), false);
    assert.equal(state.processedIds.includes("id-500"), true);
  });
});

test("坏行不计入幂等状态，仍保留在收件箱", async () => {
  await withSyncDir(async (dir) => {
    const { port } = makePort();
    await writeInboxAtomic(inboxPathFor(dir), "{broken\n");

    const result = await importInbox(baseOptions(dir, port));

    assert.equal(result.badLines, 1);
    assert.equal(await readInboxText(inboxPathFor(dir)), "{broken\n");
    const state = await readInboxState(inboxStatePathFor(dir));
    assert.deepEqual(state.processedIds, []);
  });
});

test("并发消费同一收件箱只落库一次", async () => {
  await withSyncDir(async (dir) => {
    const { port, added } = makePort();
    // 让单次落库足够慢，确保第二次调用与第一次真正重叠
    const slowPort: InboxVocabularyPort = {
      ...port,
      async addWord(bookPath, entry) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return port.addWord(bookPath, entry);
      },
    };
    await writeInboxAtomic(inboxPathFor(dir), `${line({ id: "race-1", word: "sue" })}\n`);

    const [first, second] = await Promise.all([
      importInbox(baseOptions(dir, slowPort)),
      importInbox(baseOptions(dir, slowPort)),
    ]);

    assert.equal(added.length, 1, "并发消费只能落库一次，否则 Canvas 会出现重复词条");
    assert.equal(first === second, true, "并发调用应共享同一次消费结果");
    assert.equal(first.added, 1);
    assert.equal(await readInboxText(inboxPathFor(dir)), "");
  });
});

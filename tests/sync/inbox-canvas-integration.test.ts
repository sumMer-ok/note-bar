/**
 * 集成测试：外部助手写入收件箱 → 走真实的 Canvas 写入路径落库。
 *
 * 覆盖（COVERED）
 *   - `importInbox` 消费循环：收件箱清空、条目 id 写入 `note-bar-inbox.state.json`
 *   - `createInboxVocabularyPort`：颜色字符串 "4" → 数字 → 节点 color 字符串 "4"
 *   - `CanvasEditor.addWordToCanvas` 真实读写 `.canvas` JSON 文件
 *   - 节点文本三段格式：词 / 斜体别名行 / 空行 + 释义
 *   - 按当天本地日期 YYYY-MM-DD 建组，并用真实 `CanvasParser.isNodeInGroup` 判定节点几何上落在组内
 *
 * 不覆盖（NOT COVERED，故意收窄）
 *   - `VocabularyManager`（含 `addWordToMultipleCanvas` 的真实实现、`getWordDefinitionsByBook`、
 *     `reloadVocabularyBook` 缓存刷新）：它会把 CodeMirror 与 UI 模块拉进测试包，把 obsidian 替身
 *     撑大，收益不成正比。这里改用「管理器形状的假实现」，只保留接口调用形状与 Canvas 写入路径。
 *   - `SyncManager` 的 fs.watch / 轮询 / 设置联动接线（需要宿主环境），由人工在测试 vault 验证。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TFile } from "obsidian";
import { CanvasEditor } from "../../src/hiwords/canvas/canvas-editor";
import { CanvasParser } from "../../src/hiwords/canvas/canvas-parser";
import { createInboxVocabularyPort } from "../../src/sync/inbox-vocabulary-adapter";
import { importInbox } from "../../src/sync/inbox-importer";
import {
  inboxPathFor,
  inboxStatePathFor,
  readInboxState,
  readInboxText,
} from "../../src/sync/inbox-store";
import type { InboxEntry } from "../../src/sync/inbox-types";
import type { HiWordsSettings } from "../../src/hiwords/utils/types";

// CanvasEditor.genHex16() 用 window.crypto；node 的 globalThis 自带 Web Crypto
(globalThis as any).window = globalThis;

const RELATIVE_BOOK = "Words/AI Agent.canvas";

function todayLabel(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

interface Harness {
  root: string;
  syncDir: string;
  bookAbsPath: string;
  app: any;
  settings: HiWordsSettings;
  editor: CanvasEditor;
}

/** 临时 vault：真实目录 + 真实 .canvas 文件，vault 接口用最小假实现 */
async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "note-bar-inbox-"));
  const syncDir = path.join(root, "inbox");
  const bookAbsPath = path.join(root, "vault", RELATIVE_BOOK);
  await fs.mkdir(syncDir, { recursive: true });
  await fs.mkdir(path.dirname(bookAbsPath), { recursive: true });
  await fs.writeFile(bookAbsPath, '{"nodes":[],"edges":[]}', "utf8");

  const absByPath = new Map<string, string>([[RELATIVE_BOOK, bookAbsPath]]);
  const vault = {
    getAbstractFileByPath(p: string) {
      const abs = absByPath.get(p);
      return abs ? new TFile(abs) : null;
    },
    async cachedRead(file: any) {
      return await fs.readFile(file.path, "utf8");
    },
    async process(file: any, fn: (current: string) => string) {
      const next = fn(await fs.readFile(file.path, "utf8"));
      await fs.writeFile(file.path, next, "utf8");
      return next;
    },
  };

  const app: any = { vault };
  const settings = {
    cardWidth: 260,
    cardHeight: 120,
    autoLayoutEnabled: false,
    masteredDetection: "group",
    vocabularyBooks: [],
  } as unknown as HiWordsSettings;

  return { root, syncDir, bookAbsPath, app, settings, editor: new CanvasEditor(app, settings) };
}

test("外部写入收件箱 → 真实 Canvas 落库：文本格式、日期分组、颜色、状态文件", async () => {
  const h = await createHarness();
  try {
    const entry: InboxEntry = {
      v: 1,
      id: "inbox-1",
      word: "sue",
      definition: "v. 起诉；控告",
      aliases: ["sued", "sues"],
      color: "4",
    };
    await fs.writeFile(inboxPathFor(h.syncDir), `${JSON.stringify(entry)}\n`, "utf8");

    // 管理器形状的假实现：只保留适配器实际调用的方法面
    const addCalls: any[] = [];
    const manager = {
      async getWordDefinitionsByBook() {
        return [];
      },
      async addWordToMultipleCanvas(
        books: string[],
        word: string,
        definition: string,
        color?: number,
        aliases?: string[]
      ) {
        addCalls.push({ books, word, definition, color, aliases });
        for (const book of books) {
          const nodeId = await h.editor.addWordToCanvas(book, word, definition, color, aliases);
          if (!nodeId) return false;
        }
        return true;
      },
      async updateWordInCanvas() {
        return true;
      },
    };

    const port = createInboxVocabularyPort({ manager });
    const result = await importInbox({
      syncDir: h.syncDir,
      books: [RELATIVE_BOOK],
      defaultBooks: [RELATIVE_BOOK],
      duplicatePolicy: "skip",
      port,
    });

    assert.equal(result.added, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.badLines, 0);
    assert.deepEqual(addCalls[0], {
      books: [RELATIVE_BOOK],
      word: "sue",
      definition: "v. 起诉；控告",
      color: 4,
      aliases: ["sued", "sues"],
    });

    const canvas = JSON.parse(await fs.readFile(h.bookAbsPath, "utf8"));

    // (a) 文本节点：词 / 斜体别名行 / 空行 + 释义
    const textNode = canvas.nodes.find((n: any) => n.type === "text");
    assert.ok(textNode, "应写入一个 text 节点");
    assert.equal(textNode.text, "sue\n*sued, sues*\n\nv. 起诉；控告");

    // (b) 落在今天日期分组内（用真实 CanvasParser 判定几何包含）
    const group = canvas.nodes.find((n: any) => n.type === "group" && n.label === todayLabel());
    assert.ok(group, `应存在 label 为 ${todayLabel()} 的分组节点`);
    const parser = new CanvasParser(h.app, h.settings);
    assert.equal(parser.isNodeInGroup(textNode, group), true);
    // 写进去的节点也应能被真实解析器读回（含添加日期归属）
    const parsedDefs = await parser.parseCanvasFile(new TFile(h.bookAbsPath));
    assert.equal(parsedDefs.length, 1);
    assert.equal(parsedDefs[0].word, "sue");
    assert.deepEqual(parsedDefs[0].aliases, ["sued", "sues"]);
    assert.equal(parsedDefs[0].definition, "v. 起诉；控告");
    assert.equal(parsedDefs[0].addedDate, todayLabel());

    // (c) 颜色落成字符串
    assert.equal(typeof textNode.color, "string");
    assert.equal(textNode.color, "4");

    // (d) 收件箱清空 + 条目 id 记入状态文件
    assert.equal(await readInboxText(inboxPathFor(h.syncDir)), "");
    const state = await readInboxState(inboxStatePathFor(h.syncDir));
    assert.deepEqual(state.processedIds, ["inbox-1"]);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

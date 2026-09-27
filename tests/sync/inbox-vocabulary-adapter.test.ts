import { test } from "node:test";
import assert from "node:assert/strict";
import { createInboxVocabularyPort } from "../../src/sync/inbox-vocabulary-adapter";
import type { InboxEntry } from "../../src/sync/inbox-types";

function entry(partial: Partial<InboxEntry> & { word: string }): InboxEntry {
  return { v: 1, id: "a1", ...partial };
}

test("findExisting 命中主词与别名，且忽略 retired 词", async () => {
  const definitions = [
    { word: "sue", nodeId: "n1", aliases: ["sued"], status: "active" },
    { word: "fine", nodeId: "n2", aliases: [], status: "retired" },
  ];
  const manager = {
    async getWordDefinitionsByBook() {
      return definitions as any;
    },
    async addWordToMultipleCanvas() {
      return true;
    },
    async updateWordInCanvas() {
      return true;
    },
  };
  const port = createInboxVocabularyPort({ manager: manager as any });

  assert.deepEqual(await port.findExisting("a.canvas", "SUE"), { nodeId: "n1" });
  assert.deepEqual(await port.findExisting("a.canvas", "sued"), { nodeId: "n1" });
  assert.equal(await port.findExisting("a.canvas", "fine"), null);
  assert.equal(await port.findExisting("a.canvas", "unknown"), null);
});

test("addWord 把颜色字符串转成数字并透传释义与别名", async () => {
  const calls: any[] = [];
  const manager = {
    async getWordDefinitionsByBook() {
      return [];
    },
    async addWordToMultipleCanvas(...args: any[]) {
      calls.push(args);
      return true;
    },
    async updateWordInCanvas() {
      return true;
    },
  };
  const port = createInboxVocabularyPort({ manager: manager as any });

  const ok = await port.addWord(
    "Words/AI Agent.canvas",
    entry({ word: "sue", definition: "v. 起诉", aliases: ["sued"], color: "4" })
  );

  assert.equal(ok, true);
  // 第 6 个参数 awaitWrite：收件箱必须等落盘确认，否则失败条目会被当成成功消费
  assert.deepEqual(calls[0], [
    ["Words/AI Agent.canvas"],
    "sue",
    "v. 起诉",
    4,
    ["sued"],
    { awaitWrite: true },
  ]);
});

test("颜色缺失或非法时传 undefined，释义缺失传空串", async () => {
  const calls: any[] = [];
  const manager = {
    async getWordDefinitionsByBook() {
      return [];
    },
    async addWordToMultipleCanvas(...args: any[]) {
      calls.push(args);
      return true;
    },
    async updateWordInCanvas() {
      return true;
    },
  };
  const port = createInboxVocabularyPort({ manager: manager as any });

  await port.addWord("b.canvas", entry({ word: "sue" }));
  await port.addWord("b.canvas", entry({ word: "sue", color: "not-a-number" }));

  assert.deepEqual(calls[0], [["b.canvas"], "sue", "", undefined, undefined, { awaitWrite: true }]);
  assert.deepEqual(calls[1], [["b.canvas"], "sue", "", undefined, undefined, { awaitWrite: true }]);
});

test("updateWord 透传节点 id", async () => {
  const calls: any[] = [];
  const manager = {
    async getWordDefinitionsByBook() {
      return [];
    },
    async addWordToMultipleCanvas() {
      return true;
    },
    async updateWordInCanvas(...args: any[]) {
      calls.push(args);
      return true;
    },
  };
  const port = createInboxVocabularyPort({ manager: manager as any });

  await port.updateWord("c.canvas", "node-9", entry({ word: "sue", definition: "新释义" }));

  assert.deepEqual(calls[0], ["c.canvas", "node-9", "sue", "新释义", undefined, undefined]);
});

test("lookupDefinition 拼装音标与释义，未注入词典时返回 undefined", async () => {
  const dictionary = {
    async lookupAll(word: string) {
      assert.equal(word, "sue");
      return { word, phonetic: "英/ suː /", definitions: ["v. 起诉", "n. 诉讼"], aliases: ["sued"] };
    },
  };
  const port = createInboxVocabularyPort({
    manager: { getWordDefinitionsByBook: async () => [], addWordToMultipleCanvas: async () => true, updateWordInCanvas: async () => true } as any,
    dictionary: dictionary as any,
  });
  const filled = await port.lookupDefinition("sue");
  assert.equal(filled?.definition, "英/ suː /\nv. 起诉\nn. 诉讼");
  assert.deepEqual(filled?.aliases, ["sued"]);

  const noDict = createInboxVocabularyPort({
    manager: { getWordDefinitionsByBook: async () => [], addWordToMultipleCanvas: async () => true, updateWordInCanvas: async () => true } as any,
  });
  assert.equal(await noDict.lookupDefinition("sue"), undefined);
});

test("lookupDefinition 只有音标而无释义时仍返回音标", async () => {
  const dictionary = {
    async lookupAll(word: string) {
      return { word, phonetic: "英/ suː /", definitions: [], aliases: [] };
    },
  };
  const port = createInboxVocabularyPort({
    manager: { getWordDefinitionsByBook: async () => [], addWordToMultipleCanvas: async () => true, updateWordInCanvas: async () => true } as any,
    dictionary: dictionary as any,
  });
  assert.equal((await port.lookupDefinition("sue"))?.definition, "英/ suː /");
});

test("lookupDefinition 把法律词典单独成节，标题与插件侧分节约定一致", async () => {
  const dictionary = {
    async lookupAll(word: string) {
      return {
        word,
        phonetic: "英/ rɪˈvəʊk /",
        definitions: ["vt. 撤销；废除"],
        aliases: ["revoked"],
        legalDefinitions: ["To annul or make void by recalling or taking back."],
        legalPos: "vb",
        legalYear: "18c",
      };
    },
  };
  const port = createInboxVocabularyPort({
    manager: { getWordDefinitionsByBook: async () => [], addWordToMultipleCanvas: async () => true, updateWordInCanvas: async () => true } as any,
    dictionary: dictionary as any,
  });

  const filled = await port.lookupDefinition("revoke");
  assert.equal(
    filled?.definition,
    "英/ rɪˈvəʊk /\nvt. 撤销；废除\n\n--- Black's Law Dictionary ---\nvb. To annul or make void by recalling or taking back.（18c）"
  );
  assert.deepEqual(filled?.aliases, ["revoked"]);
});

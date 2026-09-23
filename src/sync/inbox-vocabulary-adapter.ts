import type { VocabularyManager } from "../hiwords/core/vocabulary-manager";
import type { LocalDictionaryService } from "../hiwords/services/local-dictionary-service";
import type { InboxEntry } from "./inbox-types";
import type { InboxVocabularyPort } from "./inbox-importer";

export interface InboxAdapterDeps {
  /** 只取落库与查重所需的最小方法面，便于测试注入假实现 */
  manager: Pick<
    VocabularyManager,
    "getWordDefinitionsByBook" | "addWordToMultipleCanvas" | "updateWordInCanvas"
  >;
  /** 未注入或未启用词典时，释义补全直接跳过 */
  dictionary?: Pick<LocalDictionaryService, "lookupAll">;
}

function toColorValue(color: string | undefined): number | undefined {
  if (!color) return undefined;
  const value = Number.parseInt(color, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** 把收件箱端口接到既有 VocabularyManager 上：节点文本格式、日期分组、排版全部由它负责 */
export function createInboxVocabularyPort(deps: InboxAdapterDeps): InboxVocabularyPort {
  const { manager, dictionary } = deps;

  return {
    async findExisting(bookPath: string, word: string) {
      const definitions = await manager.getWordDefinitionsByBook(bookPath);
      const normalized = word.toLowerCase();
      const hit = definitions.find(
        (def) =>
          def.status !== "retired" &&
          (def.word.toLowerCase() === normalized ||
            (def.aliases ?? []).some((alias) => alias.toLowerCase() === normalized))
      );
      return hit ? { nodeId: hit.nodeId } : null;
    },

    async addWord(bookPath: string, entry: InboxEntry) {
      return await manager.addWordToMultipleCanvas(
        [bookPath],
        entry.word,
        entry.definition ?? "",
        toColorValue(entry.color),
        entry.aliases
      );
    },

    async updateWord(bookPath: string, nodeId: string, entry: InboxEntry) {
      return await manager.updateWordInCanvas(
        bookPath,
        nodeId,
        entry.word,
        entry.definition ?? "",
        toColorValue(entry.color),
        entry.aliases
      );
    },

    async lookupDefinition(word: string) {
      if (!dictionary) return undefined;
      const result = await dictionary.lookupAll(word);
      if (!result) return undefined;
      const parts: string[] = [];
      if (result.phonetic) parts.push(result.phonetic);
      if (result.definitions.length > 0) parts.push(result.definitions.join("\n"));
      return {
        definition: parts.length > 0 ? parts.join("\n") : undefined,
        aliases: result.aliases,
      };
    },
  };
}

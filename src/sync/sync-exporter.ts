import { promises as fs } from "fs";
import type { VocabularyManager } from "../hiwords/core/vocabulary-manager";
import type { HiWordsSettings, StudyProgressItem } from "../hiwords/utils";
import { readSidecar, sidecarPathForBook, writeSidecarAtomic } from "./sidecar-store";
import { deriveStudyKey } from "./study-key";
import { SIDECAR_VERSION, type SidecarFile, type SyncExportResult } from "./types";

export interface ExporterDeps {
  settings: HiWordsSettings;
  vocabularyManager: VocabularyManager;
  syncDir: string;
}

/** 把 data.json 的 studyProgress 按词库导出为边车；孤儿进度键留在 data.json，不导出 */
export async function exportProgressToSidecars(deps: ExporterDeps): Promise<SyncExportResult> {
  const result: SyncExportResult = { written: 0, unchanged: 0, failed: [] };
  const progress: Record<string, StudyProgressItem> = deps.settings.studyProgress || {};
  const books = deps.settings.vocabularyBooks.filter(
    (book) => book.enabled && book.path.endsWith(".canvas")
  );
  const updatedAt = new Date().toISOString();

  for (const book of books) {
    try {
      const definitions = await deps.vocabularyManager.getWordDefinitionsByBook(book.path);
      const words: Record<string, StudyProgressItem> = {};
      for (const definition of definitions) {
        const key = deriveStudyKey(definition);
        const item = progress[key];
        if (item) words[key] = item;
      }

      const filePath = sidecarPathForBook(deps.syncDir, book.path);
      // 区分「文件不存在」与「文件已存在但解析失败」：后者不覆盖，避免绕过 lastReview 仲裁
      let existing: SidecarFile | null = null;
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat) {
        existing = await readSidecar(filePath);
        if (!existing) {
          result.failed.push(book.path);
          continue;
        }
      }
      if (existing && JSON.stringify(existing.words) === JSON.stringify(words)) {
        result.unchanged++;
        continue;
      }

      await writeSidecarAtomic(filePath, {
        version: SIDECAR_VERSION,
        book: book.path,
        words,
        updatedAt,
      });
      result.written++;
    } catch {
      result.failed.push(book.path);
    }
  }
  return result;
}

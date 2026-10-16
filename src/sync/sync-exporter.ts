import { promises as fs } from "fs";
import type { VocabularyManager } from "../hiwords/core/vocabulary-manager";
import type { HiWordsSettings, StudyProgressItem } from "../hiwords/utils";
import { readSidecar, sidecarPathForBook, writeSidecarAtomic } from "./sidecar-store";
import { mergeProgress } from "./merge";
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
      // **逐键仲裁后再写，绝不做整体覆盖**（2026-10-17 真机事故的真实根因）：
      // 本函数不是边车的唯一作者——手机端按词增量写边车，网盘通道也会写。
      // 原先这里直接用 words（纯由 data.json 推导）整体覆盖文件，于是在
      // 「导出触发得比导入早」的窗口里（src/main.ts 会单独调 exportAll()，没有前置导入），
      // 只存在于边车里的较新进度会被较旧的整份数据抹掉。
      // 现象：iOS 读自己的本地库显示待复习 93，Android 读被覆盖后的边车显示 201，两端长期不一致。
      // 这里与导入侧保持同一套仲裁：lastReview 较新者胜 + 落败方非空字段回落 + history 去重。
      // 边车里存在、而本次 words 未覆盖的键一律**保留**：那可能是别端刚写入、本端尚未看到的进度，
      // 删掉即数据丢失（边车是共享通道，孤儿键最多是无害冗余）。
      const mergedWords: Record<string, StudyProgressItem> = { ...(existing?.words ?? {}) };
      for (const [key, item] of Object.entries(words)) {
        mergedWords[key] = mergeProgress(item, existing?.words?.[key]) ?? item;
      }

      if (existing && JSON.stringify(existing.words) === JSON.stringify(mergedWords)) {
        result.unchanged++;
        continue;
      }

      await writeSidecarAtomic(filePath, {
        version: SIDECAR_VERSION,
        book: book.path,
        words: mergedWords,
        updatedAt,
      });
      result.written++;
    } catch {
      result.failed.push(book.path);
    }
  }
  return result;
}

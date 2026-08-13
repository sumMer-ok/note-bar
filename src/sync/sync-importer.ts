import { promises as fs } from "fs";
import * as path from "path";
import type { HiWordsSettings } from "../hiwords/utils";
import { conflictCopyBaseName, mergeProgress, timeOf } from "./merge";
import { readSidecar } from "./sidecar-store";
import type { SidecarFile, SyncImportResult } from "./types";

export interface ImporterDeps {
  settings: HiWordsSettings;
  syncDir: string;
}

/** 把同步目录里所有已启用词库的边车合并回 data.json */
export async function importSidecars(deps: ImporterDeps): Promise<SyncImportResult> {
  const result: SyncImportResult = { mergedKeys: 0, conflictsArchived: [] };
  if (!deps.settings.studyProgress) deps.settings.studyProgress = {};
  const progress = deps.settings.studyProgress;
  const books = deps.settings.vocabularyBooks.filter(
    (book) => book.enabled && book.path.endsWith(".canvas")
  );

  for (const book of books) {
    const base = book.path.replace(/\.canvas$/, "");
    const mainName = `${base}.nb-sync.json`;
    const mainPath = path.join(deps.syncDir, mainName);
    let selected: SidecarFile | null = await readSidecar(mainPath);
    let selectedName = mainName;

    const entries = await fs.readdir(deps.syncDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (conflictCopyBaseName(entry) !== mainName) continue;
      const conflict = await readSidecar(path.join(deps.syncDir, entry));
      if (conflict && timeOf(conflict.updatedAt) > timeOf(selected?.updatedAt)) {
        selected = conflict;
        selectedName = entry;
      }
    }

    if (selectedName !== mainName && selected) {
      const archive = `${mainPath}.conflict-${Date.now()}.bak`;
      await fs.rename(mainPath, archive).catch(() => undefined);
      await fs.copyFile(path.join(deps.syncDir, selectedName), mainPath);
      await fs.rename(path.join(deps.syncDir, selectedName), `${selectedName}.processed`).catch(() => undefined);
      result.conflictsArchived.push(book.path);
    }

    if (!selected) continue;
    for (const [key, remote] of Object.entries(selected.words)) {
      const merged = mergeProgress(progress[key], remote);
      if (merged) progress[key] = merged;
      result.mergedKeys++;
    }
  }
  return result;
}

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
    const mainDir = path.dirname(mainPath);
    const mainBase = path.basename(mainName);
    let selected: SidecarFile | null = await readSidecar(mainPath);
    let selectedPath = mainPath;
    let selectedName = mainBase;

    // 旧版 iPhone App 可能把边车写到 syncDir/Words/Words，取 updatedAt 较新的一份
    const nestedPath = book.path.startsWith("Words/")
      ? path.join(deps.syncDir, "Words", mainName)
      : null;
    if (nestedPath) {
      const nested = await readSidecar(nestedPath);
      if (nested && timeOf(nested.updatedAt) > timeOf(selected?.updatedAt)) {
        selected = nested;
        selectedPath = nestedPath;
      }
    }

    // 冲突副本与主文件同目录（可能是嵌套目录，不能只扫 syncDir 顶层）
    const entries = await fs.readdir(mainDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (conflictCopyBaseName(entry) !== mainBase) continue;
      const conflict = await readSidecar(path.join(mainDir, entry));
      if (conflict && timeOf(conflict.updatedAt) > timeOf(selected?.updatedAt)) {
        selected = conflict;
        selectedPath = path.join(mainDir, entry);
        selectedName = entry;
      }
    }

    if (selectedName !== mainBase && selected) {
      const archive = `${mainPath}.conflict-${Date.now()}.bak`;
      await fs.rename(mainPath, archive).catch(() => undefined);
      const selectedPath = path.join(mainDir, selectedName);
      await fs.copyFile(selectedPath, mainPath);
      await fs.rename(selectedPath, `${selectedPath}.processed`).catch(() => undefined);
      result.conflictsArchived.push(book.path);
    }

    // 选中的是嵌套副本时，把它提升回规范路径，后续导出与手机都能读到
    if (selectedPath !== mainPath && selected) {
      await fs.mkdir(path.dirname(mainPath), { recursive: true }).catch(() => undefined);
      await fs.copyFile(selectedPath, mainPath).catch(() => undefined);
    }

    if (!selected) continue;
    for (const [key, remote] of Object.entries(selected.words)) {
      const before = progress[key] ? JSON.stringify(progress[key]) : null;
      const merged = mergeProgress(progress[key], remote);
      if (merged) progress[key] = merged;
      if (JSON.stringify(merged ?? null) !== before) result.mergedKeys++;
    }
  }
  return result;
}

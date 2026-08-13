import type { StudyProgressItem } from "../hiwords/utils";

export const SIDECAR_VERSION = 1;
export const SIDECAR_SUFFIX = ".nb-sync.json";

/** 一个词库对应的进度边车文件（只存进度，不存单词内容） */
export interface SidecarFile {
  version: number;
  /** 词库 .canvas 在 vault/同步目录中的相对路径 */
  book: string;
  words: Record<string, StudyProgressItem>;
  updatedAt: string;
}

export interface SyncExportResult {
  written: number;
  unchanged: number;
  failed: string[];
}

export interface SyncImportResult {
  mergedKeys: number;
  conflictsArchived: string[];
}

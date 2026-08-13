import type { ReviewRecord, StudyProgressItem } from "../hiwords/utils";

const HISTORY_LIMIT = 50;

export function timeOf(value: string | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

export function mergeHistory(
  a: ReviewRecord[] | undefined,
  b: ReviewRecord[] | undefined
): ReviewRecord[] | undefined {
  const map = new Map<string, ReviewRecord>();
  for (const record of [...(a || []), ...(b || [])]) {
    const key = `${record.date}|${record.quality}`;
    const existing = map.get(key);
    if (!existing || timeOf(record.date) >= timeOf(existing.date)) {
      map.set(key, record);
    }
  }
  const merged = Array.from(map.values()).sort(
    (x, y) => timeOf(x.date) - timeOf(y.date)
  );
  return merged.length > 0 ? merged.slice(-HISTORY_LIMIT) : undefined;
}

/** 同 key 进度合并：lastReview 较新者胜；history 去重合并（保留 50 条） */
export function mergeProgress(
  local: StudyProgressItem | undefined,
  remote: StudyProgressItem | undefined
): StudyProgressItem | undefined {
  if (!local) return remote;
  if (!remote) return local;
  const winner = timeOf(remote.lastReview) > timeOf(local.lastReview) ? remote : local;
  const loser = winner === remote ? local : remote;
  const merged: StudyProgressItem = { ...loser, ...winner };
  const history = mergeHistory(local.history, remote.history);
  if (history) merged.history = history;
  return merged;
}

/** Apple iCloud 冲突副本：`<name> <n>.nb-sync.json` */
export function isConflictCopyName(fileName: string): boolean {
  return /^.+ \d+\.nb-sync\.json$/.test(fileName);
}

export function conflictCopyBaseName(fileName: string): string | null {
  const match = /^(.+) \d+\.nb-sync\.json$/.exec(fileName);
  return match ? `${match[1]}.nb-sync.json` : null;
}

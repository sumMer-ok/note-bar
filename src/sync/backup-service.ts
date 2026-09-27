/**
 * 词库独立快照备份（链路外备份层，P1）。
 *
 * 事故教训：三份副本（vault、iCloud、iCloud 嵌套）会一起坏，**同步副本不等于备份**；
 * 上次能救回全靠 Obsidian 快照，属运气。本模块把快照写到 **vault 之外、iCloud 之外**：
 * `~/Documents/note-bar-backups/<book-path-with-slashes-replaced>/<YYYY-MM-DD-HHmmss>.canvas`
 *
 * 行为：
 * - 触发：某词库成功写入后防抖 30 秒快照一次；另有每 60 分钟全量体检式快照；
 * - 快照前校验（validateCanvasText），不合法就拒绝快照并告警——绝不把坏文件写进备份；
 * - 保留策略：最近 20 份 + 每天 1 份保留 30 天；
 * - 写入走 temp + rename，避免留下半截文件。
 *
 * 约束（CLAUDE.md 纯逻辑规则）：本文件不 import obsidian，只 `import type`；
 * 根目录 / 时钟 / fs 均可注入，因此保留策略与调度逻辑可直接 `node --test` 用临时目录验证。
 */

import { promises as nodeFs } from "fs";
import * as os from "os";
import * as path from "path";
import { validateCanvasText } from "./canvas-integrity";
import type { VocabularyBook } from "../hiwords/utils";

/** 备份默认根目录：`~/Documents/note-bar-backups` */
export const DEFAULT_BACKUP_DIR_NAME = "note-bar-backups";
export const DEFAULT_KEEP_RECENT = 20;
export const DEFAULT_KEEP_DAILY_DAYS = 30;
/** 写入成功后的快照防抖 */
export const DEFAULT_BACKUP_DEBOUNCE_MS = 30_000;
/** 全量体检式快照周期 */
export const DEFAULT_BACKUP_SWEEP_MS = 60 * 60 * 1000;

/** 只声明本模块真正用到的 fs 能力，便于单测注入 */
export interface BackupFs {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, data: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  stat(filePath: string): Promise<{ mtimeMs: number; size: number }>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

const defaultFs: BackupFs = {
  readFile: (filePath) => nodeFs.readFile(filePath, "utf8"),
  writeFile: (filePath, data) => nodeFs.writeFile(filePath, data, "utf8"),
  mkdir: async (dir) => {
    await nodeFs.mkdir(dir, { recursive: true });
  },
  readdir: (dir) => nodeFs.readdir(dir),
  stat: async (filePath) => {
    const stat = await nodeFs.stat(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  },
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (filePath) => nodeFs.unlink(filePath),
};

/** `~/Documents/note-bar-backups`（不落在 vault 内、不落在 iCloud 内） */
export function defaultBackupRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, "Documents", DEFAULT_BACKUP_DIR_NAME);
}

/**
 * 词库相对路径 → 备份子目录名：斜杠替换为 `__`（保持单层目录，避免和 vault 结构耦合）。
 * `Words/Common Law.canvas` → `Words__Common Law.canvas`
 */
export function backupDirNameFor(bookPath: string): string {
  const normalized = bookPath.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized.split("/").filter((segment) => segment.length > 0).join("__");
}

/** 快照文件名：`<YYYY-MM-DD-HHmmss>.canvas`（本地时区） */
export function backupFileNameFor(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${ymd}-${hms}.canvas`;
}

export interface SnapshotFile {
  name: string;
  mtimeMs: number;
}

export interface RetentionOptions {
  /** 最近 N 份无条件保留 */
  keepRecent: number;
  /** 每天 1 份保留 N 天 */
  keepDailyDays: number;
  now: Date;
}

function localDayStartMs(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 保留策略（纯函数）：返回**应当删除**的快照文件名。
 * 保留集合 = 最近 keepRecent 份 ∪ {最近 keepDailyDays 天内每天最新的一份}；
 * 未来时间戳（时钟回拨/手工改名）一律保留，避免误删。
 */
export function selectSnapshotsToDelete(snapshots: SnapshotFile[], options: RetentionOptions): string[] {
  const keepRecent = Math.max(0, options.keepRecent);
  const keepDailyDays = Math.max(0, options.keepDailyDays);
  const sorted = [...snapshots].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const keep = new Set<string>();
  for (const snapshot of sorted.slice(0, keepRecent)) keep.add(snapshot.name);

  const todayStart = localDayStartMs(options.now.getTime());
  const seenDay = new Set<string>();
  for (const snapshot of sorted) {
    const dayStart = localDayStartMs(snapshot.mtimeMs);
    const ageDays = Math.floor((todayStart - dayStart) / 86400000);
    if (ageDays < 0) {
      keep.add(snapshot.name);
      continue;
    }
    if (ageDays >= keepDailyDays) continue;
    const dayKey = String(dayStart);
    if (seenDay.has(dayKey)) continue;
    seenDay.add(dayKey);
    keep.add(snapshot.name);
  }

  return sorted.filter((snapshot) => !keep.has(snapshot.name)).map((snapshot) => snapshot.name);
}

export interface CanvasBackupOptions {
  /** vault 绝对路径 */
  vaultBasePath: string;
  /** 已启用词库（可传 getter，设置变化后无需重建服务） */
  books: VocabularyBook[] | (() => VocabularyBook[]);
  /** 备份根目录；缺省 `~/Documents/note-bar-backups` */
  rootDir?: string;
  keepRecent?: number;
  keepDailyDays?: number;
  /** 注入 fs / 时钟，单测用 */
  fs?: BackupFs;
  now?: () => Date;
  /** 告警出口（main.ts 接 Notice）；缺省只打 console */
  onError?: (message: string) => void;
  debounceMs?: number;
  sweepIntervalMs?: number;
  /** 定时器注入（测试里可换成假计时器）；缺省用全局 setInterval/setTimeout */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface BackupResult {
  ok: boolean;
  /** 快照文件绝对路径（成功时） */
  path?: string;
  /** 失败原因（稳定短串）：read-failed / invalid:<reason> / write-failed */
  reason?: string;
}

/** 列出某词库已有快照（按时间倒序由调用方决定） */
export async function listBackups(
  rootDir: string,
  bookPath: string,
  fsImpl: BackupFs = defaultFs
): Promise<string[]> {
  const dir = path.join(rootDir, backupDirNameFor(bookPath));
  const entries = await fsImpl.readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((entry) => entry.endsWith(".canvas"))
    .map((entry) => path.join(dir, entry))
    .sort();
}

/** 最近一份快照路径（体检命令用它指路）；没有则返回 null */
export async function newestBackupPath(
  rootDir: string,
  bookPath: string,
  fsImpl: BackupFs = defaultFs
): Promise<string | null> {
  const files = await listBackups(rootDir, bookPath, fsImpl);
  let newest: { filePath: string; mtimeMs: number } | null = null;
  for (const filePath of files) {
    const stat = await fsImpl.stat(filePath).catch(() => null);
    if (!stat) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { filePath, mtimeMs: stat.mtimeMs };
  }
  return newest ? newest.filePath : null;
}

/**
 * 词库快照服务：写入成功后防抖快照 + 每小时全量快照 + 保留策略裁剪。
 * 所有副作用（定时器）都由 stop() 收回，插件卸载时必须调用。
 */
export class CanvasBackupService {
  private readonly fsImpl: BackupFs;
  private readonly rootDir: string;
  private readonly keepRecent: number;
  private readonly keepDailyDays: number;
  private readonly debounceMs: number;
  private readonly sweepIntervalMs: number;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: CanvasBackupOptions) {
    this.fsImpl = options.fs ?? defaultFs;
    this.rootDir = options.rootDir && options.rootDir.trim().length > 0 ? options.rootDir : defaultBackupRoot();
    this.keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
    this.keepDailyDays = options.keepDailyDays ?? DEFAULT_KEEP_DAILY_DAYS;
    this.debounceMs = options.debounceMs ?? DEFAULT_BACKUP_DEBOUNCE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_BACKUP_SWEEP_MS;
  }

  get backupRoot(): string {
    return this.rootDir;
  }

  private get books(): VocabularyBook[] {
    const source = this.options.books;
    return (typeof source === "function" ? source() : source).filter(
      (book) => book.enabled && book.path.endsWith(".canvas")
    );
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private reportError(message: string): void {
    if (this.options.onError) this.options.onError(message);
    else console.warn(`Note Bar 备份: ${message}`);
  }

  /** 启动周期快照；可重复调用（先停旧的） */
  start(): void {
    this.stopSweep();
    const setIntervalFn =
      this.options.setIntervalFn ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
    this.sweepTimer = setIntervalFn(() => {
      void this.sweep();
    }, this.sweepIntervalMs);
  }

  /** 停止所有定时器（防抖中的快照也一并取消） */
  stop(): void {
    this.stopSweep();
    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();
  }

  private stopSweep(): void {
    if (this.sweepTimer !== null) {
      const clearIntervalFn =
        this.options.clearIntervalFn ??
        ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));
      clearIntervalFn(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** 词条成功写入该词库后调用：防抖 30 秒快照一次 */
  scheduleBackup(bookPath: string): void {
    if (!this.isEnabledBook(bookPath)) return;
    const existing = this.debounceTimers.get(bookPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(bookPath);
      void this.backupBook(bookPath);
    }, this.debounceMs);
    // Node 里 unref 掉，避免测试进程/退出流程被挂起
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
    this.debounceTimers.set(bookPath, timer);
  }

  /** 立即挂起一次快照（跳过防抖），供测试与手动触发使用 */
  async backupNow(bookPath: string): Promise<BackupResult> {
    const existing = this.debounceTimers.get(bookPath);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(bookPath);
    }
    return await this.backupBook(bookPath);
  }

  /** 全量快照：逐个启用词库校验并快照 */
  async sweep(): Promise<{ created: number; skipped: number; failed: number }> {
    let created = 0;
    let skipped = 0;
    let failed = 0;
    for (const book of this.books) {
      const result = await this.backupBook(book.path);
      if (result.ok) created++;
      else if (result.reason && result.reason.startsWith("invalid:")) skipped++;
      else failed++;
    }
    return { created, skipped, failed };
  }

  /** 快照单个词库：先校验，再 temp+rename 落盘，最后按保留策略裁剪 */
  async backupBook(bookPath: string): Promise<BackupResult> {
    const absolute = path.join(this.options.vaultBasePath, bookPath);
    let raw: string;
    try {
      raw = await this.fsImpl.readFile(absolute);
    } catch {
      const reason = "read-failed";
      this.reportError(`词库读取失败，已跳过备份：${bookPath}（${reason}）`);
      return { ok: false, reason };
    }

    const verdict = validateCanvasText(raw);
    if (!verdict.ok) {
      const reason = `invalid:${verdict.reason}`;
      this.reportError(`词库校验失败，已拒绝备份：${bookPath}（${verdict.reason}）`);
      return { ok: false, reason };
    }

    const dir = path.join(this.rootDir, backupDirNameFor(bookPath));
    const target = path.join(dir, backupFileNameFor(this.now()));
    const temp = `${target}.tmp`;
    try {
      await this.fsImpl.mkdir(dir);
      await this.fsImpl.writeFile(temp, raw);
      await this.fsImpl.rename(temp, target);
    } catch {
      const reason = "write-failed";
      this.reportError(`快照写入失败：${bookPath}（${reason}）`);
      return { ok: false, reason };
    }

    await this.prune(dir);
    return { ok: true, path: target };
  }

  /** 按保留策略裁剪快照 */
  private async prune(dir: string): Promise<void> {
    const entries = await this.fsImpl.readdir(dir).catch(() => [] as string[]);
    const snapshots: SnapshotFile[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".canvas")) continue;
      const stat = await this.fsImpl.stat(path.join(dir, entry)).catch(() => null);
      if (!stat) continue;
      snapshots.push({ name: entry, mtimeMs: stat.mtimeMs });
    }
    const doomed = selectSnapshotsToDelete(snapshots, {
      keepRecent: this.keepRecent,
      keepDailyDays: this.keepDailyDays,
      now: this.now(),
    });
    for (const name of doomed) {
      await this.fsImpl.unlink(path.join(dir, name)).catch(() => undefined);
    }
  }

  private isEnabledBook(bookPath: string): boolean {
    return this.books.some((book) => book.path === bookPath);
  }
}

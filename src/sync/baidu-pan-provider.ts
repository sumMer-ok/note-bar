/**
 * 百度网盘同步 provider：把 vault 的词库（`Words/*.canvas`）与进度边车
 * （`*.nb-sync.json`）镜像到网盘，并把 Android 端写回的边车拉回来合并。
 *
 * ## 复用既有三层护栏（不重新发明）
 * 1. **采纳前校验**（`canvas-integrity.validateCanvasText`）：远端下回来的 Canvas
 *    先在内存里校验，坏内容**绝不落盘**，与 `mirrorer` 一样另存为 `.suspect-*.canvas`
 *    供人工判断——「同步副本不等于备份」的事故教训在此同样适用；
 * 2. **写入后快照**（`backup-service.CanvasBackupService.scheduleBackup`）：每次
 *    采纳远端 Canvas 后立刻挂起一次防抖快照，坏数据永远不会是唯一副本；
 * 3. **审计日志**（`canvas-audit.appendAuditLine`，actor=`baidupan`）：记下写前/写后
 *    字节数与 sha1 前 12 位，出问题能定位「是谁写的、写完是否结构合法」。
 *
 * ## 进度合并
 * 边车合并完全复用 `merge.ts` 的 `mergeProgress`（lastReview 较新者胜 + history 去重），
 * 语义与 iCloud 手机同步保持一致。
 *
 * ## 失败必须用户可见
 * 任何失败都走 `reportError` → `onError`（main.ts 接 Notice）+ 失败日志文件，
 * 绝不静默（参考 `vocabulary-manager.reportWriteFailure` 的两条缺一不可）。
 *
 * ## 边界
 * 远端路径一律以 `/apps/<应用名>/Words/...` 为前缀；越界路径在客户端层直接抛错。
 * 本文件对 obsidian 只 `import type`，因此可被 node:test 用假 client 直接驱动。
 */

import { promises as fs } from "fs";
import * as path from "path";
import { appendAuditLine, appendLogLine, sha1Short12, utf8ByteLength } from "./canvas-audit";
import { validateCanvasText } from "./canvas-integrity";
import type { CanvasBackupService } from "./backup-service";
import { mergeProgress } from "./merge";
import type { BaiduPanClient } from "./baidu-pan-client";
import { readSidecar, sidecarPathForBook, writeSidecarAtomic } from "./sidecar-store";
import { SIDECAR_SUFFIX, SIDECAR_VERSION, type SidecarFile } from "./types";
import type { HiWordsSettings, StudyProgressItem, VocabularyBook } from "../hiwords/utils/types";

/** 远端边车与本地边车命名一致：`<词库名>.nb-sync.json` */
function remoteSidecarName(bookPath: string): string {
  const base = bookPath.endsWith(".canvas") ? bookPath.slice(0, -".canvas".length) : bookPath;
  return `${base}${SIDECAR_SUFFIX}`;
}

/** 远端 Canvas 文件名：`Words/AI.canvas` → `AI.canvas`（网盘上已在 Words/ 目录内） */
function remoteBaseName(bookPath: string): string {
  return bookPath.split("/").pop() || bookPath;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  size: number;
  serverMtimeMs: number;
}

/**
 * 只声明 provider 真正用到的 client 能力，方便单测注入假对象；
 * `BaiduPanClient` 结构性满足该接口（见文件末尾 `BaiduPanClientLike`）。
 */
export interface BaiduPanRemote {
  readonly sandboxRoot: string;
  readonly wordsDir: string;
  /** 返回 null 表示该路径在网盘上不存在（不是错误） */
  fileMetas(
    paths: string[],
    options?: { dlink?: boolean }
  ): Promise<Array<(RemoteFileEntry & { dlink: string | null }) | null>>;
  downloadFile(path: string): Promise<Uint8Array>;
  uploadFile(
    path: string,
    bytes: Uint8Array,
    options?: { ondup?: "fail" | "overwrite" | "newcopy" }
  ): Promise<unknown>;
  ensureFolder(path: string): Promise<void>;
}

export interface BaiduPanProviderOptions {
  settings: HiWordsSettings;
  /** 云端客户端（或单测假实现） */
  client: BaiduPanRemote;
  /** vault 绝对路径；为 null 时只同步进度、不落地 Canvas 文件（移动端） */
  vaultBasePath?: string | null;
  /** 本地边车根目录（与 iCloud 手机同步同一约定：`<syncDir>/<book路径>`） */
  localSidecarDir: string;
  /** 词库快照服务（写入后快照）；缺省跳过快照但仍记审计 */
  backup?: CanvasBackupService | null;
  /** 审计日志路径；`null` 关闭审计 */
  auditLogPath?: string | null;
  /** 失败日志路径；`null` 关闭 */
  failureLogPath?: string | null;
  /** 失败出口（main.ts 接 Notice）：接入后用户一定看得见 */
  onError?: (message: string) => void;
  /** 进度合并后把 data.json 落盘（main.ts 传 saveHiWordsSettings） */
  saveSettings?: () => Promise<void> | void;
  /** 进度合入后的收尾（重建缓存 + 刷新高亮） */
  onProgressMerged?: (result: BaiduPanSyncResult) => void;
  now?: () => Date;
  /** 单次下载体积上限（防御远端异常大文件打爆内存），默认 32MB */
  maxDownloadBytes?: number;
}

export interface BaiduPanSyncResult {
  /** 上传成功的词库数（内容确有变化才上传） */
  uploaded: number;
  /** 下载并采纳的 Canvas 数 */
  downloaded: number;
  /** 因校验失败而拒绝采纳的 Canvas 数 */
  rejected: number;
  /** 从远端边车合并进来的进度键数 */
  mergedKeys: number;
  /** 边车上传数 */
  sidecarsUploaded: number;
  failed: string[];
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/**
 * 百度网盘同步 provider。
 *
 * 一次 `syncOnce()` 的顺序（与 SyncManager.start 的「先导入后导出」一致）：
 * 1. 确保远端 `/apps/<dir>/Words` 存在；
 * 2. **拉取**：远端边车 → 合并进度；远端 Canvas → 校验后落盘并快照；
 * 3. **推送**：本地边车与内容有变化的 Canvas 上传。
 * 拉取在前，避免刚写上去的本地进度又被远端旧值覆盖。
 */
export class BaiduPanProvider {
  private readonly settings: HiWordsSettings;
  private readonly client: BaiduPanRemote;
  private readonly vaultBasePath: string | null;
  private readonly localSidecarDir: string;
  private readonly backup: CanvasBackupService | null;
  private readonly now: () => Date;
  private readonly maxDownloadBytes: number;
  private lastError: string | null = null;
  /** 待落盘的失败日志（reportError 是同步方法，日志写入在这里排队，syncOnce 收尾时统一 await） */
  private pendingFailureLogs: Array<Promise<unknown>> = [];

  constructor(private readonly options: BaiduPanProviderOptions) {
    this.settings = options.settings;
    this.client = options.client;
    this.vaultBasePath = options.vaultBasePath ?? null;
    this.localSidecarDir = options.localSidecarDir;
    this.backup = options.backup ?? null;
    this.now = options.now ?? (() => new Date());
    this.maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  }

  /** 最近一次失败的可读原因（设置面板展示用） */
  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  get remoteWordsDir(): string {
    return this.client.wordsDir;
  }

  private get books(): VocabularyBook[] {
    return this.settings.vocabularyBooks.filter((book) => book.enabled && book.path.endsWith(".canvas"));
  }

  /**
   * 本地边车目录为空时：**不做任何边车读写**。
   * 否则 `path.join("", "Words/x.nb-sync.json")` 会相对进程 cwd 解析，
   * 可能把边车写到工作目录里（既污染又可能覆盖无关文件）。
   */
  private get hasSidecarDir(): boolean {
    return this.localSidecarDir.trim().length > 0;
  }

  /** 失败可见：console + onError（Notice） + 失败日志，三者缺一不可 */
  private reportError(message: string, bookPath?: string): void {
    this.lastError = message;
    console.warn(`Note Bar 百度网盘同步: ${message}`);
    if (this.options.onError) this.options.onError(message);
    const logPath = this.options.failureLogPath;
    if (logPath) {
      // 记下来，在 syncOnce 收尾时统一 await：既不阻塞告警，也不会丢日志
      this.pendingFailureLogs.push(
        appendLogLine(
          logPath,
          `${this.now().toISOString()} | book=${bookPath ?? "-"} | reason=${message.replace(/\s+/g, " ")}`
        )
      );
    }
  }

  /** 一次完整双向同步；异常在内部消化成 `failed` + 可见告警，不抛给调用方 */
  async syncOnce(): Promise<BaiduPanSyncResult> {
    const result: BaiduPanSyncResult = {
      uploaded: 0,
      downloaded: 0,
      rejected: 0,
      mergedKeys: 0,
      sidecarsUploaded: 0,
      failed: [],
    };
    this.lastError = null;
    this.pendingFailureLogs = [];

    try {
      try {
        await this.client.ensureFolder(this.client.wordsDir);
      } catch (error) {
        this.reportError(`无法准备网盘目录 ${this.client.wordsDir}：${this.describe(error)}`);
        return result;
      }

      await this.pullSidecars(result);
      await this.pullCanvases(result);
      await this.pushSidecars(result);
      await this.pushCanvases(result);
      if (this.options.onProgressMerged) this.options.onProgressMerged(result);
      return result;
    } finally {
      await this.flushFailureLogs();
    }
  }

  /** 收尾时把排队的失败日志落盘（日志失败不能影响同步本身） */
  private async flushFailureLogs(): Promise<void> {
    const pending = this.pendingFailureLogs;
    this.pendingFailureLogs = [];
    if (pending.length === 0) return;
    await Promise.all(pending.map((item) => item.catch(() => undefined)));
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // ------------------------------------------------------------- 拉取远端

  /** 远端边车 → 合并进 data.json（复用 merge.ts 的仲裁规则） */
  private async pullSidecars(result: BaiduPanSyncResult): Promise<void> {
    if (!this.settings.studyProgress) this.settings.studyProgress = {};
    const progress = this.settings.studyProgress;
    let merged = 0;

    for (const book of this.books) {
      const name = remoteSidecarName(book.path);
      const remotePath = `${this.client.wordsDir}/${name}`;
      let bookChanged = false;
      try {
        const bytes = await this.downloadIfExists(remotePath);
        if (bytes === null) continue;
        const remote = this.parseSidecar(new TextDecoder("utf-8").decode(bytes));
        if (!remote) {
          this.reportError(`远端边车内容非法，已拒绝合并：${name}`, book.path);
          result.failed.push(book.path);
          continue;
        }
        for (const [key, incoming] of Object.entries(remote.words)) {
          const before = progress[key] ? JSON.stringify(progress[key]) : null;
          const mergedItem = mergeProgress(progress[key], incoming as StudyProgressItem);
          if (mergedItem) progress[key] = mergedItem;
          if (JSON.stringify(mergedItem ?? null) !== before) {
            merged++;
            bookChanged = true;
          }
        }
        // 只有本轮真的合并出新内容时才回写本地边车：
        // 否则每轮都用新的 updatedAt 重写一遍，会导致与远端永远不相等 → 无限重复上传。
        // 未配置本地边车目录时跳过（绝不相对 cwd 落盘）。
        if (bookChanged && this.hasSidecarDir) {
          await this.rewriteLocalSidecar(book.path, progress, Object.keys(remote.words), remote.updatedAt);
        }
      } catch (error) {
        this.reportError(`拉取远端边车失败（${name}）：${this.describe(error)}`, book.path);
        result.failed.push(book.path);
      }
    }

    if (merged > 0) {
      try {
        await this.options.saveSettings?.();
      } catch (error) {
        this.reportError(`进度合并后写回设置失败：${this.describe(error)}`);
      }
    }
    result.mergedKeys = merged;
  }

  /** 远端 Canvas → 校验 → 落盘 → 快照 → 审计（坏候选另存 `.suspect-*`） */
  private async pullCanvases(result: BaiduPanSyncResult): Promise<void> {
    if (!this.vaultBasePath) return;
    for (const book of this.books) {
      const name = remoteBaseName(book.path);
      const remotePath = `${this.client.wordsDir}/${name}`;
      const vaultFile = path.join(this.vaultBasePath, book.path);
      try {
        const [meta] = await this.client.fileMetas([remotePath]);
        if (!meta) continue;
        const localStat = await fs.stat(vaultFile).catch(() => null);
        // 网盘 mtime 为秒级，容差取 1 秒（与 mirrorer 同款判据）
        if (localStat && meta.serverMtimeMs <= localStat.mtimeMs + 1000) continue;

        const bytes = await this.downloadBytes(remotePath, name, book.path, result);
        if (bytes === null) continue;
        const raw = new TextDecoder("utf-8").decode(bytes);
        const before = await fs.readFile(vaultFile, "utf8").catch(() => null);
        const verdict = validateCanvasText(raw);
        if (!verdict.ok) {
          // 采纳前校验失败：绝不覆盖 vault，另存可疑副本并告警（与 mirrorer 同策略）
          const suspect = await this.preserveSuspect(book.path, raw);
          result.rejected++;
          this.reportError(
            `远端词库校验失败（${verdict.reason}），已拒绝覆盖本地：${book.path}；候选已另存为 ${suspect}`,
            book.path
          );
          continue;
        }

        await fs.mkdir(path.dirname(vaultFile), { recursive: true });
        const temp = `${vaultFile}.baidupan-tmp`;
        await fs.writeFile(temp, raw, "utf8");
        await fs.rename(temp, vaultFile);
        result.downloaded++;

        await this.recordAudit(book.path, before, raw);
        this.warnOnSuspiciousShrink(book.path, before, raw);
        // 写入后快照：坏数据永不成为唯一副本
        this.backup?.scheduleBackup(book.path);
      } catch (error) {
        this.reportError(`拉取远端词库失败（${name}）：${this.describe(error)}`, book.path);
        result.failed.push(book.path);
      }
    }
  }

  // ------------------------------------------------------------- 推送远端

  /** 本地边车 → 远端（内容一致则跳过，减少配额消耗） */
  private async pushSidecars(result: BaiduPanSyncResult): Promise<void> {
    if (!this.hasSidecarDir) return;
    for (const book of this.books) {
      const localPath = sidecarPathForBook(this.localSidecarDir, book.path);
      const name = remoteSidecarName(book.path);
      const remotePath = `${this.client.wordsDir}/${name}`;
      try {
        const localRaw = await fs.readFile(localPath, "utf8").catch(() => null);
        if (localRaw === null) continue;
        const remoteRaw = await this.readRemoteText(remotePath);
        // 语义比较而不是逐字节比较：updatedAt 每次导出都会变，逐字节比较会导致永远不相等、
        // 每轮都重传（配额杀手）。这里只要 words 一致就认为无需上传。
        if (remoteRaw !== null && this.sameSidecarContent(localRaw, remoteRaw)) continue;
        await this.client.uploadFile(remotePath, new TextEncoder().encode(localRaw), { ondup: "overwrite" });
        result.sidecarsUploaded++;
      } catch (error) {
        this.reportError(`上传边车失败（${name}）：${this.describe(error)}`, book.path);
        result.failed.push(book.path);
      }
    }
  }

  /** vault 词库 → 远端（仅在内容确有差异时上传，避免每轮轮询都吃配额） */
  private async pushCanvases(result: BaiduPanSyncResult): Promise<void> {
    if (!this.vaultBasePath) return;
    for (const book of this.books) {
      const vaultFile = path.join(this.vaultBasePath, book.path);
      const name = remoteBaseName(book.path);
      const remotePath = `${this.client.wordsDir}/${name}`;
      try {
        const localRaw = await fs.readFile(vaultFile, "utf8").catch(() => null);
        if (localRaw === null) continue;
        const verdict = validateCanvasText(localRaw);
        if (!verdict.ok) {
          // 本地就是坏的：拒绝上传，避免把坏数据扩散到云端（与 mirrorer 同判据）
          this.reportError(`本地词库校验失败（${verdict.reason}），已拒绝上传：${book.path}`, book.path);
          result.failed.push(book.path);
          continue;
        }
        const remoteRaw = await this.readRemoteText(remotePath);
        if (remoteRaw !== null && remoteRaw === localRaw) continue;

        await this.client.uploadFile(remotePath, new TextEncoder().encode(localRaw), { ondup: "overwrite" });
        result.uploaded++;
        await this.recordAudit(book.path, remoteRaw, localRaw);
      } catch (error) {
        this.reportError(`上传词库失败（${name}）：${this.describe(error)}`, book.path);
        result.failed.push(book.path);
      }
    }
  }

  // ------------------------------------------------------------- 工具方法

  /** 文件不存在（含路径批量查询的单文件 errno）返回 null，不作为失败上报 */
  private async downloadIfExists(remotePath: string): Promise<Uint8Array | null> {
    const [meta] = await this.client.fileMetas([remotePath]);
    if (!meta) return null;
    return await this.downloadBytes(remotePath, meta.name || remotePath, undefined, null);
  }

  /** 统一的下载入口：体积上限超限时按失败上报并返回 null */
  private async downloadBytes(
    remotePath: string,
    name: string,
    bookPath: string | undefined,
    result: BaiduPanSyncResult | null
  ): Promise<Uint8Array | null> {
    const bytes = await this.client.downloadFile(remotePath);
    if (bytes.byteLength > this.maxDownloadBytes) {
      this.reportError(`远端文件过大（${bytes.byteLength} 字节），已跳过：${name}`, bookPath);
      result?.failed.push(bookPath ?? name);
      return null;
    }
    return bytes;
  }

  /** 读远端文本用于「是否需要上传」比较；不存在返回 null，过大按失败处理（不盲目覆盖大文件） */
  private async readRemoteText(remotePath: string): Promise<string | null> {
    const [meta] = await this.client.fileMetas([remotePath]);
    if (!meta) return null;
    const bytes = await this.client.downloadFile(remotePath);
    if (bytes.byteLength > this.maxDownloadBytes) {
      throw new Error(`远端文件过大（${bytes.byteLength} 字节），拒绝覆盖：${remotePath}`);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  private parseSidecar(text: string): SidecarFile | null {
    try {
      const data = JSON.parse(text) as Partial<SidecarFile>;
      if (
        data?.version !== SIDECAR_VERSION ||
        typeof data.book !== "string" ||
        !data.words ||
        typeof data.words !== "object" ||
        Array.isArray(data.words)
      ) {
        return null;
      }
      for (const value of Object.values(data.words as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      }
      return {
        version: SIDECAR_VERSION,
        book: data.book,
        words: data.words as SidecarFile["words"],
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date(0).toISOString(),
      };
    } catch {
      return null;
    }
  }

  /** 两份边车文本的进度内容是否等价（忽略 updatedAt 这类元信息） */
  private sameSidecarContent(a: string, b: string): boolean {
    const left = this.parseSidecar(a);
    const right = this.parseSidecar(b);
    if (!left || !right) return false;
    if (left.book !== right.book) return false;
    return JSON.stringify(left.words) === JSON.stringify(right.words);
  }

  /**
   * 合并后的进度写回本地边车：键集合 = 既有边车键 ∪ 远端边车键
   * （远端边车是「这些键属于该词库」的唯一权威来源，不能凭进度对象反推词库归属）。
   * `updatedAt` 直接沿用远端的时间戳，保证重复合并结果字节稳定。
   */
  private async rewriteLocalSidecar(
    bookPath: string,
    progress: Record<string, StudyProgressItem>,
    remoteKeys: string[],
    remoteUpdatedAt: string
  ): Promise<void> {
    const localPath = sidecarPathForBook(this.localSidecarDir, bookPath);
    const existing = await readSidecar(localPath);
    const keys = new Set<string>([...(existing ? Object.keys(existing.words) : []), ...remoteKeys]);
    if (keys.size === 0) return;
    const words: Record<string, StudyProgressItem> = {};
    for (const key of keys) {
      const item = progress[key];
      if (item) words[key] = item;
    }
    await writeSidecarAtomic(localPath, {
      version: SIDECAR_VERSION,
      book: bookPath,
      words,
      updatedAt: remoteUpdatedAt,
    });
  }

  /** 校验失败的远端 Canvas：另存 `.suspect-*.canvas`，绝不删除也绝不覆盖 vault */
  private async preserveSuspect(bookPath: string, raw: string): Promise<string> {
    const dir = path.join(this.vaultBasePath!, path.dirname(bookPath));
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const name = `${path.basename(bookPath, ".canvas")}.suspect-${stamp}.canvas`;
    const target = path.join(dir, name);
    try {
      await fs.mkdir(dir, { recursive: true });
      const temp = `${target}.tmp`;
      await fs.writeFile(temp, raw, "utf8");
      await fs.rename(temp, target);
    } catch (error) {
      console.warn("Note Bar 另存可疑网盘镜像失败:", bookPath, error);
    }
    return name;
  }

  /** 节点数骤降的额外防御：结构合法不阻断，但必须让用户看见（与 mirrorer 一致） */
  private warnOnSuspiciousShrink(bookPath: string, before: string | null, after: string): void {
    if (before === null) return;
    const previous = validateCanvasText(before);
    const next = validateCanvasText(after);
    if (!previous.ok || !next.ok) return;
    if (next.nodeCount >= previous.nodeCount * 0.6) return;
    this.reportError(
      `网盘镜像节点数骤降：${bookPath} 由 ${previous.nodeCount} 个节点变为 ${next.nodeCount} 个，请确认不是截断`,
      bookPath
    );
  }

  private async recordAudit(bookPath: string, before: string | null, after: string | null): Promise<void> {
    const logPath = this.options.auditLogPath;
    if (!logPath) return;
    await appendAuditLine(logPath, {
      timestamp: this.now(),
      actor: "baidupan",
      book: bookPath,
      bytesBefore: before === null ? 0 : utf8ByteLength(before),
      bytesAfter: after === null ? 0 : utf8ByteLength(after),
      sha1Before: before === null ? "-" : sha1Short12(before),
      sha1After: after === null ? "-" : sha1Short12(after),
      validated: after !== null && validateCanvasText(after).ok,
    });
  }
}

/** 编译期衔接：真实 client 必须结构化满足 provider 需要的远端接口 */
export type BaiduPanClientLike = Pick<
  BaiduPanClient,
  "sandboxRoot" | "wordsDir" | "fileMetas" | "downloadFile" | "uploadFile" | "ensureFolder"
>;

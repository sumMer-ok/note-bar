import { promises as fs } from "fs";
import * as path from "path";
import type { VocabularyBook } from "../hiwords/utils";
import {
  isConflictCopyName,
  isSuspiciousShrink,
  suspectCanvasName,
  validateCanvasText,
  type CanvasValidationResult,
} from "./canvas-integrity";
import { appendAuditLine, canvasAuditLogPath, sha1Short12 } from "./canvas-audit";

export interface MirrorerOptions {
  vaultBasePath: string;
  syncDir: string;
  books: VocabularyBook[];
  onConflict: (message: string) => void;
  onVaultChanged: (bookPath: string) => void;
  /** 注入时钟（为可疑副本命名与冲突检测提供确定性）；缺省用系统时间 */
  now?: () => Date;
  /**
   * iCloud 未物化探测（`com.apple.icloud.itemName` xattr）。
   * 缺省做特性探测：运行时没有该 API 就当作「无法判断」，不影响任何复制决策。
   */
  getXattr?: ((filePath: string, name: string) => Promise<string | null>) | null;
  /** 审计日志路径；传 null 关闭审计；缺省 `<vault>/.obsidian/plugins/note-bar/canvas-audit.log` */
  auditLogPath?: string | null;
}

/** iCloud 未物化文件携带的扩展属性名 */
const ICLOUD_XATTR = "com.apple.icloud.itemName";

/**
 * 特性探测 Node 的 xattr 读取能力。
 * Node 24 核心 fs 尚无 getxattr，因此这里多数时候返回 null（不引入任何依赖，也不失败）。
 */
function resolveGetXattr(): ((filePath: string, name: string) => Promise<string | null>) | null {
  const candidate = (fs as unknown as { getxattr?: unknown }).getxattr;
  if (typeof candidate !== "function") return null;
  const fn = candidate as (p: string, name: string, cb?: (err: unknown, value: unknown) => void) => unknown;
  return async (filePath, name) => {
    // 回调式签名（arity ≥ 3）与 Promise 式签名都兼容
    if (fn.length >= 3) {
      return await new Promise<string | null>((resolve, reject) => {
        fn(filePath, name, (error, value) => {
          if (error) reject(error);
          else resolve(value === undefined || value === null ? null : String(value));
        });
      });
    }
    const value = await fn(filePath, name);
    return value === undefined || value === null ? null : String(value);
  };
}

/** vault 内 Canvas ⇄ iCloud 同步目录双向镜像（mtime 比较 + 轮询兜底 + 采纳前校验） */
export class Mirrorer {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** xattr 探测函数缓存：undefined = 尚未探测 */
  private xattrProbe: ((filePath: string, name: string) => Promise<string | null>) | null | undefined;

  constructor(private readonly opts: MirrorerOptions) {}

  private get bookPaths(): string[] {
    return this.opts.books
      .filter((book) => book.enabled && book.path.endsWith(".canvas"))
      .map((book) => book.path);
  }

  start(pollIntervalSec: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.syncOnce();
    }, Math.max(1, pollIntervalSec) * 1000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  stop(): void {
    this.stopPolling();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  scheduleSync(bookPath: string, delayMs = 1500): void {
    if (!this.bookPaths.includes(bookPath)) return;
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== timer);
      void this.syncBook(bookPath);
    }, delayMs);
    this.timers.push(timer);
  }

  async syncOnce(): Promise<void> {
    for (const bookPath of this.bookPaths) {
      await this.syncBook(bookPath);
    }
  }

  private async syncBook(bookPath: string): Promise<void> {
    try {
      await this.mirrorBook(bookPath);
    } catch (error) {
      console.warn("Note Bar mirrorer 同步失败:", bookPath, error);
    }
    await this.detectCanvasConflicts(bookPath);
  }

  private async mirrorBook(bookPath: string): Promise<void> {
    const src = path.join(this.opts.vaultBasePath, bookPath);
    const dst = path.join(this.opts.syncDir, bookPath);
    // 旧版 iPhone App 曾把文件写到 syncDir/Words/Words 的错误路径。
    // 这里把「规范路径」和「嵌套路径」里较新的一份当作镜像的真实内容，
    // 这样即使手机还没升级，编辑也能同步到电脑端。
    const nestedDst = bookPath.startsWith("Words/")
      ? path.join(this.opts.syncDir, "Words", bookPath)
      : null;

    // 未物化（`.icloud` 占位 / 带 iCloud xattr 的 dataless 文件）内容不完整：
    // 复制它只会把坏数据扩散到另一侧，本轮直接跳过。
    // 注意要对「固定路径」判断：文件被驱逐后实体不存在，只剩 `<名字>.icloud` 占位。
    const unmaterialized = await Promise.all([
      this.isUnmaterialized(src),
      this.isUnmaterialized(dst),
      nestedDst ? this.isUnmaterialized(nestedDst) : Promise.resolve(false),
    ]);
    if (unmaterialized.some(Boolean)) return;

    const dstChoice = await this.newerOf(dst, nestedDst);

    const [srcStat, dstStat] = await Promise.all([
      fs.stat(src).catch(() => null),
      dstChoice ? fs.stat(dstChoice).catch(() => null) : Promise.resolve(null),
    ]);
    if (!srcStat && !dstStat) return;

    // 采纳前校验：坏 JSON 不许顶替好文件（2026-09-26 三份副本一起坏的根因）
    const vaultRaw = srcStat ? await this.readText(src) : null;
    const copyRaw = dstStat ? await this.readText(dstChoice!) : null;
    const vaultVerdict: CanvasValidationResult | null = vaultRaw === null ? null : validateCanvasText(vaultRaw);
    const copyVerdict: CanvasValidationResult | null = copyRaw === null ? null : validateCanvasText(copyRaw);

    // 候选副本非法 → 拒绝覆盖 vault，另存为 .suspect-*.canvas 并告警
    let copyInAllowed = copyVerdict?.ok === true;
    if (dstStat && !copyInAllowed) {
      if (copyRaw !== null) {
        const suspectName = await this.preserveSuspect(bookPath, copyRaw);
        const reason = copyVerdict && !copyVerdict.ok ? copyVerdict.reason : "unreadable";
        this.opts.onConflict(
          `镜像候选校验失败（${reason}），已拒绝覆盖词库：${bookPath}；候选已另存为 ${suspectName}`
        );
      }
    }

    // 只有一个例外允许「坏 vault」存在：同步侧有一份合法副本，此时用副本修回 vault
    if (vaultRaw !== null && vaultVerdict !== null && !vaultVerdict.ok) {
      if (copyInAllowed && dstChoice) {
        await this.copyIntoVault(bookPath, dstChoice, src, dst, nestedDst);
      } else {
        this.opts.onConflict(
          `词库文件校验失败（${vaultVerdict.reason}），已拒绝写入同步目录：${bookPath}`
        );
      }
      return;
    }

    if (srcStat && !dstStat) {
      await this.copyOut(bookPath, src, dst, nestedDst);
      return;
    }
    if (!srcStat && dstStat) {
      if (copyInAllowed && dstChoice) {
        await this.copyIntoVault(bookPath, dstChoice, src, dst, nestedDst);
      }
      return;
    }
    if (Math.abs(srcStat!.mtimeMs - dstStat!.mtimeMs) < 1000) {
      // iCloud Drive 的 mtime 可能被抹平或缓存，用文件大小兜底判断是否有变化。
      if (srcStat!.size !== dstStat!.size) {
        const mirrorNewer = dstStat!.mtimeMs > srcStat!.mtimeMs;
        if (mirrorNewer || (dstStat!.mtimeMs === srcStat!.mtimeMs && dstChoice === nestedDst)) {
          if (copyInAllowed) {
            await this.copyIntoVault(bookPath, dstChoice!, src, dst, nestedDst);
          }
        } else {
          await this.copyOut(bookPath, src, dst, nestedDst);
        }
      } else if (dstChoice === nestedDst) {
        // 内容一样但只有嵌套副本更新过：把它提升到规范路径
        await this.promoteNested(dstChoice!, dst, nestedDst);
      }
      return;
    }
    if (srcStat!.mtimeMs > dstStat!.mtimeMs) {
      await this.copyOut(bookPath, src, dst, nestedDst);
    } else if (copyInAllowed) {
      await this.copyIntoVault(bookPath, dstChoice!, src, dst, nestedDst);
    }
  }

  /** 副本 → vault：采纳前已校验过候选，这里只负责复制、审计与通知 */
  private async copyIntoVault(
    bookPath: string,
    candidate: string,
    src: string,
    dst: string,
    nestedDst: string | null
  ): Promise<void> {
    const before = await this.readText(src);
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.copyFile(candidate, src);
    const after = await this.readText(src);
    await this.recordAudit(bookPath, before, after);
    this.warnOnSuspiciousShrink(bookPath, before, after, "采纳副本");
    await this.promoteNested(candidate, dst, nestedDst);
    this.opts.onVaultChanged(bookPath);
  }

  /** vault → 副本：调用方保证 vault 内容已校验通过 */
  private async copyOut(bookPath: string, src: string, dst: string, nestedDst: string | null): Promise<void> {
    const before = await this.readText(dst);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    if (nestedDst && nestedDst !== dst) await fs.copyFile(src, nestedDst).catch(() => undefined);
    const after = await this.readText(dst);
    await this.recordAudit(bookPath, before, after);
    this.warnOnSuspiciousShrink(bookPath, before, after, "推出 vault");
  }

  /**
   * 节点数骤降的额外防御（P0-2）：两侧都是合法 JSON，但新版本比旧版本少 40% 以上节点。
   * 结构合法 ⇒ 不阻断（可能是用户真的批量删词，且阻断会每轮轮询反复告警），
   * 但必须让用户看见，并留在审计里。
   */
  private warnOnSuspiciousShrink(
    bookPath: string,
    previous: string | null,
    next: string | null,
    direction: string
  ): void {
    if (previous === null || next === null) return;
    const previousVerdict = validateCanvasText(previous);
    const nextVerdict = validateCanvasText(next);
    if (!previousVerdict.ok || !nextVerdict.ok) return;
    if (!isSuspiciousShrink(nextVerdict.nodeCount, previousVerdict.nodeCount)) return;
    this.opts.onConflict(
      `镜像节点数骤降（${direction}）：${bookPath} 由 ${previousVerdict.nodeCount} 个节点变为 ${nextVerdict.nodeCount} 个，请确认不是截断`
    );
  }

  /** 把校验失败的候选原样另存到同步目录（绝不删除、绝不覆盖 vault） */
  private async preserveSuspect(bookPath: string, raw: string): Promise<string> {
    const dir = path.dirname(path.join(this.opts.syncDir, bookPath));
    const name = suspectCanvasName(path.basename(bookPath), this.now());
    const target = path.join(dir, name);
    try {
      await fs.mkdir(dir, { recursive: true });
      const temp = `${target}.tmp`;
      await fs.writeFile(temp, raw, "utf8");
      await fs.rename(temp, target);
    } catch (error) {
      console.warn("Note Bar 另存可疑镜像失败:", bookPath, error);
    }
    return name;
  }

  /**
   * 未物化/占位文件判断，命中任意一条即认为内容不完整、本轮不复制：
   * - 路径本身以 `.icloud` 结尾；
   * - 存在同名 `.icloud` 占位（iCloud 把已驱逐文件替换成 `<名字>.icloud`）；
   * - 带 `com.apple.icloud.itemName` xattr（仅在运行时存在该 API 时才查）。
   */
  private async isUnmaterialized(filePath: string): Promise<boolean> {
    if (filePath.endsWith(".icloud")) return true;
    const placeholder = await fs
      .stat(`${filePath}.icloud`)
      .then(() => true)
      .catch(() => false);
    if (placeholder) return true;

    const probe = this.resolveXattrProbe();
    if (!probe) return false;
    try {
      const value = await probe(filePath, ICLOUD_XATTR);
      return typeof value === "string" && value.length > 0;
    } catch {
      // 读不到 xattr 只说明「判断不了」，绝不能因此跳过同步
      return false;
    }
  }

  private resolveXattrProbe(): ((filePath: string, name: string) => Promise<string | null>) | null {
    if (this.xattrProbe === undefined) {
      this.xattrProbe = this.opts.getXattr === undefined ? resolveGetXattr() : this.opts.getXattr;
    }
    return this.xattrProbe;
  }

  private async readText(filePath: string | null): Promise<string | null> {
    if (!filePath) return null;
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private auditPath(): string | null {
    if (this.opts.auditLogPath !== undefined) return this.opts.auditLogPath;
    return canvasAuditLogPath(this.opts.vaultBasePath);
  }

  /** 审计：镜像每复制一次记一行（写前/写后字节数与 sha1 前 12 位 + 复制后是否结构合法） */
  private async recordAudit(bookPath: string, before: string | null, after: string | null): Promise<void> {
    const logPath = this.auditPath();
    if (!logPath) return;
    await appendAuditLine(logPath, {
      timestamp: this.now(),
      actor: "mirror",
      book: bookPath,
      bytesBefore: before === null ? 0 : Buffer.byteLength(before, "utf8"),
      bytesAfter: after === null ? 0 : Buffer.byteLength(after, "utf8"),
      sha1Before: before === null ? "-" : sha1Short12(before),
      sha1After: after === null ? "-" : sha1Short12(after),
      validated: after !== null && validateCanvasText(after).ok,
    });
  }

  private async newerOf(a: string, b: string | null): Promise<string | null> {
    const [sa, sb] = await Promise.all([
      fs.stat(a).catch(() => null),
      b ? fs.stat(b).catch(() => null) : Promise.resolve(null),
    ]);
    if (sa && sb) return sb.mtimeMs > sa.mtimeMs ? b : a;
    if (sa) return a;
    if (sb) return b;
    return null;
  }

  private async promoteNested(source: string, canonical: string, nestedDst: string | null): Promise<void> {
    if (!nestedDst || source !== nestedDst) return;
    try {
      await fs.mkdir(path.dirname(canonical), { recursive: true });
      await fs.copyFile(source, canonical);
    } catch (error) {
      console.warn("Note Bar 提升嵌套镜像失败:", error);
    }
  }

  /**
   * 冲突副本识别：新命名 `<book>.conflict-<date>-<time>.canvas`（Syncthing 风格，保留不删），
   * 同时兼容旧命名 `<book> <n>.canvas`。
   */
  private async detectCanvasConflicts(bookPath: string): Promise<void> {
    const fileName = path.basename(bookPath);
    const dir = path.dirname(path.join(this.opts.syncDir, bookPath));
    try {
      const entries = await fs.readdir(dir);
      const conflicts = entries.filter((entry) => isConflictCopyName(fileName, entry));
      if (conflicts.length > 0) {
        this.opts.onConflict(`检测到 Canvas 冲突副本：${conflicts.join("、")}，请人工选择保留版本`);
      }
    } catch {
      // 目录不存在时忽略
    }
  }
}

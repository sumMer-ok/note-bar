import { promises as fs } from "fs";
import * as path from "path";
import type { VocabularyBook } from "../hiwords/utils";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MirrorerOptions {
  vaultBasePath: string;
  syncDir: string;
  books: VocabularyBook[];
  onConflict: (message: string) => void;
  onVaultChanged: (bookPath: string) => void;
}

/** vault 内 Canvas ⇄ iCloud 同步目录双向镜像（mtime 比较 + 轮询兜底） */
export class Mirrorer {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

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
    const src = path.join(this.opts.vaultBasePath, bookPath);
    const dst = path.join(this.opts.syncDir, bookPath);
    try {
      // 旧版 iPhone App 曾把文件写到 syncDir/Words/Words 的错误路径。
      // 这里把「规范路径」和「嵌套路径」里较新的一份当作镜像的真实内容，
      // 这样即使手机还没升级，编辑也能同步到电脑端。
      const nestedDst = bookPath.startsWith("Words/")
        ? path.join(this.opts.syncDir, "Words", bookPath)
        : null;
      const dstChoice = await this.newerOf(dst, nestedDst);
      const [srcStat, dstStat] = await Promise.all([
        fs.stat(src).catch(() => null),
        dstChoice ? fs.stat(dstChoice).catch(() => null) : Promise.resolve(null),
      ]);
      if (!srcStat && !dstStat) return;
      if (srcStat && !dstStat) {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
        return;
      }
      if (!srcStat && dstStat) {
        await fs.mkdir(path.dirname(src), { recursive: true });
        await fs.copyFile(dstChoice!, src);
        await this.promoteNested(dstChoice!, dst, nestedDst);
        this.opts.onVaultChanged(bookPath);
        return;
      }
      if (Math.abs(srcStat!.mtimeMs - dstStat!.mtimeMs) < 1000) {
        // iCloud Drive 的 mtime 可能被抹平或缓存，用文件大小兜底判断是否有变化。
        if (srcStat!.size !== dstStat!.size) {
          const mirrorNewer = dstStat!.mtimeMs > srcStat!.mtimeMs;
          if (mirrorNewer || (dstStat!.mtimeMs === srcStat!.mtimeMs && dstChoice === nestedDst)) {
            await fs.copyFile(dstChoice!, src);
            await this.promoteNested(dstChoice!, dst, nestedDst);
            this.opts.onVaultChanged(bookPath);
          } else {
            await fs.copyFile(src, dst);
            if (nestedDst) await fs.copyFile(src, nestedDst).catch(() => undefined);
          }
        } else if (dstChoice === nestedDst) {
          // 内容一样但只有嵌套副本更新过：把它提升到规范路径
          await this.promoteNested(dstChoice!, dst, nestedDst);
        }
        await this.detectCanvasConflicts(bookPath);
        return;
      }
      if (srcStat!.mtimeMs > dstStat!.mtimeMs) {
        await fs.copyFile(src, dst);
        if (nestedDst) await fs.copyFile(src, nestedDst).catch(() => undefined);
      } else {
        await fs.copyFile(dstChoice!, src);
        await this.promoteNested(dstChoice!, dst, nestedDst);
        this.opts.onVaultChanged(bookPath);
      }
    } catch (error) {
      console.warn("Note Bar mirrorer 同步失败:", bookPath, error);
    }
    await this.detectCanvasConflicts(bookPath);
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

  private async detectCanvasConflicts(bookPath: string): Promise<void> {
    const base = path.basename(bookPath.slice(0, -".canvas".length));
    const dir = path.dirname(path.join(this.opts.syncDir, bookPath));
    try {
      const entries = await fs.readdir(dir);
      const regexp = new RegExp(`^${escapeRegExp(base)} \\d+\\.canvas$`);
      const conflicts = entries.filter((entry) => regexp.test(entry));
      if (conflicts.length > 0) {
        this.opts.onConflict(`检测到 Canvas 冲突副本：${conflicts.join("、")}，请人工选择保留版本`);
      }
    } catch {
      // 目录不存在时忽略
    }
  }
}

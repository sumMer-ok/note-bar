/**
 * 百度网盘同步服务：把 `BaiduPanProvider` 接到 Obsidian 生命周期上
 * （定时轮询 + 手动触发 + 停止），与 `SyncManager` 的分工一致。
 *
 * 本文件不 import obsidian（只 `import type`），全部副作用由 `start` / `stop` 管理，
 * 因此可以在 node:test 里用假 provider 驱动。
 */

import type { BaiduPanProvider, BaiduPanSyncResult } from "./baidu-pan-provider";

export interface BaiduPanServiceOptions {
  /** 每次同步前取最新 provider（设置变化后无需重建服务） */
  provider: () => BaiduPanProvider | null;
  /** 轮询间隔（秒），默认 300：未过审应用每小时仅 10 次配额，不能像 iCloud 那样激进 */
  pollIntervalSec?: number;
  onResult?: (result: BaiduPanSyncResult) => void;
  onError?: (message: string) => void;
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

/** 默认轮询间隔：5 分钟（配额友好） */
export const DEFAULT_BAIDU_PAN_POLL_SEC = 300;

export class BaiduPanSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight: Promise<BaiduPanSyncResult | null> | null = null;

  constructor(private readonly options: BaiduPanServiceOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** 启动轮询；可重复调用（先停旧的） */
  start(): void {
    this.stop();
    const intervalMs = Math.max(30, this.options.pollIntervalSec ?? DEFAULT_BAIDU_PAN_POLL_SEC) * 1000;
    const setIntervalFn =
      this.options.setIntervalFn ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
    this.running = true;
    this.timer = setIntervalFn(() => {
      void this.syncNow().catch((error) => {
        this.reportError(error);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      const clearIntervalFn =
        this.options.clearIntervalFn ?? ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));
      clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /**
   * 立即同步一次。并发调用会复用同一个在途 Promise：
   * 设置面板连点、轮询与手动触发撞车时不会重复消耗网盘配额。
   */
  async syncNow(): Promise<BaiduPanSyncResult | null> {
    if (this.inFlight) return await this.inFlight;
    const provider = this.options.provider();
    if (!provider) return null;
    this.inFlight = (async () => {
      try {
        const result = await provider.syncOnce();
        if (this.options.onResult) this.options.onResult(result);
        return result;
      } catch (error) {
        this.reportError(error);
        return null;
      } finally {
        this.inFlight = null;
      }
    })();
    return await this.inFlight;
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.options.onError) this.options.onError(message);
    else console.warn(`Note Bar 百度网盘同步: ${message}`);
  }
}

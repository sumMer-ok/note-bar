import { Notice } from "obsidian";
import { watch, type FSWatcher } from "fs";
import type NoteBarPlugin from "../main";
import { getLocalDictionaryService } from "../hiwords/services/local-dictionary-service";
import { Mirrorer } from "./mirrorer";
import { createInboxVocabularyPort } from "./inbox-vocabulary-adapter";
import { importInbox, type InboxImportResult } from "./inbox-importer";
import { isInboxEnabled, resolveInboxDir } from "./inbox-config";
import { exportProgressToSidecars } from "./sync-exporter";
import { importSidecars } from "./sync-importer";
import type { SyncExportResult, SyncImportResult } from "./types";

/** 手机同步编排：镜像 + 导出 + 导入 + 冲突日志 */
export class SyncManager {
  private mirrorer: Mirrorer | null = null;
  private exportTimer: ReturnType<typeof setTimeout> | null = null;
  private importTimer: ReturnType<typeof setTimeout> | null = null;
  private importPollTimer: ReturnType<typeof setInterval> | null = null;
  private sidecarWatcher: FSWatcher | null = null;
  private inboxWatcher: FSWatcher | null = null;
  private inboxPollTimer: ReturnType<typeof setInterval> | null = null;
  private inboxTimer: ReturnType<typeof setTimeout> | null = null;
  private exportResolve: (() => void) | null = null;
  private running = false;
  /** 收件箱监听是否在跑：独立于手机同步，双方各自开关 */
  private inboxRunning = false;
  readonly conflicts: string[] = [];

  constructor(private readonly plugin: NoteBarPlugin) {}

  get isRunning(): boolean {
    return this.running;
  }

  private get config() {
    return this.plugin.hiwordsSettings.mobileSync;
  }

  async start(): Promise<void> {
    const cfg = this.config;
    if (!cfg?.enabled || !cfg.syncDir) return;
    const vaultBase = (this.plugin.app.vault.adapter as any).getBasePath?.() as string | undefined;
    if (!vaultBase) return;
    this.stop();
    this.mirrorer = new Mirrorer({
      vaultBasePath: vaultBase,
      syncDir: cfg.syncDir,
      books: this.plugin.hiwordsSettings.vocabularyBooks,
      onConflict: (message) => {
        this.conflicts.push(message);
        new Notice(message);
      },
      onVaultChanged: (bookPath) => {
        void this.plugin.vocabularyManager?.reloadVocabularyBook(bookPath);
        this.plugin.refreshHighlighter();
      },
    });
    this.mirrorer.start(cfg.pollIntervalSec || 15);
    this.running = true;
    await this.mirrorer.syncOnce();
    this.startSidecarWatch(cfg.syncDir, cfg.pollIntervalSec || 15);
    // 先导入手机进度，再把合并结果导出回边车
    await this.importAll();
    await this.exportAll(true);
    // 收件箱是否消费由 crossAppInbox.enabled 单独决定
    this.startInbox();
  }

  /**
   * 启动收件箱监听（fs.watch + 轮询兜底）。
   * 与手机同步互相独立：手机同步关闭时仍可单独消费收件箱，反之收件箱开关关闭时不监听。
   */
  startInbox(): void {
    if (!isInboxEnabled(this.plugin.hiwordsSettings)) {
      this.stopInbox();
      return;
    }
    const inboxDir = resolveInboxDir(this.plugin.hiwordsSettings);
    if (!inboxDir) {
      this.stopInbox();
      return;
    }
    this.stopInbox();
    this.inboxRunning = true;
    this.startInboxWatch(inboxDir, this.config?.pollIntervalSec || 15);
  }

  /** 停止收件箱监听与轮询；可重复调用 */
  stopInbox(): void {
    this.inboxWatcher?.close();
    this.inboxWatcher = null;
    if (this.inboxPollTimer) {
      clearInterval(this.inboxPollTimer);
      this.inboxPollTimer = null;
    }
    if (this.inboxTimer) {
      clearTimeout(this.inboxTimer);
      this.inboxTimer = null;
    }
    this.inboxRunning = false;
  }

  stop(): void {
    this.mirrorer?.stop();
    this.mirrorer = null;
    if (this.exportTimer) {
      clearTimeout(this.exportTimer);
      this.exportTimer = null;
    }
    if (this.importTimer) {
      clearTimeout(this.importTimer);
      this.importTimer = null;
    }
    if (this.importPollTimer) {
      clearInterval(this.importPollTimer);
      this.importPollTimer = null;
    }
    this.sidecarWatcher?.close();
    this.sidecarWatcher = null;
    this.stopInbox();
    // 挂起中的防抖导出直接结束，避免 Promise 永不 settle
    this.exportResolve?.();
    this.exportResolve = null;
    this.running = false;
  }

  scheduleMirror(bookPath: string): void {
    this.mirrorer?.scheduleSync(bookPath);
  }

  async exportAll(immediate = false): Promise<SyncExportResult | null> {
    const cfg = this.config;
    if (!cfg?.syncDir || !this.plugin.vocabularyManager) return null;
    if (!immediate) {
      if (this.exportTimer) clearTimeout(this.exportTimer);
      return await new Promise((resolve) => {
        this.exportResolve = () => resolve(null);
        this.exportTimer = setTimeout(async () => {
          this.exportTimer = null;
          this.exportResolve = null;
          const result = await exportProgressToSidecars({
            settings: this.plugin.hiwordsSettings,
            vocabularyManager: this.plugin.vocabularyManager!,
            syncDir: cfg.syncDir,
          });
          resolve(result);
        }, 500);
      });
    }
    return exportProgressToSidecars({
      settings: this.plugin.hiwordsSettings,
      vocabularyManager: this.plugin.vocabularyManager,
      syncDir: cfg.syncDir,
    });
  }

  async importAll(): Promise<SyncImportResult | null> {
    const cfg = this.config;
    if (!cfg?.syncDir) return null;
    const result = await importSidecars({ settings: this.plugin.hiwordsSettings, syncDir: cfg.syncDir });
    await this.plugin.saveHiWordsSettings();
    // 进度合并后立即重建内存缓存，否则 Obsidian 界面要等重载插件才会显示手机端的新状态
    this.plugin.vocabularyManager?.refreshStudyCache();
    this.plugin.refreshHighlighter();
    return result;
  }

  /** 立即执行一次完整双向同步：镜像 Canvas + 导入手机进度 + 导出合并后的边车 */
  async syncNow(): Promise<{ imported: number; exported: number; failed: string[] } | null> {
    const cfg = this.config;
    if (!cfg?.syncDir) return null;
    await this.mirrorer?.syncOnce();
    const imported = await this.importAll();
    const exported = await this.exportAll(true);
    return {
      imported: imported?.mergedKeys ?? 0,
      exported: exported?.written ?? 0,
      failed: exported?.failed ?? [],
    };
  }

  /** 监听同步目录里边车文件变化（fs.watch + 轮询兜底），防抖后自动导入 */
  private startSidecarWatch(syncDir: string, pollIntervalSec: number): void {
    try {
      this.sidecarWatcher = watch(syncDir, { recursive: true }, (_event, fileName) => {
        if (fileName && fileName.toString().endsWith(".nb-sync.json")) {
          this.scheduleImport();
        }
      });
      this.sidecarWatcher.on("error", () => {
        // fs.watch 对 iCloud 未物化文件不可靠，轮询兜底已覆盖
      });
    } catch {
      // 轮询兜底已覆盖
    }
    this.importPollTimer = setInterval(() => {
      this.scheduleImport();
    }, Math.max(1, pollIntervalSec) * 1000);
  }

  private scheduleImport(): void {
    if (!this.running) return;
    if (this.importTimer) clearTimeout(this.importTimer);
    this.importTimer = setTimeout(() => {
      this.importTimer = null;
      void this.importAll().catch((error) => {
        console.warn("Note Bar 自动导入失败:", error);
      });
    }, 1500);
  }

  /** 消费一次收件箱；开关关闭或未配置目录时返回 null */
  async importInboxNow(): Promise<InboxImportResult | null> {
    if (!isInboxEnabled(this.plugin.hiwordsSettings)) return null;
    const inboxDir = resolveInboxDir(this.plugin.hiwordsSettings);
    if (!inboxDir || !this.plugin.vocabularyManager) return null;

    const books = this.plugin.hiwordsSettings.vocabularyBooks
      .filter((book) => book.enabled && book.path.endsWith(".canvas"))
      .map((book) => book.path);

    const port = createInboxVocabularyPort({
      manager: this.plugin.vocabularyManager,
      dictionary: getLocalDictionaryService(this.plugin.app),
    });

    const result = await importInbox({
      syncDir: inboxDir,
      books,
      defaultBooks: this.plugin.hiwordsSettings.defaultVocabularyBookPaths ?? [],
      duplicatePolicy: this.plugin.hiwordsSettings.crossAppInbox?.duplicatePolicy ?? "skip",
      port,
    });

    if (result.added > 0 || result.updated > 0) {
      this.plugin.refreshHighlighter();
      new Notice(`跨应用加词：新增 ${result.added} 条，更新 ${result.updated} 条`);
    }
    if (result.failed > 0) {
      new Notice(`跨应用加词：${result.failed} 条目标词库写入失败（失败条目见 inbox.failed）`);
    }
    return result;
  }

  /** 监听收件箱变化（fs.watch + 轮询兜底），与边车监听同一模式 */
  private startInboxWatch(syncDir: string, pollIntervalSec: number): void {
    try {
      this.inboxWatcher = watch(syncDir, { recursive: true }, (_event, fileName) => {
        if (fileName && fileName.toString().includes("note-bar-inbox.jsonl")) {
          this.scheduleInboxImport();
        }
      });
      this.inboxWatcher.on("error", () => {
        // iCloud 未物化文件下 fs.watch 不可靠，轮询兜底已覆盖
      });
    } catch {
      // 轮询兜底已覆盖
    }

    this.inboxPollTimer = setInterval(() => {
      this.scheduleInboxImport();
    }, Math.max(1, pollIntervalSec) * 1000);
  }

  private scheduleInboxImport(): void {
    if (!this.inboxRunning) return;
    if (this.inboxTimer) clearTimeout(this.inboxTimer);
    this.inboxTimer = setTimeout(() => {
      this.inboxTimer = null;
      void this.importInboxNow().catch((error) => {
        console.warn("Note Bar 跨应用加词导入失败:", error);
      });
    }, 1500);
  }
}

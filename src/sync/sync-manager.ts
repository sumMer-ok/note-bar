import { Notice } from "obsidian";
import { watch, type FSWatcher } from "fs";
import type NoteBarPlugin from "../main";
import { Mirrorer } from "./mirrorer";
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
  private exportResolve: (() => void) | null = null;
  private running = false;
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
}

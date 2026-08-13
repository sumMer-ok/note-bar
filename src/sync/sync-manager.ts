import { Notice } from "obsidian";
import type NoteBarPlugin from "../main";
import { Mirrorer } from "./mirrorer";
import { exportProgressToSidecars } from "./sync-exporter";
import { importSidecars } from "./sync-importer";
import type { SyncExportResult, SyncImportResult } from "./types";

/** 手机同步编排：镜像 + 导出 + 导入 + 冲突日志 */
export class SyncManager {
  private mirrorer: Mirrorer | null = null;
  private exportTimer: ReturnType<typeof setTimeout> | null = null;
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
    await this.exportAll(true);
  }

  stop(): void {
    this.mirrorer?.stop();
    this.mirrorer = null;
    if (this.exportTimer) {
      clearTimeout(this.exportTimer);
      this.exportTimer = null;
    }
    this.running = false;
  }

  scheduleMirror(bookPath: string): void {
    this.mirrorer?.scheduleSync(bookPath);
  }

  async exportAll(immediate = false): Promise<SyncExportResult | null> {
    const cfg = this.config;
    if (!this.running || !cfg?.syncDir || !this.plugin.vocabularyManager) return null;
    if (!immediate) {
      if (this.exportTimer) clearTimeout(this.exportTimer);
      return await new Promise((resolve) => {
        this.exportTimer = setTimeout(async () => {
          this.exportTimer = null;
          resolve(
            await exportProgressToSidecars({
              settings: this.plugin.hiwordsSettings,
              vocabularyManager: this.plugin.vocabularyManager!,
              syncDir: cfg.syncDir,
            })
          );
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
    if (!this.running || !cfg?.syncDir) return null;
    const result = await importSidecars({ settings: this.plugin.hiwordsSettings, syncDir: cfg.syncDir });
    await this.plugin.saveHiWordsSettings();
    this.plugin.refreshHighlighter();
    return result;
  }
}

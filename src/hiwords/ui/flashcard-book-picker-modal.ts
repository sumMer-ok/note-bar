import { App, Component, Modal, Notice } from 'obsidian';
import type NoteBarPlugin from '../../main';
import { getBookReviewStats } from '../core/flashcard-queue';
import { FlashcardReviewModal } from './flashcard-review-modal';

export class FlashcardBookPickerModal extends Modal {
    private plugin: NoteBarPlugin;
    private selectedPaths: string[] = [];
    private domEventComponent: Component;

    constructor(app: App, plugin: NoteBarPlugin) {
        super(app);
        this.plugin = plugin;
        this.domEventComponent = new Component();
        this.domEventComponent.load();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flashcard-book-picker-content');
        contentEl.createEl('h2', { text: '选择本次复习的单词本' });

        const enabledCanvasBooks = this.plugin.hiwordsSettings.vocabularyBooks
            .filter(b => b.enabled && b.path.endsWith('.canvas'));

        if (enabledCanvasBooks.length === 0) {
            contentEl.createEl('p', {
                text: '没有可用的 Canvas 单词本，请先在设置中启用。',
                cls: 'setting-item-description'
            });
            const closeBtn = contentEl.createEl('button', { text: '关闭' });
            this.registerDomEvent(closeBtn, 'click', () => this.close());
            return;
        }

        const vocabularyManager = this.plugin.vocabularyManager;
        const studyItems = vocabularyManager?.getStudyItems() || [];
        const progress = this.plugin.hiwordsSettings.studyProgress || {};

        const listContainer = contentEl.createDiv({ cls: 'flashcard-book-list' });

        for (const book of enabledCanvasBooks) {
            const stats = getBookReviewStats(book.path, studyItems, progress);
            const row = listContainer.createDiv({ cls: 'flashcard-book-row' });

            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.style.width = '16px';
            checkbox.style.height = '16px';
            checkbox.style.flexShrink = '0';
            checkbox.style.marginRight = '10px';
            checkbox.style.cursor = 'pointer';
            this.registerDomEvent(checkbox, 'change', () => {
                if (checkbox.checked) {
                    if (!this.selectedPaths.includes(book.path)) {
                        this.selectedPaths.push(book.path);
                    }
                } else {
                    this.selectedPaths = this.selectedPaths.filter(p => p !== book.path);
                }
            });

            const info = row.createDiv({ cls: 'flashcard-book-info' });
            info.createDiv({ cls: 'flashcard-book-name', text: book.name });
            info.createDiv({
                cls: 'flashcard-book-meta',
                text: `共 ${stats.total} 词 · 今日到期 ${stats.dueToday} · 新词 ${stats.newCount}`
            });
        }

        const buttonContainer = contentEl.createDiv({ cls: 'flashcard-button-container' });

        const startBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: '开始复习'
        });
        this.registerDomEvent(startBtn, 'click', () => {
            if (this.selectedPaths.length === 0) {
                new Notice('请至少选择一个单词本');
                return;
            }
            this.close();
            new FlashcardReviewModal(this.app, this.plugin, this.selectedPaths).open();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
        this.registerDomEvent(cancelBtn, 'click', () => this.close());
    }

    registerDomEvent<K extends keyof WindowEventMap>(el: Window, type: K, callback: (this: HTMLElement, ev: WindowEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    registerDomEvent<K extends keyof DocumentEventMap>(el: Document, type: K, callback: (this: HTMLElement, ev: DocumentEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    registerDomEvent<K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, callback: (this: HTMLElement, ev: HTMLElementEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    registerDomEvent(el: any, type: any, callback: any, options?: any): void {
        this.domEventComponent.registerDomEvent(el, type, callback, options);
    }

    onClose() {
        this.domEventComponent.unload();
        this.contentEl.empty();
    }
}

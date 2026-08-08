import { App, Component, Modal, Notice } from 'obsidian';
import type NoteBarPlugin from '../../main';
import { getBookReviewStats, type FlashcardSessionMode } from '../core/flashcard-queue';
import { FlashcardReviewModal } from './flashcard-review-modal';
import { SpellingPracticeModal } from './spelling-practice-modal';
import type { StudyItem } from '../utils';

export class FlashcardBookPickerModal extends Modal {
    private plugin: NoteBarPlugin;
    private selectedPaths: string[] = [];
    private domEventComponent: Component;
    private dateFilterRow!: HTMLElement;
    private dateFilterSelect!: HTMLSelectElement;
    private studyItems: StudyItem[] = [];

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
        contentEl.createEl('h2', { text: '选择单词本' });

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
        this.studyItems = studyItems;
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
                this.updateDateFilterOptions();
            });

            const info = row.createDiv({ cls: 'flashcard-book-info' });
            info.createDiv({ cls: 'flashcard-book-name', text: book.name });
            info.createDiv({
                cls: 'flashcard-book-meta',
                text: `共 ${stats.total} 词 · 今日到期 ${stats.dueToday} · 新词 ${stats.newCount}`
            });
        }

        // 听写日期筛选（选择单词本后显示）
        this.dateFilterRow = contentEl.createDiv({ cls: 'spelling-date-filter-row' });
        this.dateFilterRow.createSpan({ cls: 'spelling-date-filter-label', text: '听写日期：' });
        this.dateFilterSelect = this.dateFilterRow.createEl('select', { cls: 'dropdown spelling-date-filter-select' });
        this.dateFilterRow.style.display = 'none';
        this.updateDateFilterOptions();

        const buttonContainer = contentEl.createDiv({ cls: 'flashcard-button-container' });

        const startSession = (mode: FlashcardSessionMode) => {
            if (this.selectedPaths.length === 0) {
                new Notice('请至少选择一个单词本');
                return;
            }
            this.close();
            new FlashcardReviewModal(this.app, this.plugin, this.selectedPaths, mode).open();
        };

        // 听写练习：使用已选单词本的单词
        const startDictation = () => {
            if (this.selectedPaths.length === 0) {
                new Notice('请至少选择一个单词本');
                return;
            }
            const selectedDate = this.dateFilterSelect.value; // '' = 全部日期
            const words = studyItems
                .filter(item => item.sources.some(s => this.selectedPaths.includes(s.source)))
                .filter(item => !selectedDate || item.primary.addedDate === selectedDate)
                .map(item => item.primary);
            // 同一单词可能出现在多个单词本，按单词去重
            const seen = new Set<string>();
            const unique = words.filter(w => {
                const key = w.word.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            if (unique.length === 0) {
                new Notice('所选单词本暂无单词');
                return;
            }
            const bookName = this.selectedPaths.length === 1
                ? (enabledCanvasBooks.find(b => b.path === this.selectedPaths[0])?.name || '已选单词本')
                : `已选 ${this.selectedPaths.length} 个单词本`;
            const maxPerSession = this.plugin.hiwordsSettings.spellingPractice?.maxPerSession || 0;
            this.close();
            new SpellingPracticeModal(this.app, this.plugin, bookName, unique, maxPerSession).open();
        };

        const learnBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: '开始学习'
        });
        this.registerDomEvent(learnBtn, 'click', () => startSession('new'));

        const reviewBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: '开始复习'
        });
        this.registerDomEvent(reviewBtn, 'click', () => startSession('review'));

        const dictationBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: '开始听写'
        });
        this.registerDomEvent(dictationBtn, 'click', () => startDictation());

        const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
        this.registerDomEvent(cancelBtn, 'click', () => this.close());
    }

    /** 根据已选单词本刷新听写日期筛选选项 */
    private updateDateFilterOptions() {
        if (!this.dateFilterRow || !this.dateFilterSelect) return;

        // 收集已选单词本中单词的添加日期（去重、降序）
        const dates = new Set<string>();
        for (const item of this.studyItems) {
            if (item.sources.some(s => this.selectedPaths.includes(s.source)) && item.primary.addedDate) {
                dates.add(item.primary.addedDate);
            }
        }
        const sortedDates = Array.from(dates).sort().reverse();

        // 重建选项
        const prev = this.dateFilterSelect.value;
        this.dateFilterSelect.empty();
        const allOption = this.dateFilterSelect.createEl('option', { text: '全部日期', value: '' });
        if (!prev) allOption.selected = true;
        for (const d of sortedDates) {
            const opt = this.dateFilterSelect.createEl('option', { text: d, value: d });
            if (prev === d) opt.selected = true;
        }

        // 有选中单词本且有日期时才显示
        this.dateFilterRow.style.display = (this.selectedPaths.length > 0 && sortedDates.length > 0) ? '' : 'none';
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

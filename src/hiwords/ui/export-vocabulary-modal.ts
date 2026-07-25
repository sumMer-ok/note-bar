import { App, Modal, Notice, TFile } from 'obsidian';
import type { VocabularyBook, HiWordsSettings } from '../utils';
import { CanvasParser } from '../canvas/canvas-parser';
import { CanvasExporter, WordWithDate } from '../canvas/canvas-exporter';
import { writeCsv } from '../utils';

const ALL_DATES = '__all__';

export class ExportVocabularyModal extends Modal {
    private settings: HiWordsSettings;
    private words: WordWithDate[] = [];
    private selectedBook: VocabularyBook | null = null;
    private dateSelect: HTMLSelectElement | null = null;

    constructor(app: App, settings: HiWordsSettings) {
        super(app);
        this.settings = settings;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '导出单词本为 Excel' });

        const enabledBooks = this.settings.vocabularyBooks
            .filter(book => book.enabled && book.path.endsWith('.canvas'));

        if (enabledBooks.length === 0) {
            contentEl.createEl('p', {
                text: '没有可用的 Canvas 单词本，请先在设置中启用。',
                cls: 'setting-item-description'
            });
            const closeButton = contentEl.createEl('button', { text: '关闭' });
            closeButton.onclick = () => this.close();
            return;
        }

        // 单词本选择
        const bookContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        bookContainer.createEl('label', { text: '选择单词本', cls: 'hiwords-form-item-label' });
        const bookSelect = bookContainer.createEl('select', { cls: 'dropdown' });
        bookSelect.style.width = '100%';

        for (const book of enabledBooks) {
            const option = bookSelect.createEl('option');
            option.value = book.path;
            option.textContent = book.name;
        }

        // 日期选择
        const dateContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        dateContainer.createEl('label', { text: '添加日期', cls: 'hiwords-form-item-label' });
        this.dateSelect = dateContainer.createEl('select', { cls: 'dropdown' });
        this.dateSelect.style.width = '100%';
        this.updateDateOptions([{ value: ALL_DATES, label: '全部' }]);

        // 按钮
        const buttonContainer = contentEl.createDiv({ cls: 'hiwords-button-container' });
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '8px';
        buttonContainer.style.marginTop = '16px';

        const exportButton = buttonContainer.createEl('button', {
            text: '导出',
            cls: 'mod-cta'
        });
        const cancelButton = buttonContainer.createEl('button', { text: '取消' });
        cancelButton.onclick = () => this.close();

        // 事件
        bookSelect.addEventListener('change', () => {
            const path = bookSelect.value;
            const book = enabledBooks.find(b => b.path === path) || null;
            void this.onBookSelected(book);
        });

        exportButton.addEventListener('click', () => {
            void this.exportWords();
        });

        // 默认选中第一个
        this.selectedBook = enabledBooks[0];
        void this.onBookSelected(this.selectedBook);
    }

    private updateDateOptions(options: { value: string; label: string }[]) {
        if (!this.dateSelect) return;
        this.dateSelect.empty();
        for (const opt of options) {
            const option = this.dateSelect.createEl('option');
            option.value = opt.value;
            option.textContent = opt.label;
        }
    }

    private async onBookSelected(book: VocabularyBook | null) {
        this.selectedBook = book;
        if (!book) {
            this.updateDateOptions([{ value: ALL_DATES, label: '全部' }]);
            this.words = [];
            return;
        }

        const file = this.app.vault.getAbstractFileByPath(book.path);
        if (!(file instanceof TFile)) {
            this.updateDateOptions([{ value: ALL_DATES, label: '全部' }]);
            this.words = [];
            return;
        }

        try {
            const parser = new CanvasParser(this.app, this.settings);
            const exporter = new CanvasExporter(this.app, parser);
            this.words = await exporter.getWordsWithDates(file);
            const uniqueDates = exporter.getUniqueDates(this.words);
            const options = [{ value: ALL_DATES, label: `全部 (${this.words.length})` }];
            for (const date of uniqueDates) {
                const count = this.words.filter(w => w.date === date).length;
                const label = date === '无日期' ? `无日期 (${count})` : `${date} (${count})`;
                options.push({ value: date, label });
            }
            this.updateDateOptions(options);
        } catch (error) {
            console.error('加载单词本失败:', error);
            new Notice('加载单词本失败');
            this.words = [];
            this.updateDateOptions([{ value: ALL_DATES, label: '全部' }]);
        }
    }

    private async exportWords() {
        if (!this.selectedBook) {
            new Notice('请先选择单词本');
            return;
        }
        if (this.words.length === 0) {
            new Notice('该单词本没有可导出的单词');
            return;
        }

        const selectedDate = this.dateSelect?.value || ALL_DATES;
        const filtered = selectedDate === ALL_DATES
            ? this.words
            : this.words.filter(w => w.date === selectedDate);

        if (filtered.length === 0) {
            new Notice('所选日期没有单词');
            return;
        }

        const rows: string[][] = [
            ['原单词', '单词变体', '单词释义']
        ];
        for (const word of filtered) {
            const aliases = word.aliases ? word.aliases.join(', ') : '';
            rows.push([word.word, aliases, word.definition]);
        }

        const csvContent = writeCsv(rows);
        const dateSuffix = selectedDate === ALL_DATES ? 'all' : selectedDate;
        const safeBookName = this.selectedBook.name.replace(/[\\/:*?"<>|]/g, '_');
        const fileName = `${safeBookName}-export-${dateSuffix}.csv`;

        try {
            const targetPath = `${this.selectedBook.path.substring(0, this.selectedBook.path.lastIndexOf('/'))}/${fileName}`;
            const normalizedPath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
            const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
            if (existing) {
                await this.app.vault.adapter.write(normalizedPath, csvContent);
            } else {
                await this.app.vault.create(normalizedPath, csvContent);
            }
            new Notice(`已导出 ${filtered.length} 个单词到 ${fileName}`);
            this.close();
        } catch (error) {
            console.error('导出失败:', error);
            new Notice('导出失败，请检查文件路径');
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

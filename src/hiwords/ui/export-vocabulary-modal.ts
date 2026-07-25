import { App, Modal, Notice, TFile } from 'obsidian';
import type { VocabularyBook, HiWordsSettings } from '../utils';
import { CanvasParser } from '../canvas/canvas-parser';
import { CanvasExporter, WordWithDate } from '../canvas/canvas-exporter';
import { writeCsv } from '../utils';

interface DateOption {
    value: string;
    label: string;
    count: number;
}

export class ExportVocabularyModal extends Modal {
    private settings: HiWordsSettings;
    private words: WordWithDate[] = [];
    private selectedBook: VocabularyBook | null = null;
    private dateOptions: DateOption[] = [];
    private dateCheckboxes: { value: string; checkbox: HTMLInputElement }[] = [];
    private savePathDisplay: HTMLElement | null = null;
    private selectedSavePath: string = '';
    private dateListContainer: HTMLElement | null = null;

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

        // 日期选择（多选）
        const dateContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        dateContainer.createEl('label', { text: '添加日期（可多选）', cls: 'hiwords-form-item-label' });
        this.dateListContainer = dateContainer.createDiv({ cls: 'hiwords-date-checkbox-list' });
        this.dateListContainer.style.display = 'flex';
        this.dateListContainer.style.flexDirection = 'column';
        this.dateListContainer.style.gap = '6px';
        this.dateListContainer.style.marginTop = '8px';

        // 保存位置
        const saveContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        saveContainer.createEl('label', { text: '保存位置', cls: 'hiwords-form-item-label' });
        const savePathRow = saveContainer.createDiv();
        savePathRow.style.display = 'flex';
        savePathRow.style.gap = '8px';
        savePathRow.style.alignItems = 'center';

        this.savePathDisplay = savePathRow.createEl('div', {
            cls: 'setting-item-input',
            text: ''
        });
        this.savePathDisplay.style.flex = '1';
        this.savePathDisplay.style.padding = '6px 10px';
        this.savePathDisplay.style.minHeight = '28px';
        this.savePathDisplay.style.overflow = 'hidden';
        this.savePathDisplay.style.textOverflow = 'ellipsis';
        this.savePathDisplay.style.whiteSpace = 'nowrap';

        const browseButton = savePathRow.createEl('button', { text: '选择文件夹' });
        browseButton.addEventListener('click', () => {
            void this.pickSaveFolder();
        });

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

    private renderDateOptions() {
        if (!this.dateListContainer) return;
        this.dateListContainer.empty();
        this.dateCheckboxes = [];

        if (this.dateOptions.length === 0) {
            this.dateListContainer.createEl('p', {
                text: '没有可用的日期',
                cls: 'setting-item-description'
            });
            return;
        }

        // 全选 / 全不选
        const allRow = this.dateListContainer.createDiv({ cls: 'hiwords-date-checkbox-row' });
        allRow.style.display = 'flex';
        allRow.style.alignItems = 'center';
        allRow.style.gap = '6px';
        const allCheckbox = allRow.createEl('input', { type: 'checkbox' });
        allCheckbox.id = 'hiwords-date-check-all';
        allCheckbox.checked = true;
        allCheckbox.style.width = '16px';
        allCheckbox.style.height = '16px';
        allCheckbox.style.minWidth = '16px';
        allCheckbox.style.flexShrink = '0';
        const allLabel = allRow.createEl('label', { text: '全部', attr: { for: allCheckbox.id } });
        allLabel.style.cursor = 'pointer';
        allLabel.style.flex = '1';

        allCheckbox.addEventListener('change', () => {
            for (const item of this.dateCheckboxes) {
                item.checkbox.checked = allCheckbox.checked;
            }
        });

        for (const opt of this.dateOptions) {
            const row = this.dateListContainer.createDiv({ cls: 'hiwords-date-checkbox-row' });
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '6px';
            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.id = `hiwords-date-check-${opt.value}`;
            checkbox.value = opt.value;
            checkbox.checked = true;
            checkbox.style.width = '16px';
            checkbox.style.height = '16px';
            checkbox.style.minWidth = '16px';
            checkbox.style.flexShrink = '0';

            const label = row.createEl('label', { text: opt.label, attr: { for: checkbox.id } });
            label.style.cursor = 'pointer';
            label.style.flex = '1';

            this.dateCheckboxes.push({ value: opt.value, checkbox });

            checkbox.addEventListener('change', () => {
                const allChecked = this.dateCheckboxes.every(item => item.checkbox.checked);
                allCheckbox.checked = allChecked;
            });
        }
    }

    private updateSavePathDefault() {
        if (!this.selectedBook) return;
        const lastSlash = this.selectedBook.path.lastIndexOf('/');
        const dir = lastSlash > 0 ? this.selectedBook.path.substring(0, lastSlash) : '';
        this.selectedSavePath = dir;
        if (this.savePathDisplay) {
            this.savePathDisplay.textContent = dir || '单词本所在目录';
            this.savePathDisplay.title = dir || '单词本所在目录';
        }
    }

    private async onBookSelected(book: VocabularyBook | null) {
        this.selectedBook = book;
        this.dateOptions = [];
        this.updateSavePathDefault();

        if (!book) {
            this.renderDateOptions();
            this.words = [];
            return;
        }

        const file = this.app.vault.getAbstractFileByPath(book.path);
        if (!(file instanceof TFile)) {
            this.renderDateOptions();
            this.words = [];
            return;
        }

        try {
            const parser = new CanvasParser(this.app, this.settings);
            const exporter = new CanvasExporter(this.app, parser);
            this.words = await exporter.getWordsWithDates(file);
            const uniqueDates = exporter.getUniqueDates(this.words);
            this.dateOptions = uniqueDates.map((date) => {
                const count = this.words.filter(w => w.date === date).length;
                const label = date === '无日期' ? `无日期 (${count})` : `${date} (${count})`;
                return { value: date, label, count };
            });
            this.renderDateOptions();
        } catch (error) {
            console.error('加载单词本失败:', error);
            new Notice('加载单词本失败');
            this.words = [];
            this.dateOptions = [];
            this.renderDateOptions();
        }
    }

    private getSelectedDates(): string[] {
        return this.dateCheckboxes
            .filter(item => item.checkbox.checked)
            .map(item => item.value);
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

        const selectedDates = this.getSelectedDates();
        if (selectedDates.length === 0) {
            new Notice('请至少选择一个日期');
            return;
        }

        const filtered = this.words.filter(w => selectedDates.includes(w.date));
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
        const safeBookName = this.selectedBook.name.replace(/[\\/:*?"<>|]/g, '_');
        const dateSuffix = selectedDates.length === 1 ? selectedDates[0] : 'multi';
        const fileName = `${safeBookName}-export-${dateSuffix}.csv`;

        let saveDir = this.selectedSavePath.trim();
        if (!saveDir) {
            const lastSlash = this.selectedBook.path.lastIndexOf('/');
            saveDir = lastSlash > 0 ? this.selectedBook.path.substring(0, lastSlash) : '';
        }
        saveDir = saveDir.replace(/\/$/, '');

        const targetFileName = saveDir ? `${saveDir}/${fileName}` : fileName;

        try {
            await this.writeCsvFile(targetFileName, csvContent);
            new Notice(`已导出 ${filtered.length} 个单词到 ${targetFileName}`);
            this.close();
        } catch (error) {
            console.error('导出失败:', error);
            new Notice('导出失败，请检查文件路径');
        }
    }

    private async pickSaveFolder(): Promise<void> {
        const folderPath = await this.showFolderPicker();
        if (folderPath) {
            this.selectedSavePath = folderPath;
            if (this.savePathDisplay) {
                this.savePathDisplay.textContent = folderPath;
                this.savePathDisplay.title = folderPath;
            }
        }
    }

    private async showFolderPicker(): Promise<string | null> {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            (input as any).webkitdirectory = true;
            (input as any).directory = true;
            input.style.display = 'none';
            document.body.appendChild(input);

            const cleanup = () => {
                if (input.parentNode) {
                    document.body.removeChild(input);
                }
            };

            input.addEventListener('change', () => {
                const files = input.files;
                if (!files || files.length === 0) {
                    cleanup();
                    resolve(null);
                    return;
                }
                const firstFile = files[0];
                const fullPath = (firstFile as any).path as string | undefined;
                cleanup();
                if (!fullPath) {
                    resolve(null);
                    return;
                }
                const normalized = fullPath.replace(/\\/g, '/');
                const lastSlash = normalized.lastIndexOf('/');
                const folderPath = lastSlash > 0 ? normalized.substring(0, lastSlash) : normalized;
                resolve(folderPath);
            });

            input.addEventListener('cancel', () => {
                cleanup();
                resolve(null);
            });

            input.click();
        });
    }

    private async writeCsvFile(filePath: string, content: string): Promise<void> {
        const normalized = filePath.replace(/\\/g, '/');

        // 优先使用 Node fs 写入任意本地路径
        try {
            const win = window as any;
            if (win.require) {
                const fs = win.require('fs');
                const path = win.require('path');
                if (fs && path) {
                    const dir = path.dirname(normalized);
                    fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(normalized, content, 'utf8');
                    return;
                }
            }
        } catch (e) {
            console.warn('Node fs 写入失败，回退到 Vault API:', e);
        }

        // 回退：使用 Obsidian Vault API（路径需在仓库内）
        const normalizedPath = normalized.startsWith('/') ? normalized.slice(1) : normalized;
        const dirPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
        await this.ensureVaultDirectory(dirPath);

        const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (existing) {
            await this.app.vault.adapter.write(normalizedPath, content);
        } else {
            await this.app.vault.create(normalizedPath, content);
        }
    }

    private async ensureVaultDirectory(dirPath: string): Promise<void> {
        if (!dirPath) return;
        const parts = dirPath.split('/').filter(p => p.length > 0);
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const folder = this.app.vault.getAbstractFileByPath(current);
            if (!folder) {
                await this.app.vault.createFolder(current);
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

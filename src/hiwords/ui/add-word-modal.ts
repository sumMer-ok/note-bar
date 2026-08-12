import { App, Modal, Notice, setIcon } from 'obsidian';
import type { WordDefinition, HiWordsSettings } from '../utils';
import { VocabularyManager } from '../core/vocabulary-manager';
import { DictionaryService } from '../services/dictionary-service';
import { LocalDictionaryService, getLocalDictionaryService } from '../services/local-dictionary-service';
import { getEncounterTracker } from '../core/encounter-tracker';

/**
 * 添加或编辑词汇的模态框
 */
export class AddWordModal extends Modal {
    private settings: HiWordsSettings;
    private vocabularyManager: VocabularyManager;
    private word: string;
    private sentence: string;
    private isEditMode: boolean;
    private definition: WordDefinition | null;
    private prefilledDefinition: string;
    private onWordAdded?: () => void;
    private localDictionary: LocalDictionaryService;

    private static lastSelectedColorValue: string | null = null;
    private static lastSelectedBookPaths: string[] | null = null;

    constructor(
        app: App,
        settings: HiWordsSettings,
        vocabularyManager: VocabularyManager,
        word: string,
        sentence = '',
        isEditMode = false,
        prefilledDefinition = '',
        definition?: WordDefinition,
        onWordAdded?: () => void
    ) {
        super(app);
        this.settings = settings;
        this.vocabularyManager = vocabularyManager;
        this.word = word;
        this.sentence = sentence;
        this.isEditMode = isEditMode;
        this.prefilledDefinition = prefilledDefinition;
        this.onWordAdded = onWordAdded;
        this.localDictionary = getLocalDictionaryService(app);

        if (isEditMode) {
            this.definition = definition || this.vocabularyManager.getDefinition(word) || null;
        } else {
            this.definition = null;
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        if (this.isEditMode && this.definition?.source.endsWith('.hiwords')) {
            contentEl.createEl('p', {
                text: '结构化 .hiwords 词库是只读词库，不能在这里添加或编辑单词。请改用 Canvas 单词本。',
                cls: 'setting-item-description'
            });
            const buttonContainer = contentEl.createDiv({ cls: 'hiwords-button-container' });
            const closeButton = buttonContainer.createEl('button', { text: '取消' });
            closeButton.onclick = () => this.close();
            return;
        }

        // 单词输入
        let wordInput: HTMLInputElement | null = null;
        if (!this.isEditMode) {
            const wordContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
            wordContainer.createEl('label', { text: '单词', cls: 'hiwords-form-item-label' });
            wordInput = wordContainer.createEl('input', {
                type: 'text',
                placeholder: '输入要添加的单词...',
                cls: 'setting-item-input'
            });
            wordInput.value = this.word;
            if (!this.word) {
                activeWindow.setTimeout(() => wordInput?.focus(), 50);
            }
        }

        // 生词本多选列表
        const bookSelectContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        bookSelectContainer.createEl('label', { text: '单词本（可多选）', cls: 'hiwords-form-item-label' });

        const enabledBooks = this.settings.vocabularyBooks
            .filter(book => book.enabled && book.path.endsWith('.canvas'));

        const bookCheckboxes: { path: string; checkbox: HTMLInputElement }[] = [];
        const defaultPaths = new Set(this.settings.defaultVocabularyBookPaths ?? []);
        const lastBookPaths = new Set(AddWordModal.lastSelectedBookPaths ?? []);

        enabledBooks.forEach((book, idx) => {
            const bookRow = bookSelectContainer.createDiv({ cls: 'hiwords-book-checkbox-row' });
            const checkboxId = `hiwords-book-check-${idx}`;
            const checkbox = bookRow.createEl('input', { type: 'checkbox' });
            checkbox.id = checkboxId;
            checkbox.style.width = '16px';
            checkbox.style.height = '16px';
            checkbox.style.minWidth = '16px';
            checkbox.style.flexShrink = '0';
            checkbox.style.marginRight = '8px';
            checkbox.style.cursor = 'pointer';

            const label = bookRow.createEl('label', {
                cls: 'hiwords-book-checkbox-label'
            });
            label.htmlFor = checkboxId;
            label.textContent = book.name;
            label.style.cursor = this.isEditMode && this.definition && this.definition.source === book.path ? 'default' : 'pointer';

            if (this.isEditMode && this.definition && this.definition.source === book.path) {
                checkbox.checked = true;
                checkbox.disabled = true;
            } else if (!this.isEditMode) {
                if (AddWordModal.lastSelectedBookPaths !== null) {
                    checkbox.checked = lastBookPaths.has(book.path);
                } else if (defaultPaths.has(book.path)) {
                    checkbox.checked = true;
                }
            }

            bookCheckboxes.push({ path: book.path, checkbox });
        });

        if (enabledBooks.length === 0) {
            bookSelectContainer.createEl('p', {
                text: '没有可用的 Canvas 单词本。请在设置中添加单词本。',
                cls: 'setting-item-description'
            });
        }

        // 颜色选择
        const colorSelectContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        colorSelectContainer.createEl('label', { text: '卡片颜色', cls: 'hiwords-form-item-label' });
        const colorSelect = colorSelectContainer.createEl('select', { cls: 'dropdown setting-item-select' });
        const grayOption = colorSelect.createEl('option', { text: '灰色', value: '' });
        if (!this.isEditMode && AddWordModal.lastSelectedColorValue === '') {
            grayOption.selected = true;
        }
        const colors = [
            { name: '红色', value: '1' },
            { name: '橙色', value: '2' },
            { name: '黄色', value: '3' },
            { name: '绿色', value: '4' },
            { name: '蓝色', value: '5' },
            { name: '紫色', value: '6' }
        ];
        colors.forEach(color => {
            const option = colorSelect.createEl('option', { text: color.name, value: color.value });
            if (this.isEditMode && this.definition && this.definition.color === color.value) {
                option.selected = true;
            } else if (!this.isEditMode && AddWordModal.lastSelectedColorValue === color.value) {
                option.selected = true;
            }
        });

        // 别名输入
        const aliasesContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        aliasesContainer.createEl('label', { text: '别名（可选，用逗号分隔）', cls: 'hiwords-form-item-label' });
        const aliasesInput = aliasesContainer.createEl('input', {
            type: 'text',
            placeholder: '例如：doing, done, did',
            cls: 'setting-item-input word-aliases-input'
        });
        if (this.isEditMode && this.definition && this.definition.aliases && this.definition.aliases.length > 0) {
            aliasesInput.value = this.definition.aliases.join(', ');
        }

        // 定义输入
        const definitionContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        const definitionLabelContainer = definitionContainer.createDiv({ cls: 'hiwords-definition-label-container' });
        definitionLabelContainer.createEl('label', { text: '释义', cls: 'hiwords-form-item-label' });

        const autoFillActionsContainer = definitionLabelContainer.createDiv({ cls: 'hiwords-auto-fill-actions' });

        const localDictBtn = autoFillActionsContainer.createDiv({ cls: 'hiwords-auto-fill-btn' });
        const localDictIcon = localDictBtn.createDiv({ cls: 'hiwords-auto-fill-icon' });
        setIcon(localDictIcon, 'book-open');
        localDictBtn.setAttribute('aria-label', '从本地词库自动填充');

        localDictBtn.addEventListener('click', async () => {
            const queryWord = this.isEditMode ? this.word : (wordInput?.value.trim() || '');
            if (!queryWord) {
                new Notice('请先输入单词');
                return;
            }
            const found = await this.autoFillFromDictionary(queryWord, aliasesInput, definitionInput, true);
            if (!found) {
                new Notice('本地词库中未找到该单词');
            }
        });

        if (this.settings.aiDefinition.enabled) {
            const autoFillBtn = autoFillActionsContainer.createDiv({ cls: 'hiwords-auto-fill-btn' });
            const iconContainer = autoFillBtn.createDiv({ cls: 'hiwords-auto-fill-icon' });
            setIcon(iconContainer, 'sparkles');
            autoFillBtn.setAttribute('aria-label', 'AI 自动填充释义');

            autoFillBtn.addEventListener('click', async () => {
                const queryWord = this.isEditMode ? this.word : (wordInput?.value.trim() || '');
                if (!queryWord) {
                    new Notice('请先输入单词');
                    return;
                }
                if (!this.settings.aiService?.apiUrl || !this.settings.aiService?.apiKey || !this.settings.aiService?.model) {
                    new Notice('API Key 未配置，请在插件设置中填写');
                    return;
                }
                autoFillBtn.addClass('hiwords-loading');
                iconContainer.empty();
                setIcon(iconContainer, 'loader');
                try {
                    const dictionaryService = new DictionaryService({
                        service: this.settings.aiService,
                        prompt: this.settings.aiDefinition.prompt
                    });
                    const { definition: aiDefinition, aliases: aiAliases } = await dictionaryService.fetchDefinition(queryWord, this.sentence);
                    // 确保中文词典已加载（如启用）
                    const cnCfg = this.settings.chineseDictionary;
                    if (cnCfg?.enabled && cnCfg?.path && !this.localDictionary.isCnDictionaryLoaded()) {
                        try { await this.localDictionary.loadChineseDictionary(cnCfg.path); } catch (e) { console.warn(e); }
                    }
                    const localResult = this.localDictionary.lookupSync(queryWord);
                    const currentDefinition = definitionInput.value.trim();
                    const currentAliases = aliasesInput.value.trim();

                    if (localResult) {
                        if (!currentAliases && localResult.aliases.length > 0) {
                            aliasesInput.value = localResult.aliases.join(', ');
                        }
                        const localDefinition = this.formatDefinitions(localResult.definitions);
                        // AI 释义显示在词典释义之前
                        if (currentDefinition) {
                            definitionInput.value = `${aiDefinition}\n\n--- 已有释义 ---\n${currentDefinition}`;
                        } else {
                            definitionInput.value = `${aiDefinition}\n\n--- 词典释义 ---\n${localDefinition}`;
                        }
                    } else {
                        definitionInput.value = aiDefinition;
                        if (!currentAliases) {
                            const aliasesToFill = aiAliases.length > 0 ? aiAliases : await this.deriveAliases(queryWord);
                            if (aliasesToFill.length > 0) {
                                aliasesInput.value = aliasesToFill.join(', ');
                            }
                        }
                    }
                    new Notice('释义获取成功');
                } catch (error) {
                    console.error('Failed to fetch definition:', error);
                    const errorMessage = error instanceof Error ? error.message : '获取释义失败';
                    new Notice(errorMessage);
                } finally {
                    autoFillBtn.removeClass('hiwords-loading');
                    iconContainer.empty();
                    setIcon(iconContainer, 'sparkles');
                }
            });
        }

        const definitionInput = definitionContainer.createEl('textarea', {
            placeholder: '输入词汇释义...',
            cls: 'setting-item-input hiwords-word-definition-input'
        });
        definitionInput.rows = 5;

        if (this.isEditMode && this.definition) {
            definitionInput.value = this.definition.rawDefinition || this.definition.definition;
        } else if (this.prefilledDefinition) {
            definitionInput.value = this.prefilledDefinition;
        }

        // Auto-fill from local dictionary when word input loses focus
        if (!this.isEditMode && wordInput) {
            const inputEl = wordInput;
            inputEl.addEventListener('blur', () => {
                void this.autoFillFromDictionary(inputEl.value.trim(), aliasesInput, definitionInput, false);
            });

            // Auto-fill immediately if word is pre-filled
            if (this.word) {
                activeWindow.setTimeout(() => {
                    void this.autoFillFromDictionary(this.word, aliasesInput, definitionInput, false);
                }, 100);
            }
        }

        activeWindow.setTimeout(() => {
            if (!this.isEditMode && this.word) {
                definitionInput.focus();
            } else if (this.isEditMode && this.definition) {
                definitionInput.focus();
            }
        }, 50);

        // 按钮
        const buttonContainer = contentEl.createDiv({ cls: 'hiwords-modal-button-container' });
        const leftButtonGroup = buttonContainer.createDiv({ cls: 'hiwords-button-group-left' });

        if (this.isEditMode && this.definition) {
            const deleteButton = leftButtonGroup.createEl('button', { cls: 'delete-word-button' });
            setIcon(deleteButton, 'trash');
            deleteButton.onclick = async () => {
                const confirmed = window.confirm(`确定要删除词汇 "${this.definition?.word || this.word}" 吗？\n此操作不可撤销。`);
                if (!confirmed) return;
                const loadingNotice = new Notice('正在删除词汇...', 0);
                const definition = this.definition;
                if (!definition) return;
                try {
                    const success = await this.vocabularyManager.deleteWordFromCanvas(definition.source, definition.nodeId);
                    loadingNotice.hide();
                    if (success) {
                        new Notice('词汇已删除');
                        if (this.onWordAdded) this.onWordAdded();
                        this.close();
                    } else {
                        new Notice('删除词汇失败');
                    }
                } catch (error) {
                    loadingNotice.hide();
                    console.error('删除词汇时发生错误:', error);
                    new Notice('删除词汇时发生错误');
                }
            };
        }

        const rightButtonGroup = buttonContainer.createDiv({ cls: 'hiwords-button-group-right' });
        const cancelButton = rightButtonGroup.createEl('button', { text: '取消' });
        cancelButton.onclick = () => this.close();

        const actionButton = rightButtonGroup.createEl('button', { text: this.isEditMode ? '保存' : '添加', cls: 'mod-cta' });
        actionButton.onclick = async () => {
            let finalWord = this.word;
            if (!this.isEditMode && wordInput) {
                finalWord = wordInput.value.trim();
                if (!finalWord) {
                    new Notice('请输入单词');
                    wordInput.focus();
                    return;
                }
            }

            const selectedBooks = bookCheckboxes
                .filter(item => item.checkbox.checked)
                .map(item => item.path);
            const definition = definitionInput.value;
            const colorValue = colorSelect.value ? parseInt(colorSelect.value) : undefined;
            const aliasesText = aliasesInput.value.trim();

            let aliases: string[] | undefined = undefined;
            if (aliasesText) {
                aliases = aliasesText.split(',').map(alias => alias.trim().toLowerCase()).filter(alias => alias.length > 0);
                if (aliases.length === 0) aliases = undefined;
            }

            if (selectedBooks.length === 0) {
                new Notice('请至少选择一个生词本');
                return;
            }

            const loadingNotice = this.isEditMode ?
                new Notice('正在更新词汇...', 0) :
                new Notice('正在添加词汇到生词本...', 0);

            try {
                let success = false;
                if (this.isEditMode && this.definition) {
                    success = await this.vocabularyManager.updateWordInCanvas(
                        this.definition.source,
                        this.definition.nodeId,
                        finalWord,
                        definition,
                        colorValue,
                        aliases
                    );
                    loadingNotice.hide();
                    if (success) {
                        new Notice(`词汇 "${finalWord}" 已成功更新`);
                        // 相遇记账：编辑保存成功也算一次相遇（优先用词条 studyKey）
                        const editKey = this.definition?.studyKey || finalWord.toLowerCase();
                        getEncounterTracker()?.record(editKey, 'add');
                        if (this.onWordAdded) this.onWordAdded();
                        this.close();
                    } else {
                        new Notice('更新词汇失败');
                    }
                } else {
                    success = await this.vocabularyManager.addWordToMultipleCanvas(
                        selectedBooks,
                        finalWord,
                        definition,
                        colorValue,
                        aliases
                    );
                    loadingNotice.hide();
                    if (success) {
                        AddWordModal.lastSelectedColorValue = colorSelect.value || '';
                        AddWordModal.lastSelectedBookPaths = selectedBooks;
                        new Notice(`词汇 "${finalWord}" 已成功添加到 ${selectedBooks.length} 个生词本`);
                        // 相遇记账：新词添加成功（新词暂无 studyKey，用 word 小写）
                        getEncounterTracker()?.record(finalWord.toLowerCase(), 'add');
                        if (this.onWordAdded) this.onWordAdded();
                        this.close();
                    } else {
                        new Notice('添加词汇失败，请检查生词本文件');
                    }
                }
            } catch (error) {
                loadingNotice.hide();
                console.error('Failed to add/update word:', error);
                new Notice('处理词汇时出错');
            }
        };
    }

    private async autoFillFromDictionary(
        queryWord: string,
        aliasesInput: HTMLInputElement,
        definitionInput: HTMLTextAreaElement,
        showNotice = true
    ): Promise<boolean> {
        const cnConfig = this.settings.chineseDictionary;
        const legalConfig = this.settings.legalDictionary;
        const cnEnabled = cnConfig?.enabled && !!cnConfig?.path;
        const legalEnabled = legalConfig?.enabled && !!legalConfig?.path;

        // 两个词典都未启用
        if (!cnEnabled && !legalEnabled) return false;

        // 确保法律词典已加载（如启用）
        if (legalEnabled && !this.localDictionary.isLegalDictionaryLoaded()) {
            try {
                await this.localDictionary.loadLegalDictionary(legalConfig.path);
            } catch (err) {
                console.warn('法律词典加载失败:', err);
            }
        }

        // 确保中文词典已加载（如启用）
        if (cnEnabled && !this.localDictionary.isCnDictionaryLoaded()) {
            try {
                await this.localDictionary.loadChineseDictionary(cnConfig.path);
            } catch (err) {
                console.warn('中文词典加载失败:', err);
            }
        }

        const result = await this.localDictionary.lookupAll(queryWord);
        if (!result || (
            result.definitions.length === 0 &&
            !(result.legalDefinitions && result.legalDefinitions.length > 0) &&
            result.aliases.length === 0
        )) return false;

        if (result.aliases.length > 0 && !aliasesInput.value.trim()) {
            aliasesInput.value = result.aliases.join(', ');
        }

        if (!definitionInput.value.trim()) {
            const parts: string[] = [];
            if (result.definitions.length > 0) {
                parts.push(this.formatDefinitions(result.definitions));
            }
            if (result.legalDefinitions && result.legalDefinitions.length > 0) {
                parts.push(this.formatLegalDefinitions(result.legalDefinitions, result.legalPos, result.legalYear));
            }
            if (parts.length > 0) {
                definitionInput.value = parts.join('\n\n');
            }
        }

        if (showNotice) {
            new Notice('已从本地词库自动填充');
        }
        return true;
    }

    private formatLegalDefinitions(definitions: string[], pos?: string, year?: string): string {
        const header = '--- Black\'s Law Dictionary ---';
        const meta: string[] = [];
        if (pos) meta.push(pos);
        if (year) meta.push(`(${year})`);
        const metaStr = meta.length > 0 ? ` ${meta.join(' ')}` : '';
        return header + metaStr + '\n' + definitions
            .map((def, idx) => `${idx + 1}. ${def}`)
            .join('\n');
    }

    private formatDefinitions(definitions: string[]): string {
        return definitions
            .map((def, idx) => `${idx + 1}. ${def}`)
            .join('\n');
    }

    /**
     * 当 AI 没有返回别名时，根据常见词形变化规则从本地词库推导可能的原形。
     */
    private async deriveAliases(word: string): Promise<string[]> {
        const lower = word.trim().toLowerCase();
        if (!lower) return [];

        const candidates = new Set<string>();

        // -ing: running -> run, suing -> sue, making -> make
        if (lower.endsWith('ing')) {
            const stem = lower.slice(0, -3);
            if (stem.length > 0) {
                // drop double final consonant: running -> run
                if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
                    candidates.add(stem.slice(0, -1));
                }
                candidates.add(stem + 'e');
                candidates.add(stem);
            }
        }

        // -ed: baked -> bake, stopped -> stop
        if (lower.endsWith('ed')) {
            const stem = lower.slice(0, -2);
            if (stem.length > 0) {
                if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
                    candidates.add(stem.slice(0, -1));
                }
                candidates.add(stem + 'e');
                candidates.add(stem);
            }
        }

        // -ies: companies -> company
        if (lower.endsWith('ies')) {
            candidates.add(lower.slice(0, -3) + 'y');
        }

        // -es: goes -> go, watches -> watch
        if (lower.endsWith('es')) {
            const stem = lower.slice(0, -2);
            candidates.add(stem + 'e');
            candidates.add(stem);
        }

        // -s: books -> book
        if (lower.endsWith('s') && !lower.endsWith('ss')) {
            candidates.add(lower.slice(0, -1));
        }

        // -er/-est: bigger -> big, biggest -> big
        if (lower.endsWith('er') || lower.endsWith('est')) {
            const suffixLen = lower.endsWith('est') ? 3 : 2;
            const stem = lower.slice(0, -suffixLen);
            if (stem.length > 0) {
                if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
                    candidates.add(stem.slice(0, -1));
                }
                candidates.add(stem + 'e');
                candidates.add(stem);
            }
        }

        // Only keep candidates that exist in the local dictionary and are not the word itself.
        return Array.from(candidates)
            .filter(candidate => candidate !== lower && this.localDictionary.lookupSync(candidate))
            .sort();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

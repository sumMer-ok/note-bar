import { EventRef, ItemView, WorkspaceLeaf, TFile, MarkdownView, MarkdownRenderer, setIcon, Notice } from 'obsidian';
import type NoteBarPlugin from '../../main';
import { WordDefinition, mapCanvasColorToCSSVar, getColorWithOpacity } from '../utils';
import { playWordTTS, Trie } from '../utils';
import { findPatternMatches } from '../utils/pattern-matcher';
import { renderWordCard } from './word-card-renderer';
import { FlashcardBookPickerModal } from './flashcard-book-picker-modal';
import { getTodayTotalTaskCount } from '../core/flashcard-queue';

export const SIDEBAR_VIEW_TYPE = 'hi-words-sidebar';

type HiWordsWorkspaceEventName = 'hi-words:mastered-changed' | 'hi-words:settings-changed';

interface HiWordsWorkspaceEvents {
    on(name: HiWordsWorkspaceEventName, callback: () => void): EventRef;
}

interface HoverLinkWorkspace {
    trigger(name: 'hover-link', payload: {
        event: Event;
        source: string;
        hoverParent: HTMLElement;
        target: HTMLElement;
        linktext: string;
        sourcePath: string;
    }): void;
}

interface SearchViewLike {
    setQuery?: (query: string) => void;
}

export class HiWordsSidebarView extends ItemView {
    private plugin: NoteBarPlugin;
    private currentWords: WordDefinition[] = [];
    private activeTab: 'learning' | 'mastered' = 'learning';
    private currentFile: TFile | null = null;
    private firstLoadForFile = false;
    private updateTimer: number | null = null;
    private delegatedBound = false;
    private lastInteractionTime = 0;
    private patternDefinitionsCache: WordDefinition[] = [];
    private normalDefinitionsCache: WordDefinition[] = [];
    private sectionTabStates: Map<string, number> = new Map();
    private expandedWordStates: Map<string, boolean> = new Map();
    private manualDetailMode = false;

    constructor(leaf: WorkspaceLeaf, plugin: NoteBarPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return SIDEBAR_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'HiWords 生词本';
    }

    getIcon(): string {
        return 'book-open';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('hi-words-sidebar');
        this.bindDelegatedHandlers(container as HTMLElement);

        this.scheduleUpdate(0);

        this.registerEvent(
            this.app.workspace.on('file-open', (file: TFile | null) => {
                if (file && (file.extension === 'md' || file.extension === 'pdf')) {
                    this.manualDetailMode = false;
                }
                this.scheduleUpdate(120);
            })
        );

        this.registerEvent(
            this.app.workspace.on('editor-change', () => {
                this.scheduleUpdate(500);
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) {
                    if (file.extension === 'canvas' || file.extension === 'md') {
                        this.scheduleUpdate(250);
                    }
                }
            })
        );

        this.registerEvent(
            (this.app.workspace as unknown as HiWordsWorkspaceEvents).on('hi-words:mastered-changed', () => {
                this.scheduleUpdate(100);
            })
        );

        this.registerEvent(
            (this.app.workspace as unknown as HiWordsWorkspaceEvents).on('hi-words:settings-changed', () => {
                this.scheduleUpdate(100);
            })
        );
    }

    async onClose() {
        // 清理资源
    }

    async focusWord(wordDef: WordDefinition, origin: 'document' | 'library' = 'document') {
        if (this.updateTimer !== null) {
            activeWindow.clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        const key = this.getWordStateKey(wordDef);

        if (origin === 'library') {
            this.manualDetailMode = true;
            this.currentFile = null;
            this.currentWords = [wordDef];
            this.activeTab = wordDef.mastered ? 'mastered' : 'learning';
            this.expandedWordStates.set(key, true);
            this.firstLoadForFile = false;
            this.lastInteractionTime = Date.now();
            await this.renderWordList();
            this.scrollWordCardIntoView(key);
            return;
        }

        this.manualDetailMode = false;
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && (activeFile.extension === 'md' || activeFile.extension === 'pdf') && (activeFile !== this.currentFile || this.currentWords.length === 0)) {
            this.currentFile = activeFile;
            this.firstLoadForFile = true;
            await this.scanCurrentDocument();
        }

        const existingIndex = this.currentWords.findIndex(item => this.getWordStateKey(item) === key);
        if (existingIndex < 0) {
            this.currentWords.unshift(wordDef);
        }
        this.activeTab = wordDef.mastered ? 'mastered' : 'learning';
        this.expandedWordStates.set(key, true);
        this.firstLoadForFile = false;
        this.lastInteractionTime = Date.now();
        await this.renderWordList();
        this.scrollWordCardIntoView(key);
    }

    public applyDefaultDisplayMode() {
        this.expandedWordStates.clear();
        void this.renderWordList();
    }

    private scrollWordCardIntoView(wordKey: string) {
        requestAnimationFrame(() => {
            const cards = this.containerEl.querySelectorAll('.hi-words-word-card');
            for (const card of Array.from(cards)) {
                if ((card as HTMLElement).getAttr('data-word-key') === wordKey) {
                    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    return;
                }
            }
        });
    }

    private async updateView() {
        if (this.manualDetailMode) {
            return;
        }

        const activeFile = this.app.workspace.getActiveFile();

        if (!activeFile || (activeFile.extension !== 'md' && activeFile.extension !== 'pdf')) {
            this.showEmptyState('请打开一个 Markdown 文档或 PDF 文件');
            return;
        }

        if (activeFile === this.currentFile && this.currentWords.length > 0) {
            return;
        }

        const isFileChanged = activeFile !== this.currentFile;
        this.currentFile = activeFile;
        if (isFileChanged) {
            this.firstLoadForFile = true;
        }
        await this.scanCurrentDocument();
        this.renderWordList();
    }

    private scheduleUpdate(delay: number) {
        const timeSinceInteraction = Date.now() - this.lastInteractionTime;
        if (timeSinceInteraction < 500) {
            return;
        }

        if (this.updateTimer !== null) {
            activeWindow.clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        this.updateTimer = activeWindow.setTimeout(() => {
            this.updateTimer = null;
            void this.updateView();
        }, Math.max(0, delay));
    }

    private async scanCurrentDocument() {
        if (!this.currentFile) return;

        try {
            let content: string;

            if (this.currentFile.extension === 'pdf') {
                content = await this.extractPDFText();
            } else {
                content = await this.app.vault.cachedRead(this.currentFile);
            }

            await this.updateDefinitionsCache();

            const foundWordsByKey = new Map<string, { wordDef: WordDefinition, position: number }>();

            const trie = new Trie();
            for (const wordDef of this.normalDefinitionsCache) {
                trie.addWord(wordDef.word, wordDef);
                wordDef.aliases?.forEach(alias => {
                    if (alias) trie.addWord(alias, wordDef);
                });
            }

            for (const match of trie.findAllMatches(content)) {
                const wordDef = match.payload as WordDefinition;
                const key = this.getWordStateKey(wordDef);
                const existing = foundWordsByKey.get(key);
                if (!existing || match.from < existing.position) {
                    foundWordsByKey.set(key, {
                        wordDef,
                        position: match.from
                    });
                }
            }

            for (const wordDef of this.patternDefinitionsCache) {
                if (wordDef.patternParts && wordDef.patternParts.length > 0) {
                    const matches = findPatternMatches(content, wordDef.patternParts, 0);
                    if (matches.length > 0) {
                        const position = matches[0].from;
                        const key = this.getWordStateKey(wordDef);
                        const existing = foundWordsByKey.get(key);
                        if (!existing || position < existing.position) {
                            foundWordsByKey.set(key, {
                                wordDef: wordDef,
                                position: position
                            });
                        }
                    }
                }
            }

            const foundWordsWithPosition = [...foundWordsByKey.values()];
            foundWordsWithPosition.sort((a, b) => a.position - b.position);
            this.currentWords = foundWordsWithPosition.map(item => item.wordDef);
        } catch (error) {
            console.error('Failed to scan document:', error);
            this.currentWords = [];
        }
    }

    private async updateDefinitionsCache(): Promise<void> {
        const allWordDefinitions = this.plugin.vocabularyManager!.getStudyDefinitions();

        this.normalDefinitionsCache = [];
        this.patternDefinitionsCache = [];

        for (const wordDef of allWordDefinitions) {
            if (wordDef.isPattern && wordDef.patternParts && wordDef.patternParts.length > 0) {
                this.patternDefinitionsCache.push(wordDef);
            } else {
                this.normalDefinitionsCache.push(wordDef);
            }
        }
    }

    private async renderWordList() {
        const container = this.containerEl.querySelector('.hi-words-sidebar');
        if (!container) return;

        container.empty();
        this.bindDelegatedHandlers(container as HTMLElement);
        this.renderReviewHeader(container as HTMLElement);

        if (this.currentWords.length === 0) {
            const emptyState = (container as HTMLElement).createEl('div', { cls: 'hi-words-empty-state' });
            emptyState.createEl('div', { text: '当前文档中没有生词', cls: 'hi-words-empty-text' });
            return;
        }

        const unmasteredWords = this.currentWords.filter(word => !word.mastered);
        const masteredWords = this.currentWords.filter(word => word.mastered);

        if (this.firstLoadForFile && this.activeTab === 'learning' && unmasteredWords.length === 0 && masteredWords.length > 0) {
            this.activeTab = 'mastered';
        }
        this.firstLoadForFile = false;

        this.createTabNavigation(container as HTMLElement, unmasteredWords.length, masteredWords.length);
        await this.createTabContent(container as HTMLElement, unmasteredWords, masteredWords);
    }

    private renderReviewHeader(container: HTMLElement) {
        const header = container.createDiv({ cls: 'hi-words-review-header' });
        header.createDiv({ cls: 'hi-words-review-title', text: 'HiWords 生词本' });

        const dueCount = this.getTodayReviewCount();
        const reviewBtn = header.createEl('button', {
            cls: 'hi-words-review-button',
            text: `今日待复习 ${dueCount}`
        });
        reviewBtn.onclick = () => {
            new FlashcardBookPickerModal(this.app, this.plugin).open();
        };
    }

    private getTodayReviewCount(): number {
        const vocabularyManager = this.plugin.vocabularyManager;
        if (!vocabularyManager) return 0;

        const settings = this.plugin.hiwordsSettings;
        const flashcard = settings.flashcard;
        if (!flashcard) return 0;

        const enabledCanvasBooks = settings.vocabularyBooks
            .filter(b => b.enabled && b.path.endsWith('.canvas'))
            .map(b => b.path);

        if (enabledCanvasBooks.length === 0) return 0;

        const studyItems = vocabularyManager.getStudyItems();
        const progress = settings.studyProgress || {};

        return getTodayTotalTaskCount(studyItems, progress, enabledCanvasBooks);
    }

    private createTabNavigation(container: HTMLElement, learningCount: number, masteredCount: number) {
        const tabNav = container.createEl('div', { cls: 'hi-words-tab-nav' });

        const learningTab = tabNav.createEl('div', {
            cls: `hi-words-tab ${this.activeTab === 'learning' ? 'active' : ''}`,
            attr: { 'data-tab': 'learning' }
        });
        learningTab.createEl('span', { text: `待学习 (${learningCount})` });

        if (this.plugin.hiwordsSettings.enableMasteredFeature) {
            const masteredTab = tabNav.createEl('div', {
                cls: `hi-words-tab ${this.activeTab === 'mastered' ? 'active' : ''}`,
                attr: { 'data-tab': 'mastered' }
            });
            masteredTab.createEl('span', { text: `已掌握 (${masteredCount})` });
        }
    }

    private async createTabContent(container: HTMLElement, unmasteredWords: WordDefinition[], masteredWords: WordDefinition[]) {
        if (this.activeTab === 'learning') {
            if (unmasteredWords.length > 0) {
                await this.createWordList(container, unmasteredWords, false);
            } else {
                this.createEmptyState(container, '暂无待学习单词');
            }
        } else if (this.activeTab === 'mastered') {
            if (masteredWords.length > 0) {
                await this.createWordList(container, masteredWords, true);
            } else {
                this.createEmptyState(container, '暂无已掌握单词');
            }
        }
    }

    private switchTab(tab: 'learning' | 'mastered') {
        if (this.activeTab === tab) return;

        this.activeTab = tab;
        this.renderWordList();
    }

    private async createWordList(container: HTMLElement, words: WordDefinition[], isMastered: boolean) {
        const wordList = container.createEl('div', { cls: 'hi-words-word-list' });

        for (const wordDef of words) {
            await this.createWordCard(wordList, wordDef, isMastered);
        }
    }

    private async createWordCard(container: HTMLElement, wordDef: WordDefinition, isMastered = false) {
        const wordKey = this.getWordStateKey(wordDef);
        const isExpanded = this.getWordExpandedState(wordDef);
        const card = container.createEl('div', {
            cls: `hi-words-word-card ${isExpanded ? 'is-expanded' : 'is-collapsed'}`,
            attr: { 'data-word-key': wordKey }
        });

        if (wordDef.color) {
            const borderColor = mapCanvasColorToCSSVar(wordDef.color, 'var(--color-base-60)');
            card.style.setProperty('--word-card-accent-color', borderColor);
            const bgColor = getColorWithOpacity(borderColor, 0.1);
            card.style.setProperty('--word-card-bg-color', bgColor);
        }

        const wordTitle = card.createEl('div', { cls: 'hi-words-word-title' });
        const wordTextEl = wordTitle.createEl('span', {
            text: wordDef.word,
            cls: 'hi-words-word-text'
        });

        wordTextEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            await playWordTTS(this.app, this.plugin.hiwordsSettings, wordDef.word, wordDef);
        });

        wordTitle.createEl('div', {
            cls: 'hi-words-card-toggle-spacer',
            attr: {
                'aria-label': isExpanded ? '收起' : '展开',
                'data-word-key': wordKey
            }
        });

        if (this.plugin.hiwordsSettings.enableMasteredFeature && this.plugin.masteredService) {
            const buttonContainer = wordTitle.createEl('div', {
                cls: 'hi-words-title-mastered-button',
                attr: {
                    'aria-label': isMastered ? '取消已掌握' : '标记为已掌握'
                }
            });

            setIcon(buttonContainer, isMastered ? 'frown' : 'smile');
        }

        const enableSectionTabs = this.plugin.hiwordsSettings.enableSectionTabs ?? true;
        const sections = wordDef.sections;
        const savedSectionIndex = this.sectionTabStates.get(wordDef.word) ?? 0;
        const activeSectionIndex = sections && sections.length > savedSectionIndex ? savedSectionIndex : 0;

        if (isExpanded && !wordDef.card && sections && sections.length > 1 && enableSectionTabs) {
            const tabsContainer = card.createEl('div', { cls: 'hi-words-card-tabs' });

            sections.forEach((section, index) => {
                tabsContainer.createEl('div', {
                    cls: `hi-words-card-tab ${index === activeSectionIndex ? 'active' : ''}`,
                    text: section.title,
                    attr: { 'data-section-index': index.toString() }
                });
            });
        }

        const contentToRender = sections && sections.length > 0 && enableSectionTabs
            ? sections[activeSectionIndex].content
            : wordDef.definition;

        if (isExpanded && wordDef.card) {
            const definition = card.createEl('div', { cls: 'hi-words-word-definition hi-words-word-definition-structured' });
            const defContainer = definition.createEl('div', {
                cls: this.plugin.hiwordsSettings.blurDefinitions ? 'hi-words-definition blur-enabled' : 'hi-words-definition'
            });
            renderWordCard(defContainer, wordDef, {
                mode: 'sidebar',
                app: this.app,
                pronunciationVariant: this.plugin.hiwordsSettings.pronunciationVariant || 'us',
                onPronunciationClick: (variant) => playWordTTS(this.app, this.plugin.hiwordsSettings, wordDef.word, wordDef, variant),
                display: this.plugin.getVocabularyBookDisplaySettings(wordDef.source),
            });
        } else if (isExpanded && contentToRender && contentToRender.trim()) {
            const definition = card.createEl('div', { cls: 'hi-words-word-definition' });

            const defContainer = definition.createEl('div', {
                cls: this.plugin.hiwordsSettings.blurDefinitions ? 'hi-words-definition blur-enabled' : 'hi-words-definition'
            });

            await this.renderSectionContent(defContainer, contentToRender);
        }

        if (isExpanded && !wordDef.source.endsWith('.hiwords')) {
            const source = card.createEl('div', { cls: 'hi-words-word-source' });
            const bookName = this.getBookNameFromPath(wordDef.source);
            source.createEl('span', { text: `来源: ${bookName}`, cls: 'hi-words-source-text' });

            source.addEventListener('click', (e) => {
                e.stopPropagation();
                this.navigateToSource(wordDef);
            });
        }

        if (isMastered) {
            card.addClass('hi-words-word-card-mastered');
        }
    }

    private getDefaultExpandedState(): boolean {
        if (this.plugin.hiwordsSettings.hideDefinitions) {
            return false;
        }
        return (this.plugin.hiwordsSettings.sidebarDefaultDisplayMode || 'detail') === 'detail';
    }

    private getWordStateKey(wordDef: WordDefinition): string {
        return `${wordDef.source}::${wordDef.nodeId}::${wordDef.word}`;
    }

    private getWordExpandedState(wordDef: WordDefinition): boolean {
        const wordKey = this.getWordStateKey(wordDef);
        return this.expandedWordStates.get(wordKey) ?? this.getDefaultExpandedState();
    }

    private async renderSectionContent(container: HTMLElement, content: string): Promise<void> {
        container.empty();

        if (!content || content.trim() === '') {
            container.textContent = '暂无释义';
            return;
        }

        try {
            const leaf = this.app.workspace.getMostRecentLeaf();
            const activeView = leaf?.view instanceof MarkdownView ? leaf.view : null;
            const sourcePath = (activeView && activeView.file?.path) || this.app.workspace.getActiveFile()?.path || '';

            await MarkdownRenderer.render(
                this.plugin.app,
                content,
                container,
                sourcePath,
                this
            );

            requestAnimationFrame(() => this.bindInternalLinksAndTags(container, sourcePath, container));
        } catch (error) {
            console.error('Markdown 渲染失败:', error);
            container.textContent = content;
        }
    }

    private createEmptyState(container: HTMLElement, message: string) {
        const emptyState = container.createEl('div', { cls: 'hi-words-empty-state' });
        emptyState.createEl('div', { text: message, cls: 'hi-words-empty-text' });
    }

    private showEmptyState(message: string) {
        const container = this.containerEl.querySelector('.hi-words-sidebar');
        if (!container) return;

        container.empty();
        const emptyState = container.createEl('div', { cls: 'hi-words-empty-state' });
        emptyState.createEl('div', { text: message, cls: 'hi-words-empty-text' });
    }

    private bindDelegatedHandlers(root: HTMLElement) {
        if (this.delegatedBound) return;
        root.addEventListener(
            'mousedown',
            (e) => {
                const target = e.target as HTMLElement | null;
                if (!target) return;

                const tabEl = target.closest('.hi-words-tab') as HTMLElement | null;
                if (tabEl && root.contains(tabEl)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const tab = (tabEl.getAttr('data-tab') as 'learning' | 'mastered') || 'learning';
                    if (tab !== this.activeTab) this.switchTab(tab);
                    return;
                }

                const cardTabEl = target.closest('.hi-words-card-tab') as HTMLElement | null;
                if (cardTabEl && root.contains(cardTabEl)) {
                    e.preventDefault();
                    e.stopPropagation();

                    this.lastInteractionTime = Date.now();
                    if (this.updateTimer !== null) {
                        activeWindow.clearTimeout(this.updateTimer);
                        this.updateTimer = null;
                    }

                    const sectionIndex = parseInt(cardTabEl.getAttr('data-section-index') || '0', 10);
                    const card = cardTabEl.closest('.hi-words-word-card') as HTMLElement | null;
                    const wordText = card?.querySelector('.hi-words-word-text') as HTMLElement | null;
                    const word = wordText?.textContent?.trim();
                    if (!card || !word) return;

                    const wordDef = this.currentWords.find(w => w.word === word);
                    if (!wordDef?.sections || sectionIndex >= wordDef.sections.length) return;

                    this.sectionTabStates.set(word, sectionIndex);
                    card.querySelectorAll('.hi-words-card-tab').forEach(tab => tab.removeClass('active'));
                    cardTabEl.addClass('active');

                    const defContainer = card.querySelector('.hi-words-definition') as HTMLElement | null;
                    if (defContainer) {
                        void this.renderSectionContent(defContainer, wordDef.sections[sectionIndex].content);
                    }
                    return;
                }

                const toggleEl = target.closest('.hi-words-card-toggle-spacer') as HTMLElement | null;
                if (toggleEl && root.contains(toggleEl)) {
                    e.preventDefault();
                    e.stopPropagation();

                    this.lastInteractionTime = Date.now();
                    if (this.updateTimer !== null) {
                        activeWindow.clearTimeout(this.updateTimer);
                        this.updateTimer = null;
                    }

                    const card = toggleEl.closest('.hi-words-word-card') as HTMLElement | null;
                    const wordKey = toggleEl.getAttr('data-word-key') || card?.getAttr('data-word-key');
                    if (wordKey) {
                        const currentState = this.expandedWordStates.get(wordKey);
                        const isCurrentlyExpanded = currentState ?? this.getDefaultExpandedState();
                        this.expandedWordStates.set(wordKey, !isCurrentlyExpanded);
                        void this.renderWordList();
                    }
                    return;
                }

                const masteredBtn = target.closest('.hi-words-title-mastered-button') as HTMLElement | null;
                if (masteredBtn && root.contains(masteredBtn)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const card = masteredBtn.closest('.hi-words-word-card') as HTMLElement | null;
                    const isMastered = !!card?.hasClass('hi-words-word-card-mastered');
                    const wordText = card?.querySelector('.hi-words-word-text') as HTMLElement | null;
                    const word = wordText?.textContent?.trim();
                    if (word && this.plugin.hiwordsSettings.enableMasteredFeature && this.plugin.masteredService) {
                        const detail = this.currentWords.find((w) => w.word === word);
                        if (detail) {
                            void (async () => {
                                try {
                                    const masteredService = this.plugin.masteredService;
                                    if (!masteredService) return;

                                    if (isMastered) {
                                        await masteredService.unmarkWordAsMastered(detail.source, detail.nodeId, detail.word);
                                    } else {
                                        await masteredService.markWordAsMastered(detail.source, detail.nodeId, detail.word);
                                    }
                                    activeWindow.setTimeout(() => {
                                        void this.updateView();
                                    }, 100);
                                } catch (err) {
                                    console.error('切换已掌握状态失败:', err);
                                }
                            })();
                        }
                    }
                    return;
                }

                const sourceEl = target.closest('.hi-words-word-source') as HTMLElement | null;
                if (sourceEl && root.contains(sourceEl)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const card = sourceEl.closest('.hi-words-word-card') as HTMLElement | null;
                    const wordText = card?.querySelector('.hi-words-word-text') as HTMLElement | null;
                    const word = wordText?.textContent?.trim();
                    if (word) {
                        const detail = this.currentWords.find((w) => w.word === word);
                        if (detail) this.navigateToSource(detail);
                    }
                    return;
                }
            },
            { capture: true }
        );
        this.delegatedBound = true;
    }

    private getBookNameFromPath(path: string): string {
        const book = this.plugin.hiwordsSettings.vocabularyBooks.find(b => b.path === path);
        return book ? book.name : path.split('/').pop()?.replace('.canvas', '') || '未知';
    }

    private escapeRegExp(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private async extractPDFText(): Promise<string> {
        try {
            await new Promise(resolve => activeWindow.setTimeout(resolve, 500));

            const textLayers = document.querySelectorAll('.textLayer');
            let extractedText = '';

            textLayers.forEach((textLayer: Element) => {
                const pdfContainer = textLayer.closest('.pdf-container, .mod-pdf');
                if (pdfContainer) {
                    const textSpans = textLayer.querySelectorAll('span[role="presentation"]');
                    textSpans.forEach((span: Element) => {
                        const text = span.textContent || '';
                        if (text.trim()) {
                            extractedText += text + ' ';
                        }
                    });
                    extractedText += '\n';
                }
            });

            if (!extractedText.trim()) {
                const pdfViews = document.querySelectorAll('.pdf-container, .mod-pdf');
                pdfViews.forEach((pdfView: Element) => {
                    const allText = pdfView.textContent || '';
                    if (allText.trim()) {
                        extractedText += allText + '\n';
                    }
                });
            }

            return extractedText.trim();
        } catch (error) {
            console.error('PDF 文本提取失败:', error);
            return '';
        }
    }

    private buildSearchRegex(term: string): RegExp {
        const escaped = this.escapeRegExp(term);
        const hasAsianScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term);
        const pattern = hasAsianScript ? `${escaped}` : `\\b${escaped}\\b`;
        const flags = hasAsianScript ? 'giu' : 'gi';
        return new RegExp(pattern, flags);
    }

    private bindInternalLinksAndTags(root: HTMLElement, sourcePath: string, hoverParent: HTMLElement) {
        root.querySelectorAll('a.internal-link').forEach((a) => {
            const linkEl = a as HTMLAnchorElement;
            const linktext = (linkEl.getAttribute('href') || linkEl.dataset.href || '').trim();
            if (!linktext) return;

            linkEl.addEventListener('mouseover', (evt) => {
                (this.app.workspace as unknown as HoverLinkWorkspace).trigger('hover-link', {
                    event: evt,
                    source: 'hi-words',
                    hoverParent,
                    target: linkEl,
                    linktext,
                    sourcePath
                });
            });

            linkEl.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                void this.app.workspace.openLinkText(linktext, sourcePath).catch(error => {
                    console.error('HiWords 打开内部链接失败:', error);
                });
            });
        });

        root.querySelectorAll('a.tag').forEach((a) => {
            const tagEl = a as HTMLAnchorElement;
            const query = (tagEl.getAttribute('href') || tagEl.textContent || '').trim();
            if (!query) return;
            tagEl.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.openOrUpdateSearch(query.startsWith('#') ? query : `#${query}`);
            });
        });
    }

    private openOrUpdateSearch(query: string) {
        try {
            const leaves = this.app.workspace.getLeavesOfType('search');
            if (leaves.length > 0) {
                const view = leaves[0].view as SearchViewLike;
                view.setQuery?.(query);
                void this.app.workspace.revealLeaf(leaves[0]).catch(error => {
                    console.error('HiWords 打开搜索视图失败:', error);
                });
                return;
            }

            new Notice('请先启用核心搜索插件');
        } catch (e) {
            console.error('打开搜索失败:', e);
        }
    }

    private async navigateToSource(wordDef: WordDefinition) {
        try {
            const file = this.app.vault.getAbstractFileByPath(wordDef.source);
            if (file instanceof TFile) {
                if (file.extension === 'canvas') {
                    await this.app.workspace.openLinkText(file.path, '');
                } else {
                    await this.app.workspace.openLinkText(file.path, '');
                    activeWindow.setTimeout(() => {
                        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                        if (activeView && activeView.file?.path === file.path) {
                            const editor = activeView.editor;
                            const content = editor.getValue();
                            const wordIndex = content.toLowerCase().indexOf(wordDef.word.toLowerCase());
                            if (wordIndex !== -1) {
                                const pos = editor.offsetToPos(wordIndex);
                                editor.setCursor(pos);
                                editor.scrollIntoView({ from: pos, to: pos }, true);
                            }
                        }
                    }, 100);
                }
            }
        } catch (error) {
            console.error('导航到源文件失败:', error);
        }
    }

    public refresh() {
        this.currentFile = null;
        this.scheduleUpdate(0);
    }
}

import { App, TFile } from 'obsidian';
import type { StudyItem, WordDefinition, VocabularyBook, HiWordsSettings } from '../utils';
import { CanvasParser } from '../canvas/canvas-parser';
import { CanvasEditor } from '../canvas/canvas-editor';
import { HiWordsParser } from '../card';

export class VocabularyManager {
    private app: App;
    private canvasParser: CanvasParser;
    private hiWordsParser: HiWordsParser;
    private canvasEditor: CanvasEditor;
    private definitions: Map<string, WordDefinition[]> = new Map();
    private settings: HiWordsSettings;
    private wordDefinitionCache: Map<string, WordDefinition> = new Map();
    private allWordsCache: string[] = [];
    private bookWordsCache: Map<string, string[]> = new Map();
    private studyItemCache: Map<string, StudyItem> = new Map();
    private cacheValid = false;
    private memoryOnlyWords: Map<string, WordDefinition[]> = new Map();
    private pendingSyncWords: Map<string, WordDefinition[]> = new Map();
    private syncTimeouts: Map<string, number> = new Map();
    private tempNodeIdCounter = 0;

    constructor(app: App, settings: HiWordsSettings) {
        this.app = app;
        this.canvasParser = new CanvasParser(app, settings);
        this.hiWordsParser = new HiWordsParser(app);
        this.canvasEditor = new CanvasEditor(app, settings);
        this.settings = settings;
    }

    async loadAllVocabularyBooks(): Promise<void> {
        this.definitions.clear();
        this.invalidateCache();
        const loadPromises = this.settings.vocabularyBooks
            .filter(book => book.enabled)
            .map(book => this.loadVocabularyBook(book));
        await Promise.all(loadPromises);
        this.rebuildCache();
    }

    async loadVocabularyBook(book: VocabularyBook): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(book.path);
        if (!file || !(file instanceof TFile)) {
            console.warn(`Canvas file not found: ${book.path}`);
            return;
        }
        if (!CanvasParser.isCanvasFile(file) && !HiWordsParser.isHiWordsFile(file)) {
            console.warn(`File is not a supported vocabulary book: ${book.path}`);
            return;
        }
        try {
            const isHiWordsBook = HiWordsParser.isHiWordsFile(file);
            const definitions = isHiWordsBook
                ? await this.hiWordsParser.parseFile(file)
                : await this.canvasParser.parseCanvasFile(file);
            if (isHiWordsBook) this.applyBookColor(book, definitions);
            this.applyStoredProgress(definitions);
            this.definitions.set(book.path, definitions);
            this.updateCacheForBook(book.path, definitions);
        } catch (error) {
            console.error(`Failed to load vocabulary book ${book.name}:`, error);
            this.definitions.delete(book.path);
            this.updateCacheForBook(book.path, []);
        }
    }

    getDefinition(word: string, visited: Set<string> = new Set()): WordDefinition | null {
        const normalizedWord = word.toLowerCase().trim();
        if (visited.has(normalizedWord)) return null;
        visited.add(normalizedWord);
        if (this.cacheValid && this.wordDefinitionCache.has(normalizedWord)) {
            return this.wordDefinitionCache.get(normalizedWord) || null;
        }
        if (!this.cacheValid) {
            this.rebuildCache();
            if (this.wordDefinitionCache.has(normalizedWord)) {
                return this.wordDefinitionCache.get(normalizedWord) || null;
            }
        }
        for (const definitions of this.definitions.values()) {
            const foundByMainWord = definitions.find(def => def.word === normalizedWord);
            if (foundByMainWord) {
                this.wordDefinitionCache.set(normalizedWord, foundByMainWord);
                return foundByMainWord;
            }
            const foundByAlias = definitions.find(def => def.aliases && def.aliases.includes(normalizedWord));
            if (foundByAlias) {
                this.wordDefinitionCache.set(normalizedWord, foundByAlias);
                return foundByAlias;
            }
        }
        return null;
    }

    getAllWords(): string[] {
        if (this.cacheValid) return [...this.allWordsCache];
        this.rebuildCache();
        return [...this.allWordsCache];
    }

    hasWord(word: string): boolean {
        const normalizedWord = word.toLowerCase().trim();
        if (this.cacheValid) return this.wordDefinitionCache.has(normalizedWord);
        return this.getDefinition(word) !== null;
    }

    getStats(): { totalBooks: number; enabledBooks: number; totalWords: number } {
        const totalBooks = this.settings.vocabularyBooks.length;
        const enabledBooks = this.settings.vocabularyBooks.filter(b => b.enabled).length;
        let totalWords = 0;
        for (const definitions of this.definitions.values()) {
            totalWords += definitions.length;
        }
        return { totalBooks, enabledBooks, totalWords };
    }

    clear(): void {
        this.definitions.clear();
        this.invalidateCache();
    }

    updateSettings(settings: HiWordsSettings): void {
        const oldSettings = this.settings;
        this.settings = settings;
        const shouldInvalidateCache =
            oldSettings.masteredDetection !== settings.masteredDetection ||
            oldSettings.fileNodeParseMode !== settings.fileNodeParseMode ||
            this.hasVocabularyBooksChanged(oldSettings.vocabularyBooks, settings.vocabularyBooks);
        if (shouldInvalidateCache) this.invalidateCache();
        this.canvasEditor.updateSettings(settings);
        this.canvasParser.updateSettings(settings);
    }

    async addWordToCanvas(bookPath: string, word: string, definition: string, color?: number, aliases?: string[]): Promise<boolean> {
        try {
            const wordDef: WordDefinition = {
                word,
                definition,
                source: bookPath,
                nodeId: this.generateTempNodeId(),
                color: color ? this.getColorString(color) : undefined,
                aliases: aliases?.filter(alias => alias && alias.trim().length > 0)
            };
            this.addWordToMemoryCache(bookPath, wordDef);
            this.rebuildCache();
            this.scheduleCanvasSync(bookPath, wordDef);
            return true;
        } catch (error) {
            console.error('Failed to add word to canvas:', error);
            return false;
        }
    }

    async updateWordInCanvas(bookPath: string, nodeId: string, word: string, definition: string, color?: number, aliases?: string[]): Promise<boolean> {
        try {
            const success = await this.canvasEditor.updateWordInCanvas(bookPath, nodeId, word, definition, color, aliases);
            if (success) {
                const updatedWordDef: WordDefinition = {
                    word,
                    definition,
                    source: bookPath,
                    nodeId,
                    color: color ? this.getColorString(color) : undefined,
                    aliases: aliases?.filter(alias => alias && alias.trim().length > 0)
                };
                this.updateWordInMemoryCache(bookPath, nodeId, updatedWordDef);
                this.rebuildCache();
                return true;
            }
            return false;
        } catch (error) {
            console.error('Failed to update word in canvas:', error);
            return false;
        }
    }

    async deleteWordFromCanvas(bookPath: string, nodeId: string): Promise<boolean> {
        try {
            const success = await this.canvasEditor.deleteWordFromCanvas(bookPath, nodeId);
            if (success) {
                this.deleteWordFromMemoryCache(bookPath, nodeId);
                this.rebuildCache();
                return true;
            }
            return false;
        } catch (error) {
            console.error('Failed to delete word from canvas:', error);
            return false;
        }
    }

    private generateTempNodeId(): string {
        return `temp_${Date.now()}_${++this.tempNodeIdCounter}`;
    }

    private getColorString(color: number): string | undefined {
        return (color >= 1 && color <= 6) ? color.toString() : undefined;
    }

    private addWordToMemoryCache(bookPath: string, wordDef: WordDefinition): void {
        let bookWords = this.definitions.get(bookPath);
        if (!bookWords) {
            bookWords = [];
            this.definitions.set(bookPath, bookWords);
        }
        const existingIndex = bookWords.findIndex(w => w.word === wordDef.word);
        if (existingIndex >= 0) {
            bookWords[existingIndex] = wordDef;
        } else {
            bookWords.push(wordDef);
        }
        this.wordDefinitionCache.set(wordDef.word, wordDef);
        if (wordDef.aliases) {
            wordDef.aliases.forEach(alias => this.wordDefinitionCache.set(alias, wordDef));
        }
        this.cacheValid = false;
    }

    private updateWordInMemoryCache(bookPath: string, nodeId: string, updatedWordDef: WordDefinition): void {
        const bookWords = this.definitions.get(bookPath);
        if (!bookWords) return;
        const existingIndex = bookWords.findIndex(w => w.nodeId === nodeId);
        if (existingIndex >= 0) {
            const oldWordDef = bookWords[existingIndex];
            this.wordDefinitionCache.delete(oldWordDef.word);
            if (oldWordDef.aliases) oldWordDef.aliases.forEach(alias => this.wordDefinitionCache.delete(alias));
            bookWords[existingIndex] = updatedWordDef;
            this.wordDefinitionCache.set(updatedWordDef.word, updatedWordDef);
            if (updatedWordDef.aliases) updatedWordDef.aliases.forEach(alias => this.wordDefinitionCache.set(alias, updatedWordDef));
            this.cacheValid = false;
        }
    }

    private deleteWordFromMemoryCache(bookPath: string, nodeId: string): void {
        const bookWords = this.definitions.get(bookPath);
        if (!bookWords) return;
        const existingIndex = bookWords.findIndex(w => w.nodeId === nodeId);
        if (existingIndex >= 0) {
            const wordDefToDelete = bookWords[existingIndex];
            this.wordDefinitionCache.delete(wordDefToDelete.word);
            if (wordDefToDelete.aliases) wordDefToDelete.aliases.forEach(alias => this.wordDefinitionCache.delete(alias));
            bookWords.splice(existingIndex, 1);
            this.cacheValid = false;
        }
    }

    private scheduleCanvasSync(bookPath: string, wordDef: WordDefinition): void {
        const existingTimeout = this.syncTimeouts.get(bookPath);
        if (existingTimeout) activeWindow.clearTimeout(existingTimeout);
        if (!this.pendingSyncWords.has(bookPath)) this.pendingSyncWords.set(bookPath, []);
        const pendingWords = this.pendingSyncWords.get(bookPath);
        if (!pendingWords) return;
        pendingWords.push(wordDef);
        const timeout = activeWindow.setTimeout(() => {
            void this.syncPendingWords(bookPath).catch(error => {
                console.error('同步待写入词汇失败:', error);
            });
        }, 1000);
        this.syncTimeouts.set(bookPath, timeout);
    }

    private async syncPendingWords(bookPath: string): Promise<void> {
        const pendingWords = this.pendingSyncWords.get(bookPath);
        if (!pendingWords || pendingWords.length === 0) return;
        try {
            for (const wordDef of pendingWords) {
                const generatedNodeId = await this.canvasEditor.addWordToCanvas(
                    bookPath,
                    wordDef.word,
                    wordDef.definition,
                    wordDef.color ? this.getColorNumber(wordDef.color) : undefined,
                    wordDef.aliases
                );
                if (generatedNodeId) wordDef.nodeId = generatedNodeId;
            }
            this.pendingSyncWords.delete(bookPath);
            this.syncTimeouts.delete(bookPath);
        } catch (error) {
            console.error('Failed to sync words to canvas:', error);
        }
    }

    private getColorNumber(colorString: string): number {
        const colorNum = parseInt(colorString, 10);
        return (colorNum >= 1 && colorNum <= 6) ? colorNum : 0;
    }

    private invalidateCache(): void {
        this.cacheValid = false;
        this.wordDefinitionCache.clear();
        this.allWordsCache = [];
        this.bookWordsCache.clear();
        this.studyItemCache.clear();
    }

    private rebuildCache(): void {
        this.wordDefinitionCache.clear();
        this.allWordsCache = [];
        this.bookWordsCache.clear();
        this.studyItemCache.clear();
        const allWords = new Set<string>();
        const mainWords = this.collectMainWords();
        const sourceDefinitions = [
            ...Array.from(this.definitions.values()).flat(),
            ...Array.from(this.memoryOnlyWords.values()).flat(),
        ];
        this.studyItemCache = this.buildStudyItemCache(sourceDefinitions);
        for (const item of this.studyItemCache.values()) {
            const normalizedWord = item.word.toLowerCase().trim();
            if (!normalizedWord) continue;
            this.wordDefinitionCache.set(normalizedWord, item.primary);
            allWords.add(normalizedWord);
            for (const alias of item.aliases) {
                const normalizedAlias = alias.toLowerCase().trim();
                if (!normalizedAlias) continue;
                if (mainWords.has(normalizedAlias) || this.wordDefinitionCache.has(normalizedAlias)) {
                    allWords.add(normalizedAlias);
                    continue;
                }
                this.wordDefinitionCache.set(normalizedAlias, item.primary);
                allWords.add(normalizedAlias);
            }
        }
        for (const [bookPath, definitions] of this.definitions.entries()) {
            const bookWords = new Set<string>();
            for (const def of definitions) {
                const normalizedWord = def.word.toLowerCase().trim();
                if (!normalizedWord) continue;
                bookWords.add(normalizedWord);
            }
            for (const def of definitions) {
                if (def.aliases && def.aliases.length > 0) {
                    for (const alias of def.aliases) {
                        const normalizedAlias = alias.toLowerCase().trim();
                        if (!normalizedAlias) continue;
                        bookWords.add(normalizedAlias);
                    }
                }
            }
            this.bookWordsCache.set(bookPath, [...bookWords]);
        }
        this.allWordsCache = [...allWords];
        this.cacheValid = true;
    }

    private buildStudyItemCache(definitions: WordDefinition[]): Map<string, StudyItem> {
        const items = new Map<string, StudyItem>();
        for (const definition of definitions) {
            const studyKey = definition.studyKey || `${definition.source}:${definition.nodeId}`;
            const existing = items.get(studyKey);
            if (existing) {
                existing.sources.push(definition);
                existing.aliases = this.mergeAliases(existing.aliases, definition.aliases);
                existing.mastered = existing.mastered || definition.mastered === true;
                if (!existing.primary.card && definition.card) {
                    existing.primary = definition;
                    existing.word = definition.word;
                    existing.type = definition.type;
                    existing.language = definition.language;
                }
                continue;
            }
            items.set(studyKey, {
                studyKey,
                word: definition.word,
                type: definition.type,
                language: definition.language,
                aliases: this.mergeAliases([], definition.aliases),
                mastered: definition.mastered === true,
                sources: [definition],
                primary: definition,
            });
        }
        for (const item of items.values()) {
            item.sources.forEach(definition => { definition.mastered = item.mastered; });
            item.primary.mastered = item.mastered;
        }
        return items;
    }

    private mergeAliases(base: string[], aliases?: string[]): string[] {
        const merged = new Set(base.map(alias => alias.toLowerCase().trim()).filter(Boolean));
        aliases?.forEach(alias => {
            const normalized = alias.toLowerCase().trim();
            if (normalized) merged.add(normalized);
        });
        return [...merged];
    }

    private updateCacheForBook(bookPath: string, _definitions: WordDefinition[]): void {
        this.rebuildCache();
    }

    private collectMainWords(): Set<string> {
        const mainWords = new Set<string>();
        for (const definitions of this.definitions.values()) {
            for (const def of definitions) {
                const normalizedWord = def.word.toLowerCase().trim();
                if (normalizedWord) mainWords.add(normalizedWord);
            }
        }
        return mainWords;
    }

    private applyStoredProgress(definitions: WordDefinition[]): void {
        for (const definition of definitions) {
            if (!definition.studyKey) continue;
            const progress = this.settings.studyProgress?.[definition.studyKey];
            if (progress?.status === 'mastered') definition.mastered = true;
        }
    }

    private applyBookColor(book: VocabularyBook, definitions: WordDefinition[]): void {
        if (!book.color) return;
        for (const definition of definitions) {
            if (!definition.color) definition.color = book.color;
            if (definition.card && !definition.card.color) definition.card = { ...definition.card, color: book.color };
        }
    }

    private hasVocabularyBooksChanged(oldBooks: VocabularyBook[], newBooks: VocabularyBook[]): boolean {
        if (oldBooks.length !== newBooks.length) return true;
        for (let i = 0; i < oldBooks.length; i++) {
            const oldBook = oldBooks[i];
            const newBook = newBooks[i];
            if (oldBook.path !== newBook.path || oldBook.enabled !== newBook.enabled ||
                oldBook.name !== newBook.name || oldBook.color !== newBook.color) return true;
        }
        return false;
    }

    destroy(): void {
        this.syncTimeouts.forEach(timeout => activeWindow.clearTimeout(timeout));
        this.syncTimeouts.clear();
        this.definitions.clear();
        this.wordDefinitionCache.clear();
        this.allWordsCache = [];
        this.bookWordsCache.clear();
        this.memoryOnlyWords.clear();
        this.pendingSyncWords.clear();
    }
}

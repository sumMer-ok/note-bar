import { App, Notice, TFile } from 'obsidian';
import type { StudyItem, WordDefinition, VocabularyBook, HiWordsSettings, CanvasData, CanvasNode, WordLifecycle, RetirementCandidate, EncounterData } from '../utils';
import { CanvasParser } from '../canvas/canvas-parser';
import { CanvasEditor } from '../canvas/canvas-editor';
import { HiWordsParser } from '../card';
import { containsNodeId, validateCanvasText } from '../../sync/canvas-integrity';
import {
    appendAuditLine,
    appendLogLine,
    canvasAuditLogPath,
    canvasWriteFailureLogPath,
    resolveVaultBasePath,
    sha1Short12,
    utf8ByteLength,
} from '../../sync/canvas-audit';

/**
 * 写入选项。
 * - `awaitWrite`：等文件**真的含目标节点**才返回成功（收件箱路径必须开，避免「假成功」丢词）。
 *   不开时保持 UI 批量路径的 1 秒防抖，但落盘后仍会做同样的写入回执校验。
 */
export interface CanvasWriteOptions {
    awaitWrite?: boolean;
}

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
    /** 词条确认落盘后的回调（备份服务用它触发快照；由 main.ts 注入） */
    onCanvasWritten?: (bookPath: string) => void;

    constructor(app: App, settings: HiWordsSettings) {
        this.app = app;
        this.canvasParser = new CanvasParser(app, settings);
        this.hiWordsParser = new HiWordsParser(app);
        this.canvasEditor = new CanvasEditor(app, settings);
        this.settings = settings;
    }

    async loadAllVocabularyBooks(): Promise<void> {
        await this.flushAllPendingSyncs();
        this.definitions.clear();
        this.invalidateCache();
        const loadPromises = this.settings.vocabularyBooks
            .filter(book => book.enabled)
            .map(book => this.loadVocabularyBook(book));
        await Promise.all(loadPromises);
        this.rebuildCache();
    }

    async loadVocabularyBook(book: VocabularyBook): Promise<void> {
        await this.flushPendingSyncForBook(book.path);
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
            // retired 词从悬停查词中彻底剔除（与 rebuildCache 的过滤保持一致）
            const foundByMainWord = definitions.find(def => def.word === normalizedWord && def.status !== 'retired');
            if (foundByMainWord) {
                this.wordDefinitionCache.set(normalizedWord, foundByMainWord);
                return foundByMainWord;
            }
            const foundByAlias = definitions.find(def => def.aliases && def.aliases.includes(normalizedWord) && def.status !== 'retired');
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

    getStudyItems(): StudyItem[] {
        if (!this.cacheValid) {
            this.rebuildCache();
        }
        return [...this.studyItemCache.values()];
    }

    /**
     * 提供高亮引擎使用的词条定义。
     * - retired 词从匹配中彻底剔除（不返回）；
     * - archived 词退出高亮（不返回）；
     * - graduated 词退出高亮（不返回），但悬停仍可查（getDefinition 不受此限制）；
     * - active 词正常返回，由高亮引擎按 FSRS stability 渐隐。
     */
    getStudyDefinitionsForHighlight(): WordDefinition[] {
        const progress = this.settings.studyProgress || {};
        return this.getStudyItems()
            .filter(item => {
                const status = progress[item.studyKey]?.lifecycle
                    ?? (progress[item.studyKey]?.status === 'mastered' ? 'graduated' : 'active');
                return status === 'active';
            })
            .map(item => {
                const progressItem = progress[item.studyKey];
                const s = progressItem?.s;
                item.primary.fsrsS =
                    typeof s === 'number' && isFinite(s) && s > 0 ? s : undefined;
                return item.primary;
            });
    }

    getStudyDefinitions(): WordDefinition[] {
        return this.getStudyItems().map(item => item.primary);
    }

    async reloadVocabularyBook(bookPath: string): Promise<void> {
        const book = this.settings.vocabularyBooks.find(b => b.path === bookPath);
        if (book && book.enabled) {
            await this.loadVocabularyBook(book);
            this.invalidateCache();
        }
    }

    removeBookData(bookPath: string): void {
        this.definitions.delete(bookPath);
        this.invalidateCache();
    }

    getSettings(): HiWordsSettings {
        return this.settings;
    }

    async getWordDefinitionByNodeId(bookPath: string, nodeId: string): Promise<WordDefinition | null> {
        const bookWords = this.definitions.get(bookPath);
        if (!bookWords) return null;
        const wordDef = bookWords.find(w => w.nodeId === nodeId);
        return wordDef || null;
    }

    async updateWordDefinition(bookPath: string, nodeId: string, updatedDef: WordDefinition): Promise<boolean> {
        const bookWords = this.definitions.get(bookPath);
        if (!bookWords) return false;

        const index = bookWords.findIndex(w => w.nodeId === nodeId);
        if (index === -1) return false;

        const oldDef = bookWords[index];
        bookWords[index] = updatedDef;

        this.wordDefinitionCache.delete(oldDef.word);
        if (oldDef.aliases) {
            oldDef.aliases.forEach(alias => this.wordDefinitionCache.delete(alias));
        }

        this.wordDefinitionCache.set(updatedDef.word, updatedDef);
        if (updatedDef.aliases) {
            updatedDef.aliases.forEach(alias => this.wordDefinitionCache.set(alias, updatedDef));
        }

        this.cacheValid = false;

        if (!bookPath.endsWith('.hiwords')) {
            try {
                await this.saveWordDefinitionToCanvas(bookPath, nodeId, updatedDef);
            } catch (error) {
                console.error('保存单词定义到 Canvas 失败:', error);
            }
        }

        return true;
    }

    updateStudyKeyMasteredStatus(studyKey: string, mastered: boolean): void {
        for (const definitions of this.definitions.values()) {
            definitions.forEach((definition) => {
                if (definition.studyKey === studyKey) {
                    definition.mastered = mastered;
                }
            });
        }

        for (const definitions of this.memoryOnlyWords.values()) {
            definitions.forEach((definition) => {
                if (definition.studyKey === studyKey) {
                    definition.mastered = mastered;
                }
            });
        }

        this.cacheValid = false;
    }

    /** 更新词条生命周期状态（只叠加，不修改 s/d/due） */
    updateLifecycleStatus(studyKey: string, lifecycle: WordLifecycle): void {
        if (!this.settings.studyProgress) this.settings.studyProgress = {};
        const progress = this.settings.studyProgress[studyKey];
        if (progress) {
            progress.lifecycle = lifecycle;
        } else {
            this.settings.studyProgress[studyKey] = { status: 'new', stage: 0, lifecycle };
        }

        for (const definitions of this.definitions.values()) {
            definitions.forEach((definition) => {
                if (definition.studyKey === studyKey) {
                    definition.status = lifecycle;
                    if (lifecycle === 'graduated') definition.mastered = true;
                }
            });
        }

        for (const definitions of this.memoryOnlyWords.values()) {
            definitions.forEach((definition) => {
                if (definition.studyKey === studyKey) {
                    definition.status = lifecycle;
                    if (lifecycle === 'graduated') definition.mastered = true;
                }
            });
        }

        this.cacheValid = false;
    }

    /** 更新词条常驻标记 */
    updatePinnedStatus(studyKey: string, pinned: boolean): void {
        if (!this.settings.studyProgress) this.settings.studyProgress = {};
        const progress = this.settings.studyProgress[studyKey];
        if (progress) {
            progress.pinned = pinned;
        } else {
            this.settings.studyProgress[studyKey] = { status: 'new', stage: 0, pinned };
        }

        for (const definitions of this.definitions.values()) {
            definitions.forEach((definition) => {
                if (definition.studyKey === studyKey) {
                    definition.pinned = pinned;
                }
            });
        }

        for (const definitions of this.memoryOnlyWords.values()) {
            definitions.forEach((definition) => {
                if (definition.studyKey === studyKey) {
                    definition.pinned = pinned;
                }
            });
        }

        this.cacheValid = false;
    }

    /** 获取词条生命周期状态（从 studyProgress 读取，无记录视为 active） */
    getLifecycleStatus(studyKey: string): WordLifecycle {
        const progress = this.settings.studyProgress?.[studyKey];
        if (progress?.lifecycle) return progress.lifecycle;
        if (progress?.status === 'mastered') return 'graduated';
        return 'active';
    }

    /**
     * 计算淘汰候选列表。
     * 硬条件：非 pinned + active 状态 + 入库 ≥ N 天 + 距上次相遇 ≥ N 天（未相遇用入库日期）。
     * @param encounterData 相遇数据（从 EncounterTracker 获取）
     * @param thresholdDays 天数阈值 N（默认取 settings.retireCandidateDays，再默认 90）
     */
    getRetirementCandidates(
        encounterData: Record<string, EncounterData>,
        thresholdDays?: number
    ): RetirementCandidate[] {
        const N = thresholdDays ?? this.settings.retireCandidateDays ?? 90;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayMs = today.getTime();
        const progress = this.settings.studyProgress || {};
        const candidates: RetirementCandidate[] = [];

        for (const item of this.getStudyItems()) {
            // 仅 Canvas 词库
            if (!item.sources.some(s => s.source.endsWith('.canvas'))) continue;

            const prog = progress[item.studyKey];
            // 仅 active 词可进入候选
            const lifecycle = prog?.lifecycle
                ?? (prog?.status === 'mastered' ? 'graduated' : 'active');
            if (lifecycle !== 'active') continue;
            // pinned 永不进入候选
            if (prog?.pinned || item.primary.pinned) continue;

            const primary = item.primary;
            const addedDate = primary.addedDate;
            if (!addedDate) continue; // 无入库日期的不进入候选

            const addedMs = this.parseDateMs(addedDate);
            if (!addedMs) continue;
            const daysSinceAdded = Math.floor((todayMs - addedMs) / 86400000);
            if (daysSinceAdded < N) continue;

            const encounter = encounterData[item.studyKey] || encounterData[item.word.toLowerCase()];
            const lastEncounter = encounter?.lastEncounter;
            const encounterMs = lastEncounter ? (this.parseDateMs(lastEncounter) ?? addedMs) : addedMs;
            const daysSinceEncounter = Math.floor((todayMs - encounterMs) / 86400000);
            if (daysSinceEncounter < N) continue;

            candidates.push({
                studyKey: item.studyKey,
                word: item.word,
                source: primary.source,
                nodeId: primary.nodeId,
                addedDate,
                lastEncounter,
                hoverCount: encounter?.hoverCount ?? 0,
                encounterCount: encounter?.encounterCount ?? 0,
                daysSinceAdded,
                daysSinceEncounter,
            });
        }

        // 按入库日期升序（最久未碰的排前面）
        candidates.sort((a, b) => (a.addedDate || '').localeCompare(b.addedDate || ''));
        return candidates;
    }

    /** 解析 "YYYY-MM-DD" 为毫秒时间戳（本地时区 00:00） */
    private parseDateMs(s: string): number | null {
        const parts = s.slice(0, 10).split('-').map(Number);
        if (parts.length < 3 || !parts[0]) return null;
        return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1).getTime();
    }

    async getAllWordDefinitions(): Promise<WordDefinition[]> {
        return this.getStudyDefinitions();
    }

    async getWordDefinitionsByBook(bookPath: string): Promise<WordDefinition[]> {
        const bookWords = this.definitions.get(bookPath) || [];
        const memoryWords = this.memoryOnlyWords.get(bookPath) || [];
        return [...bookWords, ...memoryWords];
    }

    async setNodeColor(bookPath: string, nodeId: string, color?: number): Promise<boolean> {
        try {
            const ok = await this.canvasEditor.setNodeColor(bookPath, nodeId, color);
            if (!ok) return false;

            const defs = this.definitions.get(bookPath);
            if (defs) {
                const idx = defs.findIndex(d => d.nodeId === nodeId);
                if (idx >= 0) {
                    const def = defs[idx];
                    def.color = color !== undefined ? this.getColorString(color) : undefined;
                    this.wordDefinitionCache.set(def.word, def);
                    if (def.aliases) {
                        def.aliases.forEach(alias => this.wordDefinitionCache.set(alias, def));
                    }
                    this.cacheValid = false;
                }
            }
            return true;
        } catch (e) {
            console.error('设置节点颜色失败:', e);
            return false;
        }
    }

    private async saveWordDefinitionToCanvas(bookPath: string, _nodeId: string, wordDef: WordDefinition): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(bookPath);
        if (!(file instanceof TFile)) {
            throw new Error(`Canvas 文件不存在: ${bookPath}`);
        }

        try {
            await this.app.vault.process(file, (content) => {
                const canvasData = JSON.parse(content) as CanvasData;
                const node = canvasData.nodes.find((n: CanvasNode) => n.id === wordDef.nodeId);
                if (!node) {
                    throw new Error(`找不到节点 ID: ${wordDef.nodeId}`);
                }

                let textContent = wordDef.word;
                if (wordDef.aliases && wordDef.aliases.length > 0) {
                    textContent += `\n*${wordDef.aliases.join(', ')}*`;
                }
                if (wordDef.definition) {
                    textContent += '\n' + wordDef.definition;
                }
                node.text = textContent;

                return JSON.stringify(canvasData);
            });
        } catch (error) {
            console.error('保存 Canvas 文件失败:', error);
            throw error;
        }
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

    /** 手机进度导入后刷新内存缓存，让 mastered / lifecycle 立即反映到界面 */
    refreshStudyCache(): void {
        this.invalidateCache();
        this.rebuildCache();
    }

    async addWordToCanvas(bookPath: string, word: string, definition: string, color?: number, aliases?: string[], options?: CanvasWriteOptions): Promise<boolean> {
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
            if (options?.awaitWrite) {
                // 收件箱路径：不等落盘就返回成功，等于把「丢词」判成「完成」（2026-09-26 事故直接原因）
                const pending = this.pendingSyncWords.get(bookPath) ?? [];
                pending.push(wordDef);
                this.pendingSyncWords.set(bookPath, pending);
                return await this.syncPendingWords(bookPath);
            }
            this.scheduleCanvasSync(bookPath, wordDef);
            return true;
        } catch (error) {
            console.error('Failed to add word to canvas:', error);
            return false;
        }
    }

    async addWordToMultipleCanvas(bookPaths: string[], word: string, definition: string, color?: number, aliases?: string[], options?: CanvasWriteOptions): Promise<boolean> {
        let allSuccess = true;
        for (const bookPath of bookPaths) {
            const success = await this.addWordToCanvas(bookPath, word, definition, color, aliases, options);
            if (!success) {
                allSuccess = false;
                console.error(`Failed to add word to canvas book: ${bookPath}`);
            }
        }
        return allSuccess;
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

    private clearSyncTimeout(bookPath: string): void {
        const timeout = this.syncTimeouts.get(bookPath);
        if (timeout) activeWindow.clearTimeout(timeout);
        this.syncTimeouts.delete(bookPath);
    }

    /**
     * 写入待同步词汇并做「写入回执」校验：写完重新读该 canvas，确认目标节点真的在里面。
     * 第一次没确认成功会重试一次（只补「连节点 id 都没拿到」的那些；已拿到 id 的只重新读盘确认，
     * 避免重写产生重复节点）；两次都失败则写 canvas-write-failures.log + Notice，并返回 false。
     *
     * @returns 是否全部确认落盘
     */
    private async syncPendingWords(bookPath: string): Promise<boolean> {
        const pendingWords = this.pendingSyncWords.get(bookPath);
        if (!pendingWords || pendingWords.length === 0) return true;
        // 先出队：失败条目已记日志/归档，留在队列里下次会重复写入同一条词
        this.pendingSyncWords.delete(bookPath);
        this.clearSyncTimeout(bookPath);

        const beforeRaw = await this.readCanvasRaw(bookPath);
        let toCreate = pendingWords.slice();
        let toVerify: WordDefinition[] = [];
        let lastMissing: WordDefinition[] = [];

        for (let attempt = 0; attempt < 2 && (toCreate.length > 0 || toVerify.length > 0); attempt++) {
            const outcome = await this.attemptWriteBatch(bookPath, toCreate, toVerify);
            lastMissing = [...outcome.notCreated, ...outcome.missingVerified];
            if (lastMissing.length === 0) break;

            // 重试策略：文件与写前逐字节一致 ⇒ 上一次写入根本没落盘，直接重写（不会产生重复节点）；
            // 文件变了（写入可能已落盘，只是读回时没看到）⇒ 只重新读盘确认，绝不重写，避免重复词条。
            const currentRaw = await this.readCanvasRaw(bookPath);
            if (currentRaw === beforeRaw && attempt === 0) {
                toCreate = lastMissing;
                toVerify = [];
            } else {
                toCreate = [];
                toVerify = lastMissing;
            }
        }

        await this.appendWriteAudit(bookPath, beforeRaw, await this.readCanvasRaw(bookPath));

        if (lastMissing.length > 0) {
            await this.reportWriteFailure(bookPath, lastMissing);
            return false;
        }
        this.onCanvasWritten?.(bookPath);
        return true;
    }

    /** 单次尝试：先写「还没写过的」，再统一读盘校验（新写的 + 上一轮未确认的） */
    private async attemptWriteBatch(
        bookPath: string,
        toCreate: WordDefinition[],
        toVerify: WordDefinition[]
    ): Promise<{ notCreated: WordDefinition[]; missingVerified: WordDefinition[] }> {
        const created: WordDefinition[] = [];
        const notCreated: WordDefinition[] = [];
        for (const wordDef of toCreate) {
            const generatedNodeId = await this.canvasEditor.addWordToCanvas(
                bookPath,
                wordDef.word,
                wordDef.definition,
                wordDef.color ? this.getColorNumber(wordDef.color) : undefined,
                wordDef.aliases
            ).catch(() => null);
            if (generatedNodeId) {
                wordDef.nodeId = generatedNodeId;
                created.push(wordDef);
            } else {
                notCreated.push(wordDef);
            }
        }

        const verifyTargets = [...created, ...toVerify];
        if (verifyTargets.length === 0) return { notCreated, missingVerified: [] };

        const missingIds = await this.findMissingNodeIds(bookPath, verifyTargets.map(wordDef => wordDef.nodeId));
        return {
            notCreated,
            missingVerified: verifyTargets.filter(wordDef => missingIds.has(wordDef.nodeId)),
        };
    }

    /** 读回文件，返回其中确实不存在的节点 id 集合（读不到文件视为全部缺失） */
    private async findMissingNodeIds(bookPath: string, nodeIds: string[]): Promise<Set<string>> {
        const missing = new Set<string>();
        if (nodeIds.length === 0) return missing;
        const raw = await this.readCanvasRaw(bookPath);
        if (raw === null) {
            nodeIds.forEach(nodeId => missing.add(nodeId));
            return missing;
        }
        for (const nodeId of nodeIds) {
            if (!containsNodeId(raw, nodeId)) missing.add(nodeId);
        }
        return missing;
    }

    /**
     * 直接读磁盘原文（用于写入回执校验与审计）。
     * 优先 adapter.read：vault.read/cachedRead 可能命中内存缓存，校验会变成「自证成功」。
     */
    private async readCanvasRaw(bookPath: string): Promise<string | null> {
        try {
            const adapter = this.app.vault.adapter as unknown as { read?: (path: string) => Promise<string> };
            if (adapter && typeof adapter.read === 'function') {
                return await adapter.read(bookPath);
            }
        } catch {
            // 落到 vault.read 兜底
        }
        const file = this.app.vault.getAbstractFileByPath(bookPath);
        if (!(file instanceof TFile)) return null;
        try {
            return await this.app.vault.read(file);
        } catch {
            return null;
        }
    }

    /** 写入失败：日志（可追溯）+ Notice（用户可见），两条缺一不可 */
    private async reportWriteFailure(bookPath: string, words: WordDefinition[]): Promise<void> {
        const wordList = words.map(wordDef => wordDef.word).join(', ');
        console.error(`Note Bar: 词条写入失败（写完未在文件中确认到节点）: ${bookPath} → ${wordList}`);
        const vaultBasePath = resolveVaultBasePath(this.app);
        if (vaultBasePath) {
            await appendLogLine(
                canvasWriteFailureLogPath(vaultBasePath),
                `${new Date().toISOString()} | book=${bookPath} | words=${wordList} | reason=node-missing-after-write`
            );
        }
        new Notice(`词条写入失败，已记录，请检查词库文件：${bookPath}`);
    }

    /** 审计：一次刷盘记一行（写前/写后字节数与 sha1 前 12 位 + 写后是否结构合法） */
    private async appendWriteAudit(bookPath: string, beforeRaw: string | null, afterRaw: string | null): Promise<void> {
        const vaultBasePath = resolveVaultBasePath(this.app);
        if (!vaultBasePath) return;
        await appendAuditLine(canvasAuditLogPath(vaultBasePath), {
            timestamp: new Date(),
            actor: 'plugin',
            book: bookPath,
            bytesBefore: beforeRaw === null ? 0 : utf8ByteLength(beforeRaw),
            bytesAfter: afterRaw === null ? 0 : utf8ByteLength(afterRaw),
            sha1Before: beforeRaw === null ? '-' : sha1Short12(beforeRaw),
            sha1After: afterRaw === null ? '-' : sha1Short12(afterRaw),
            validated: afterRaw !== null && validateCanvasText(afterRaw).ok,
        });
    }

    private async flushAllPendingSyncs(): Promise<void> {
        const pendingPaths = [...this.pendingSyncWords.keys()];
        await Promise.all(pendingPaths.map(path => this.syncPendingWords(path)));
    }

    private async flushPendingSyncForBook(bookPath: string): Promise<boolean> {
        this.clearSyncTimeout(bookPath);
        if (this.pendingSyncWords.has(bookPath)) {
            return await this.syncPendingWords(bookPath);
        }
        return true;
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
        const progress = this.settings.studyProgress || {};
        for (const item of this.studyItemCache.values()) {
            // retired 词从匹配中彻底剔除（不进 cache、不进 allWords）
            const lifecycle = progress[item.studyKey]?.lifecycle;
            if (lifecycle === 'retired') continue;

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
                const defProgress = def.studyKey ? progress[def.studyKey] : undefined;
                if (defProgress?.lifecycle === 'retired') continue;
                const normalizedWord = def.word.toLowerCase().trim();
                if (!normalizedWord) continue;
                bookWords.add(normalizedWord);
            }
            for (const def of definitions) {
                const defProgress = def.studyKey ? progress[def.studyKey] : undefined;
                if (defProgress?.lifecycle === 'retired') continue;
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

    private updateCacheForBook(_bookPath: string, _definitions: WordDefinition[]): void {
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
            // 同步生命周期状态（只叠加，不修改 FSRS 字段）
            if (progress?.lifecycle) {
                definition.status = progress.lifecycle;
            } else if (progress?.status === 'mastered') {
                // 旧数据兼容：已掌握但无 lifecycle 的视为 graduated
                definition.status = 'graduated';
            } else {
                definition.status = 'active';
            }
            if (progress?.pinned) definition.pinned = true;
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

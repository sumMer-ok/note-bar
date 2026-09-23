import { App } from 'obsidian';

export interface DictionaryEntry {
    /** Phonetic transcription */
    p?: string;
    /** Chinese definitions */
    d: string[];
    /** Aliases / word forms */
    a: string[];
}

export interface LegalDictionaryEntry {
    /** Phonetic transcription */
    p?: string;
    /** Part of speech */
    pos?: string;
    /** Year of first recorded use */
    year?: string;
    /** English definitions */
    d_en: string[];
    /** Aliases / word forms */
    a: string[];
    /** See also references */
    seeAlso?: string[];
}

export interface DictionaryLookupResult {
    word: string;
    phonetic?: string;
    definitions: string[];
    aliases: string[];
    /** English legal definitions from Black's Law Dictionary */
    legalDefinitions?: string[];
    /** Part of speech from legal dictionary */
    legalPos?: string;
    /** Year from legal dictionary */
    legalYear?: string;
    /** See also references from legal dictionary */
    legalSeeAlso?: string[];
}

export class LocalDictionaryService {
    private app: App | null = null;
    private cnDictionary: Record<string, DictionaryEntry> | null = null;
    private cnDictPath: string | null = null;
    private cnLoadPromise: Promise<void> | null = null;
    private cnLoadError: Error | null = null;

    private legalDictionary: Record<string, LegalDictionaryEntry> | null = null;
    private legalDictPath: string | null = null;
    private legalLoadPromise: Promise<void> | null = null;
    private legalLoadError: Error | null = null;

    constructor(app?: App) {
        this.app = app ?? null;
    }

    /** 注入或更新 App 实例 */
    setApp(app: App): void {
        this.app = app;
    }

    /** 异步加载中文词典 */
    async loadChineseDictionary(filePath: string): Promise<void> {
        if (!this.app) throw new Error('App not provided');
        if (this.cnDictionary && this.cnDictPath === filePath) return;
        if (this.cnLoadPromise && this.cnDictPath === filePath) return this.cnLoadPromise;
        if (this.cnLoadError) this.cnLoadError = null;

        this.cnDictPath = filePath;
        this.cnLoadPromise = (async () => {
            try {
                const adapter = this.app!.vault.adapter;
                const exists = await adapter.exists(filePath);
                if (!exists) {
                    throw new Error(`中文词典文件不存在: ${filePath}`);
                }
                const content = await adapter.read(filePath);
                this.cnDictionary = JSON.parse(content);
            } catch (error) {
                this.cnLoadError = error instanceof Error ? error : new Error(String(error));
                this.cnDictionary = null;
                throw this.cnLoadError;
            } finally {
                this.cnLoadPromise = null;
            }
        })();
        return this.cnLoadPromise;
    }

    /** 异步加载法律词典 */
    async loadLegalDictionary(filePath: string): Promise<void> {
        if (!this.app) throw new Error('App not provided');
        if (this.legalDictionary && this.legalDictPath === filePath) return;
        if (this.legalLoadPromise && this.legalDictPath === filePath) return this.legalLoadPromise;
        if (this.legalLoadError) this.legalLoadError = null;

        this.legalDictPath = filePath;
        this.legalLoadPromise = (async () => {
            try {
                const adapter = this.app!.vault.adapter;
                const exists = await adapter.exists(filePath);
                if (!exists) {
                    throw new Error(`法律词典文件不存在: ${filePath}`);
                }
                const content = await adapter.read(filePath);
                this.legalDictionary = JSON.parse(content);
            } catch (error) {
                this.legalLoadError = error instanceof Error ? error : new Error(String(error));
                this.legalDictionary = null;
                throw this.legalLoadError;
            } finally {
                this.legalLoadPromise = null;
            }
        })();
        return this.legalLoadPromise;
    }

    /** 确保中文词典已加载（内部使用） */
    private async ensureCnLoaded(): Promise<void> {
        if (this.cnDictionary) return;
        if (!this.app || !this.cnDictPath) return;
        if (this.cnLoadPromise) return this.cnLoadPromise;
        // 如果路径已设置但未加载，触发加载
        await this.loadChineseDictionary(this.cnDictPath);
    }

    /** 确保法律词典已加载（内部使用） */
    private async ensureLegalLoaded(): Promise<void> {
        if (this.legalDictionary) return;
        if (!this.app || !this.legalDictPath) return;
        if (this.legalLoadPromise) return this.legalLoadPromise;
        await this.loadLegalDictionary(this.legalDictPath);
    }

    /** 查中文词典（异步，自动加载） */
    async lookup(word: string): Promise<DictionaryLookupResult | null> {
        await this.ensureCnLoaded();
        return this.lookupSync(word);
    }

    /** 查中文词典（同步，仅在已加载时返回结果） */
    lookupSync(word: string): DictionaryLookupResult | null {
        if (!this.cnDictionary) return null;
        const key = word.trim().toLowerCase();
        if (!key) return null;
        const entry = this.cnDictionary[key];
        if (!entry) return null;
        return {
            word,
            phonetic: entry.p,
            definitions: entry.d || [],
            aliases: entry.a || []
        };
    }

    /** 查法律词典（异步，不自动加载，仅查已加载的词典） */
    async lookupLegal(word: string): Promise<LegalDictionaryEntry | null> {
        if (!this.legalDictionary) return null;
        const key = word.trim().toLowerCase();
        if (!key) return null;
        return this.legalDictionary[key] ?? null;
    }

    /**
     * 查中文 + 法律词典（合并结果）。
     * 这里必须按需自动加载已验证的词典：收件箱（跨应用加词）等非 UI 入口直接调用本方法，
     * 若词典尚未加载就会静默返回 null，表现为「词条进了词库却没有释义和别名」。
     */
    async lookupAll(word: string): Promise<DictionaryLookupResult | null> {
        await this.ensureCnLoaded().catch(() => undefined);
        await this.ensureLegalLoaded().catch(() => undefined);
        const cn = this.lookupSync(word);
        const legal = await this.lookupLegal(word);
        if (!cn && !legal) return null;
        return {
            word,
            phonetic: cn?.phonetic,
            definitions: cn?.definitions ?? [],
            aliases: cn?.aliases ?? [],
            legalDefinitions: legal?.d_en,
            legalPos: legal?.pos,
            legalYear: legal?.year,
            legalSeeAlso: legal?.seeAlso,
        };
    }

    /** 设置中文词典路径（不立即加载） */
    setCnDictionaryPath(path: string): void {
        this.cnDictPath = path;
    }

    /** 设置法律词典路径（不立即加载） */
    setLegalDictionaryPath(path: string): void {
        this.legalDictPath = path;
    }

    isCnDictionaryLoaded(): boolean {
        return this.cnDictionary !== null;
    }

    isLegalDictionaryLoaded(): boolean {
        return this.legalDictionary !== null;
    }

    getCnDictionaryWordCount(): number {
        return this.cnDictionary ? Object.keys(this.cnDictionary).length : 0;
    }

    getLegalDictionaryWordCount(): number {
        return this.legalDictionary ? Object.keys(this.legalDictionary).length : 0;
    }
}

/** 单例：所有模块共享同一个词典服务实例 */
let singletonInstance: LocalDictionaryService | null = null;

export function getLocalDictionaryService(app?: App): LocalDictionaryService {
    if (!singletonInstance) {
        singletonInstance = new LocalDictionaryService(app);
    } else if (app) {
        singletonInstance.setApp(app);
    }
    return singletonInstance;
}

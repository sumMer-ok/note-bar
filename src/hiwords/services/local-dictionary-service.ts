export interface DictionaryEntry {
    /** Phonetic transcription */
    p?: string;
    /** Chinese definitions */
    d: string[];
    /** Aliases / word forms */
    a: string[];
}

export interface DictionaryLookupResult {
    word: string;
    phonetic?: string;
    definitions: string[];
    aliases: string[];
}

let dictionary: Record<string, DictionaryEntry> | null = null;
let loadError: Error | null = null;

function loadDictionary(): Record<string, DictionaryEntry> {
    if (dictionary) return dictionary;
    if (loadError) throw loadError;
    try {
        // The dictionary is bundled at build time so the plugin works on desktop and mobile.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const data = require('../data/dictionary.json') as Record<string, DictionaryEntry>;
        dictionary = data;
        return data;
    } catch (error) {
        loadError = error instanceof Error ? error : new Error(String(error));
        throw loadError;
    }
}

export class LocalDictionaryService {
    lookup(word: string): DictionaryLookupResult | null {
        const dict = loadDictionary();
        const key = word.trim().toLowerCase();
        if (!key) return null;
        const entry = dict[key];
        if (!entry) return null;
        return {
            word,
            phonetic: entry.p,
            definitions: entry.d || [],
            aliases: entry.a || []
        };
    }

    isLoaded(): boolean {
        return dictionary !== null;
    }

    getWordCount(): number {
        return Object.keys(loadDictionary()).length;
    }
}

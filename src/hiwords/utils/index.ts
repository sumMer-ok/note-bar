export * from './types';
export * from './pattern-matcher';
export * from './color-utils';
export * from './sentence-extractor';

export function buildStudyKey(params: { word: string; language?: string; type?: string }): string {
    const parts = [params.word.toLowerCase().trim()];
    if (params.language) parts.push(params.language);
    if (params.type) parts.push(params.type);
    return parts.join(':');
}

export function inferLearningItemType(word: string, _language?: string): 'word' | 'phrase' | 'concept' | 'term' {
    const trimmed = word.trim();
    if (trimmed.includes(' ') || trimmed.includes('-') || trimmed.includes('...')) {
        return 'phrase';
    }
    if (trimmed.length > 20) {
        return 'concept';
    }
    return 'word';
}

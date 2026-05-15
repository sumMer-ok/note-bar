export function parsePhrase(phrase: string): {
    isPattern: boolean;
    parts: string[];
    original: string;
} {
    const trimmed = phrase.trim();
    if (trimmed.includes('...')) {
        const parts = trimmed.split('...').map(p => p.trim()).filter(p => p.length > 0);
        return { isPattern: true, parts, original: trimmed };
    }
    return { isPattern: false, parts: [trimmed], original: trimmed };
}

function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPatternRegex(parts: string[]): RegExp {
    if (parts.length === 0) return /(?!)/;
    if (parts.length === 1) {
        return new RegExp(`\\b${escapeRegExp(parts[0])}\\b`, 'gi');
    }
    const sentenceBoundary = '[^.,!?;:\\n]*?';
    const escapedParts = parts.map(p => escapeRegExp(p));
    const pattern = escapedParts.join(sentenceBoundary);
    return new RegExp(pattern, 'gi');
}

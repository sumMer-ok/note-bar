/**
 * 模式短语匹配工具
 * 支持使用 ... 占位符的跨单词短语匹配
 */

export function parsePhrase(phrase: string): {
    isPattern: boolean;
    parts: string[];
    original: string;
} {
    const trimmed = phrase.trim();

    if (trimmed.includes('...')) {
        const parts = trimmed.split('...').map(p => p.trim()).filter(p => p.length > 0);
        return {
            isPattern: true,
            parts: parts,
            original: trimmed
        };
    }

    return {
        isPattern: false,
        parts: [trimmed],
        original: trimmed
    };
}

function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPatternRegex(parts: string[]): RegExp {
    if (parts.length === 0) return /(?!)/;
    if (parts.length === 1) {
        const escaped = escapeRegExp(parts[0]);
        return new RegExp(`\\b${escaped}\\b`, 'gi');
    }

    const sentenceBoundary = '[^.,!?;:\\n]*?';
    const escapedParts = parts.map(p => escapeRegExp(p));
    const pattern = escapedParts.join(sentenceBoundary);

    return new RegExp(pattern, 'gi');
}

export function findPatternMatches(
    text: string,
    parts: string[],
    offset = 0
): Array<{
    from: number;
    to: number;
    matchedText: string;
    segments: Array<{from: number, to: number}>;
}> {
    const matches: Array<{
        from: number;
        to: number;
        matchedText: string;
        segments: Array<{from: number, to: number}>;
    }> = [];

    if (parts.length === 0) return matches;

    if (parts.length === 1) {
        const regex = new RegExp(`\\b${escapeRegExp(parts[0])}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
            matches.push({
                from: offset + match.index,
                to: offset + match.index + match[0].length,
                matchedText: match[0],
                segments: [{
                    from: offset + match.index,
                    to: offset + match.index + match[0].length
                }]
            });
        }
        return matches;
    }

    const lowerText = text.toLowerCase();
    const lowerParts = parts.map(p => p.toLowerCase());

    let searchStart = 0;
    while (searchStart < text.length) {
        const firstPartIndex = lowerText.indexOf(lowerParts[0], searchStart);
        if (firstPartIndex === -1) break;

        if (!isWordBoundary(text, firstPartIndex, firstPartIndex + parts[0].length)) {
            searchStart = firstPartIndex + 1;
            continue;
        }

        const segments: Array<{from: number, to: number}> = [];
        segments.push({
            from: offset + firstPartIndex,
            to: offset + firstPartIndex + parts[0].length
        });

        let currentPos = firstPartIndex + parts[0].length;
        let allPartsMatched = true;

        for (let i = 1; i < parts.length; i++) {
            const nextBoundary = findNextSentenceBoundary(text, currentPos);
            const searchText = text.substring(currentPos, nextBoundary);
            const lowerSearchText = searchText.toLowerCase();

            const partIndex = lowerSearchText.indexOf(lowerParts[i]);
            if (partIndex === -1) {
                allPartsMatched = false;
                break;
            }

            const absolutePartIndex = currentPos + partIndex;

            if (!isWordBoundary(text, absolutePartIndex, absolutePartIndex + parts[i].length)) {
                allPartsMatched = false;
                break;
            }

            segments.push({
                from: offset + absolutePartIndex,
                to: offset + absolutePartIndex + parts[i].length
            });

            currentPos = absolutePartIndex + parts[i].length;
        }

        if (allPartsMatched) {
            const matchStart = firstPartIndex;
            const matchEnd = currentPos;
            matches.push({
                from: offset + matchStart,
                to: offset + matchEnd,
                matchedText: text.substring(matchStart, matchEnd),
                segments: segments
            });
        }

        searchStart = firstPartIndex + 1;
    }

    return matches;
}

function findNextSentenceBoundary(text: string, startPos: number): number {
    const boundaries = ['.', ',', '!', '?', ';', ':', '\n'];
    let minPos = text.length;

    for (const boundary of boundaries) {
        const pos = text.indexOf(boundary, startPos);
        if (pos !== -1 && pos < minPos) {
            minPos = pos;
        }
    }

    return minPos;
}

function isWordBoundary(text: string, start: number, end: number): boolean {
    const before = start > 0 ? text[start - 1] : ' ';
    const after = end < text.length ? text[end] : ' ';

    const isWordChar = (char: string) => {
        return /[a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/iu.test(char);
    };

    const isCJK = (char: string) => {
        return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
    };

    const startChar = text[start];
    const endChar = text[end - 1];
    const boundaryStart = isCJK(startChar) || !isWordChar(before);
    const boundaryEnd = isCJK(endChar) || !isWordChar(after);

    return boundaryStart && boundaryEnd;
}

/**
 * 前缀树(Trie)数据结构实现
 * 用于高效地匹配多个单词
 */
export class Trie<TPayload = unknown> {
    private root: TrieNode<TPayload>;

    constructor() {
        this.root = new TrieNode<TPayload>();
    }

    addWord(word: string, payload: TPayload): void {
        let node = this.root;
        const lowerWord = word.toLowerCase();

        for (const char of lowerWord) {
            if (!node.children.has(char)) {
                node.children.set(char, new TrieNode<TPayload>());
            }
            const child = node.children.get(char);
            if (!child) return;
            node = child;
        }

        node.isEndOfWord = true;
        node.payload = payload;
        node.word = word;
    }

    findAllMatches(text: string): Array<TrieMatch<TPayload>> {
        const matches: Array<TrieMatch<TPayload>> = [];
        const lowerText = text.toLowerCase();

        for (let i = 0; i < lowerText.length; i++) {
            let node = this.root;
            let j = i;

            while (j < lowerText.length && node.children.has(lowerText[j])) {
                const child = node.children.get(lowerText[j]);
                if (!child) break;
                node = child;
                j++;

                if (node.isEndOfWord) {
                    const matchedStart = lowerText[i];
                    const matchedEnd = lowerText[j - 1];
                    const isWordBoundaryStart = isCJKChar(matchedStart) || i === 0 || !isAlphaNumeric(lowerText[i - 1]);
                    const isWordBoundaryEnd = isCJKChar(matchedEnd) || j === lowerText.length || !isAlphaNumeric(lowerText[j]);

                    if (isWordBoundaryStart && isWordBoundaryEnd) {
                        matches.push({
                            word: node.word || lowerText.substring(i, j),
                            from: i,
                            to: j,
                            payload: node.payload
                        });
                    }
                }
            }
        }

        return matches;
    }

    clear(): void {
        this.root = new TrieNode<TPayload>();
    }
}

class TrieNode<TPayload = unknown> {
    children: Map<string, TrieNode<TPayload>>;
    isEndOfWord: boolean;
    payload: TPayload | null;
    word: string | null;

    constructor() {
        this.children = new Map();
        this.isEndOfWord = false;
        this.payload = null;
        this.word = null;
    }
}

export interface TrieMatch<TPayload = unknown> {
    word: string;
    from: number;
    to: number;
    payload: TPayload | null;
}

function isAlphaNumeric(char: string): boolean {
    return /[a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/iu.test(char);
}

function isCJKChar(char: string): boolean {
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
}

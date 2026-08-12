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
                    // 词边界规则（语言无关）：
                    // - 词首尾是 CJK 字符时（中文词条）不加边界，保证中文词条在任意位置都能匹配；
                    // - 否则仅当相邻字符是 ASCII 字母/数字/下划线时才判定为"非边界"，
                    //   即英文词条只在紧邻英文/数字/下划线时被拒绝（如 knowledge 不匹配 knowledgeable），
                    //   汉字、标点、空格等均视为边界，中英混排（如 "读knowledge"）也能正确匹配。
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

/**
 * 词边界判定用的"词字符"：仅 ASCII 字母/数字/下划线。
 * 刻意排除 CJK/日文假名/韩文等，使这些字符在边界判断中一律视为"非词字符"（即边界），
 * 从而实现"词首尾是 ASCII 时才有 \b 式边界，CJK 不加边界"的语言无关行为。
 */
function isAlphaNumeric(char: string): boolean {
    return /[a-z0-9_]/i.test(char);
}

function isCJKChar(char: string): boolean {
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
}

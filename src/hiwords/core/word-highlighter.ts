import {
    RangeSetBuilder,
    Extension,
    StateField,
    StateEffect
} from '@codemirror/state';
import {
    EditorView,
    Decoration,
    DecorationSet,
    ViewUpdate,
    ViewPlugin,
    PluginSpec,
    PluginValue
} from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { VocabularyManager } from './vocabulary-manager';
import { WordMatch, WordDefinition, mapCanvasColorToCSSVar, Trie } from '../utils';
import { findPatternMatches } from '../utils/pattern-matcher';

const DEBOUNCE_DELAY = 300;

const forceUpdateEffect = StateEffect.define<boolean>();

class HighlighterManager {
    private static instance: HighlighterManager;
    private highlighters: Set<WordHighlighter> = new Set();

    static getInstance(): HighlighterManager {
        if (!HighlighterManager.instance) {
            HighlighterManager.instance = new HighlighterManager();
        }
        return HighlighterManager.instance;
    }

    register(highlighter: WordHighlighter): void {
        this.highlighters.add(highlighter);
    }

    unregister(highlighter: WordHighlighter): void {
        this.highlighters.delete(highlighter);
    }

    refreshAll(): void {
        this.highlighters.forEach(highlighter => {
            try {
                highlighter.forceUpdate();
            } catch (error) {
                console.error('刷新高亮器失败:', error);
            }
        });
    }

    clear(): void {
        this.highlighters.clear();
    }
}

export const highlighterManager = HighlighterManager.getInstance();

const highlightState = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decorations, tr) {
        for (const effect of tr.effects) {
            if (effect.is(forceUpdateEffect)) {
                return Decoration.none;
            }
        }
        return decorations;
    },
    provide: f => EditorView.decorations.from(f)
});

export class WordHighlighter implements PluginValue {
    decorations: DecorationSet;
    private vocabularyManager: VocabularyManager;
    private editorView: EditorView;
    private wordTrie: Trie;
    private patternDefinitions: WordDefinition[] = [];
    private debounceTimer: number | null = null;
    private lastRanges: {from: number, to: number}[] = [];
    private cachedMatches: Map<string, WordMatch[]> = new Map();
    protected shouldHighlightFile?: (filePath: string) => boolean;

    constructor(view: EditorView, vocabularyManager: VocabularyManager, shouldHighlightFile?: (filePath: string) => boolean) {
        this.editorView = view;
        this.vocabularyManager = vocabularyManager;
        this.shouldHighlightFile = shouldHighlightFile;
        this.wordTrie = new Trie();
        this.buildWordTrie();
        this.decorations = this.buildDecorations(view);
        highlighterManager.register(this);
    }

    private buildWordTrie() {
        this.wordTrie.clear();
        this.patternDefinitions = [];

        const definitions = this.vocabularyManager.getStudyDefinitionsForHighlight();

        for (const definition of definitions) {
            if (definition.isPattern) {
                this.patternDefinitions.push(definition);
                continue;
            }

            this.wordTrie.addWord(definition.word, definition);
            if (definition.aliases) {
                definition.aliases.forEach(alias => {
                    if (alias) this.wordTrie.addWord(alias, definition);
                });
            }
        }
    }

    update(update: ViewUpdate) {
        if (update.docChanged) {
            this.cachedMatches.clear();
            this.decorations = this.buildDecorations(update.view);
        } else if (update.viewportChanged || update.focusChanged) {
            this.debouncedUpdate(update.view);
        }
    }

    forceUpdate() {
        this.buildWordTrie();
        this.cachedMatches.clear();
        this.decorations = this.buildDecorations(this.editorView);
        this.editorView.dispatch({
            effects: forceUpdateEffect.of(true)
        });
    }

    private debouncedUpdate(view: EditorView) {
        if (this.debounceTimer) {
            activeWindow.clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = activeWindow.setTimeout(() => {
            this.decorations = this.buildDecorations(view);
            this.debounceTimer = null;
        }, DEBOUNCE_DELAY);
    }

    private buildDecorations(view: EditorView): DecorationSet {
        const settings = this.vocabularyManager.getSettings();
        if (!settings.enableAutoHighlight) {
            return Decoration.none;
        }

        if (this.shouldHighlightFile) {
            const file = view.state.field(editorInfoField);
            if (file?.file?.path && !this.shouldHighlightFile(file.file.path)) {
                return Decoration.none;
            }
        }

        const builder = new RangeSetBuilder<Decoration>();
        const matches: WordMatch[] = [];

        const currentRanges = view.visibleRanges;
        const rangesChanged = this.haveRangesChanged(currentRanges);

        const cacheKey = currentRanges.map(r => `${r.from}-${r.to}`).join(',');
        const cachedMatches = this.cachedMatches.get(cacheKey);
        if (!rangesChanged && cachedMatches) {
            this.applyDecorations(builder, cachedMatches);
            return builder.finish();
        }

        this.lastRanges = currentRanges.map(range => ({from: range.from, to: range.to}));

        for (const { from, to } of view.visibleRanges) {
            const text = view.state.sliceDoc(from, to);
            matches.push(...this.findWordMatches(text, from));
        }

        matches.sort((a, b) => a.from - b.from);
        const filteredMatches = this.removeOverlaps(matches);

        this.cachedMatches.set(cacheKey, filteredMatches);
        this.applyDecorations(builder, filteredMatches);

        return builder.finish();
    }

    private applyDecorations(builder: RangeSetBuilder<Decoration>, matches: WordMatch[]) {
        const highlightStyle = this.vocabularyManager.getSettings().highlightStyle || 'underline';

        matches.forEach(match => {
            const highlightColor = mapCanvasColorToCSSVar(match.definition.color, 'var(--color-base-60)');

            if (match.segments && match.segments.length > 0) {
                match.segments.forEach(segment => {
                    builder.add(
                        segment.from,
                        segment.to,
                        Decoration.mark({
                            class: `hi-words-highlight`,
                            attributes: {
                                'data-word': match.word,
                                'data-definition': match.definition.definition,
                                'data-color': highlightColor,
                                'data-style': highlightStyle,
                                'style': `--word-highlight-color: ${highlightColor};`
                            }
                        })
                    );
                });
            } else {
                builder.add(
                    match.from,
                    match.to,
                    Decoration.mark({
                        class: `hi-words-highlight`,
                        attributes: {
                            'data-word': match.word,
                            'data-definition': match.definition.definition,
                            'data-color': highlightColor,
                            'data-style': highlightStyle,
                            'style': `--word-highlight-color: ${highlightColor};`
                        }
                    })
                );
            }
        });
    }

    private haveRangesChanged(currentRanges: readonly {from: number, to: number}[]): boolean {
        if (this.lastRanges.length !== currentRanges.length) {
            return true;
        }

        for (let i = 0; i < currentRanges.length; i++) {
            if (currentRanges[i].from !== this.lastRanges[i].from ||
                currentRanges[i].to !== this.lastRanges[i].to) {
                return true;
            }
        }

        return false;
    }

    private findWordMatches(text: string, offset: number): WordMatch[] {
        const matches: WordMatch[] = [];

        try {
            const trieMatches = this.wordTrie.findAllMatches(text);

            for (const match of trieMatches) {
                const definition = match.payload as WordDefinition;
                if (definition) {
                    matches.push({
                        word: match.word,
                        definition,
                        from: offset + match.from,
                        to: offset + match.to,
                        color: mapCanvasColorToCSSVar(definition.color, 'var(--color-accent)')
                    });
                }
            }

            for (const definition of this.patternDefinitions) {
                if (definition.patternParts && definition.patternParts.length > 0) {
                    const patternMatches = findPatternMatches(text, definition.patternParts, offset);
                    for (const patternMatch of patternMatches) {
                        matches.push({
                            word: definition.word,
                            definition,
                            from: patternMatch.from,
                            to: patternMatch.to,
                            color: mapCanvasColorToCSSVar(definition.color, 'var(--color-accent)'),
                            matchedText: patternMatch.matchedText,
                            segments: patternMatch.segments
                        });
                    }
                }
            }
        } catch (e) {
            console.error('在 findWordMatches 中发生错误:', e);
        }

        return matches;
    }

    private removeOverlaps(matches: WordMatch[]): WordMatch[] {
        return matches;
    }

    destroy() {
        if (this.debounceTimer) {
            activeWindow.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        this.cachedMatches.clear();
        this.wordTrie.clear();
        highlighterManager.unregister(this);
    }
}

export function createWordHighlighterExtension(
    vocabularyManager: VocabularyManager,
    shouldHighlightFile?: (filePath: string) => boolean
): Extension {
    const pluginSpec: PluginSpec<WordHighlighter> = {
        decorations: (value: WordHighlighter) => value.decorations,
    };

    class WordHighlighterWithManager extends WordHighlighter {
        constructor(view: EditorView) {
            super(view, vocabularyManager, shouldHighlightFile);
        }
    }

    return [
        highlightState,
        ViewPlugin.fromClass(WordHighlighterWithManager, pluginSpec)
    ];
}

export function getWordUnderCursor(view: EditorView): string | null {
    const cursor = view.state.selection.main.head;
    const line = view.state.doc.lineAt(cursor);
    const lineText = line.text;
    const relativePos = cursor - line.from;

    let start = relativePos;
    let end = relativePos;

    const wordRegex = /[a-zA-Z]/;

    while (start > 0 && wordRegex.test(lineText[start - 1])) {
        start--;
    }

    while (end < lineText.length && wordRegex.test(lineText[end])) {
        end++;
    }

    if (start === end) return null;

    return lineText.slice(start, end);
}

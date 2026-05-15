import type { HiWordsSettings, WordDefinition } from './types';
import { Trie } from './trie';
import type { VocabularyManager } from '../core/vocabulary-manager';

export function shouldHighlightFile(filePath: string, settings: HiWordsSettings): boolean {
    const mode = settings.highlightMode || 'all';

    if (mode === 'all') {
        return true;
    }

    const pathsStr = settings.highlightPaths || '';
    const paths = pathsStr
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);

    if (paths.length === 0) {
        return mode === 'exclude';
    }

    const normalizedFile = filePath.replace(/^\/+|\/+$/g, '');

    const isMatched = paths.some(path => {
        const normalizedPath = path.replace(/^\/+|\/+$/g, '');
        return normalizedFile === normalizedPath ||
               normalizedFile.startsWith(normalizedPath + '/');
    });

    if (mode === 'exclude') {
        return !isMatched;
    }

    if (mode === 'include') {
        return isMatched;
    }

    return true;
}

export function isElementVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const windowHeight = window.innerHeight || document.documentElement.clientHeight;
    const windowWidth = window.innerWidth || document.documentElement.clientWidth;

    return (
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < windowHeight &&
        rect.left < windowWidth
    );
}

export function isInMainEditor(element: HTMLElement): boolean {
    return !element.closest('.workspace-leaf-content[data-type="hover-editor"]') &&
           !element.closest('.workspace-leaf-content[data-type="file-explorer"]') &&
           !element.closest('.workspace-leaf-content[data-type="outline"]') &&
           !element.closest('.workspace-leaf-content[data-type="backlink"]') &&
           !element.closest('.workspace-leaf-content[data-type="tag"]') &&
           !element.closest('.workspace-leaf-content[data-type="search"]') &&
           !element.closest('.hover-popover') &&
           !element.closest('.popover') &&
           !element.closest('.suggestion-container') &&
           !element.closest('.modal') &&
           !element.closest('.workspace-split.mod-right-split') &&
           !element.closest('.workspace-split.mod-left-split');
}

export function clearHighlights(element: HTMLElement): void {
    const highlights = element.querySelectorAll('.hi-words-highlight');
    highlights.forEach(highlight => {
        const textNode = document.createTextNode(highlight.textContent || '');
        highlight.parentNode?.replaceChild(textNode, highlight);
    });
    element.normalize();
}

export function buildTrieFromVocabulary(vocabularyManager: VocabularyManager): Trie<WordDefinition> {
    const trie = new Trie<WordDefinition>();
    const definitions = vocabularyManager.getStudyDefinitionsForHighlight();
    for (const def of definitions) {
        trie.addWord(def.word, def);
        def.aliases?.forEach(alias => {
            if (alias) trie.addWord(alias, def);
        });
    }
    return trie;
}

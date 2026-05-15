import type { MarkdownPostProcessorContext } from 'obsidian';
import type { HiWordsSettings, WordDefinition } from '../utils';
import { Trie, mapCanvasColorToCSSVar } from '../utils';
import type { VocabularyManager } from '../core/vocabulary-manager';
import { isElementVisible, buildTrieFromVocabulary, clearHighlights, isInMainEditor } from '../utils/highlight-utils';

export function registerReadingModeHighlighter(plugin: {
  settings: HiWordsSettings;
  vocabularyManager: VocabularyManager;
  shouldHighlightFile: (filePath: string) => boolean;
  registerMarkdownPostProcessor: (
    processor: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void
  ) => void;
  _refreshReadingModeHighlighter?: () => void;
}): void {
  let processorFn: ((el: HTMLElement, trie: Trie<WordDefinition>) => void) | null = null;

  const EXCLUDE_SELECTOR = [
    'pre',
    'code',
    'a',
    'button',
    'input',
    'textarea',
    'select',
    '.math',
    '.cm-inline-code',
    '.internal-embed',
    '.file-embed',
    '.hi-words-tooltip',
  ].join(',');

  const processElement = (root: HTMLElement, trie: Trie<WordDefinition>) => {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node: Node) => {
          const parent = node.parentNode instanceof HTMLElement ? node.parentNode : null;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(EXCLUDE_SELECTOR)) return NodeFilter.FILTER_REJECT;
          if (parent.closest('.hi-words-highlight')) return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const highlightStyle = plugin.settings.highlightStyle || 'underline';

    const textNodes: Text[] = [];
    let current: Node | null = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const text = textNode.nodeValue || '';
      if (!text) continue;

      const matches = trie.findAllMatches(text);
      if (!matches || matches.length === 0) continue;

      matches.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));
      const filtered: typeof matches = [];
      let end = 0;
      for (const m of matches) {
        if (m.from >= end) {
          filtered.push(m);
          end = m.to;
        }
      }
      if (filtered.length === 0) continue;

      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of filtered) {
        if (m.from > last) frag.appendChild(document.createTextNode(text.slice(last, m.from)));
        const def = m.payload;
        const color = mapCanvasColorToCSSVar(def?.color, 'var(--color-base-60)');
        const span = document.createElement('span');
        span.className = 'hi-words-highlight';
        span.setAttribute('data-word', m.word);
        if (def?.definition) span.setAttribute('data-definition', def.definition);
        if (color) span.setAttribute('data-color', color);
        span.setAttribute('data-style', highlightStyle);
        if (color) span.setAttribute('style', `--word-highlight-color: ${color}`);
        span.textContent = text.slice(m.from, m.to);
        frag.appendChild(span);
        last = m.to;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));

      if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
    }
  };

  plugin.registerMarkdownPostProcessor((el, ctx) => {
    try {
      if (!plugin.settings.enableAutoHighlight) return;

      const filePath = ctx.sourcePath;
      if (filePath && !plugin.shouldHighlightFile(filePath)) {
        return;
      }

      if (!isInMainEditor(el)) return;

      const trie = buildTrieFromVocabulary(plugin.vocabularyManager);
      processorFn = processElement;
      processElement(el, trie);
    } catch (e) {
      console.error('阅读模式高亮处理失败:', e);
    }
  });

  plugin._refreshReadingModeHighlighter = () => {
    refreshVisibleReadingMode(plugin, processorFn);
  };
}

function refreshVisibleReadingMode(
  plugin: {
    settings: HiWordsSettings;
    vocabularyManager: VocabularyManager;
    shouldHighlightFile: (filePath: string) => boolean;
  },
  processElement: ((el: HTMLElement, trie: Trie<WordDefinition>) => void) | null
): void {
  if (!plugin.settings.enableAutoHighlight || !processElement) return;

  try {
    const trie = buildTrieFromVocabulary(plugin.vocabularyManager);

    const readingContainers = document.querySelectorAll('.markdown-preview-view .markdown-preview-sizer');

    readingContainers.forEach(container => {
      const htmlContainer = container as HTMLElement;

      if (!isInMainEditor(htmlContainer)) return;
      if (!isElementVisible(htmlContainer)) return;

      clearHighlights(htmlContainer);
      processElement(htmlContainer, trie);
    });
  } catch (error) {
    console.error('刷新阅读模式高亮失败:', error);
  }
}

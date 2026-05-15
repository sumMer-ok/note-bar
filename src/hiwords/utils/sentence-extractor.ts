import type { Editor } from 'obsidian';

export function extractSentence(text: string, position: number): string {
    if (!text || position < 0 || position > text.length) return '';
    const sentenceEnders = /[.!?。！？\n]/;
    let start = position;
    while (start > 0) {
        const char = text[start - 1];
        if (sentenceEnders.test(char)) break;
        start--;
    }
    let end = position;
    while (end < text.length) {
        const char = text[end];
        if (sentenceEnders.test(char)) {
            end++;
            break;
        }
        end++;
    }
    return text.substring(start, end).trim();
}

export function extractSentenceFromEditor(editor: Editor): string {
    try {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        return extractSentence(line, cursor.ch);
    } catch {
        return '';
    }
}

export function extractSentenceFromEditorMultiline(editor: Editor): string {
    try {
        const cursor = editor.getCursor();
        const doc = editor.getValue();
        let position = 0;
        for (let i = 0; i < cursor.line; i++) {
            position += editor.getLine(i).length + 1;
        }
        position += cursor.ch;
        return extractSentence(doc, position);
    } catch {
        return '';
    }
}

export function extractSentenceFromSelection(selection: Selection | null): string {
    if (!selection || selection.rangeCount === 0) return '';
    try {
        const range = selection.getRangeAt(0);
        const selectedText = selection.toString().trim();
        if (!selectedText) return '';
        let startNode = range.startContainer;
        if (startNode.nodeType === Node.ELEMENT_NODE) {
            const textNode = startNode.childNodes[range.startOffset];
            if (textNode && textNode.nodeType === Node.TEXT_NODE) startNode = textNode;
        }
        const container = findParagraphContainer(startNode);
        if (!container) return '';
        const paragraphText = container.textContent || '';
        const pos = calculateTextPosition(container, startNode, range.startOffset, selectedText);
        if (pos === -1) return '';
        const middlePosition = pos + Math.floor(selectedText.length / 2);
        return extractSentence(paragraphText, middlePosition);
    } catch {
        return '';
    }
}

function findParagraphContainer(startNode: Node): HTMLElement | null {
    let current: Node | null = startNode;
    if (current.nodeType === Node.TEXT_NODE) current = current.parentNode;
    let paragraphContainer: HTMLElement | null = null;
    while (current && current.nodeType !== Node.DOCUMENT_NODE) {
        if (current.nodeType === Node.ELEMENT_NODE) {
            const el = current as HTMLElement;
            const tag = el.tagName?.toLowerCase();
            if (tag === 'p' || tag === 'li' || tag === 'blockquote') return el;
            if (tag === 'div') {
                const len = el.textContent?.length || 0;
                if (len > 0 && len < 5000) paragraphContainer = el;
            }
            if (el.classList.contains('textLayer')) return el;
            if (el.classList.contains('page') && el.closest('.pdf-container')) {
                const tl = el.querySelector('.textLayer');
                if (tl) return tl as HTMLElement;
            }
        }
        current = current.parentNode;
    }
    return paragraphContainer;
}

function calculateTextPosition(container: HTMLElement, startNode: Node, startOffset: number, selectedText: string): number {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let offset = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if (node === startNode || node.contains(startNode)) {
            return offset + startOffset;
        }
        offset += node.textContent?.length || 0;
    }
    return (container.textContent || '').indexOf(selectedText);
}

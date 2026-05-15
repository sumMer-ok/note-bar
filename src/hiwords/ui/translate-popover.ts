import { App, MarkdownView, setIcon } from 'obsidian';
import { TranslationService } from '../services/translation-service';
import type { HiWordsSettings } from '../utils';
import { extractSentenceFromEditorMultiline, extractSentenceFromSelection } from '../utils/sentence-extractor';

/**
 * 翻译浮窗组件
 * 点击翻译按钮后弹出翻译结果
 */
export class TranslatePopover {
    private app: App;
    private settings: HiWordsSettings;
    private translationService: TranslationService;
    private activePopover: HTMLElement | null = null;
    private isTranslating = false;
    private onAddToVocabulary: ((word: string, sentence: string, translation: string) => void) | null = null;

    constructor(
        app: App,
        settings: HiWordsSettings,
        onAddToVocabulary?: (word: string, sentence: string, translation: string) => void
    ) {
        this.app = app;
        this.settings = settings;
        this.translationService = new TranslationService(settings);
        if (onAddToVocabulary) this.onAddToVocabulary = onAddToVocabulary;
    }

    updateSettings(settings: HiWordsSettings) {
        this.settings = settings;
        this.translationService.updateSettings(settings);
    }

    /**
     * 显示翻译浮窗
     */
    show(text: string) {
        this.remove();

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        const popover = document.createElement('div');
        popover.className = 'note-bar-translate-popover';

        // 标题栏
        const header = popover.createDiv({ cls: 'note-bar-translate-header' });
        const titleEl = header.createDiv({ cls: 'note-bar-translate-title' });
        titleEl.textContent = text;

        // 操作按钮
        const actionsEl = header.createDiv({ cls: 'note-bar-translate-actions' });

        // 加入词库按钮
        const addBtn = actionsEl.createDiv({ cls: 'note-bar-translate-btn note-bar-translate-btn-add' });
        setIcon(addBtn, 'book-plus');
        addBtn.setAttribute('aria-label', '加入词库');
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const sentence = this.getSentence();
            const translationResult = contentEl.querySelector('.note-bar-translate-result')?.textContent || '';
            this.remove();
            if (this.onAddToVocabulary) {
                this.onAddToVocabulary(text, sentence, translationResult);
            }
        });

        // 复制按钮
        const copyBtn = actionsEl.createDiv({ cls: 'note-bar-translate-btn note-bar-translate-btn-copy' });
        setIcon(copyBtn, 'copy');
        copyBtn.setAttribute('aria-label', '复制翻译');
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const result = contentEl.querySelector('.note-bar-translate-result')?.textContent || '';
            if (result) {
                void navigator.clipboard.writeText(result).catch(() => {});
                setIcon(copyBtn, 'check');
                activeWindow.setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
            }
        });

        // 关闭按钮
        const closeBtn = actionsEl.createDiv({ cls: 'note-bar-translate-btn note-bar-translate-btn-close' });
        setIcon(closeBtn, 'x');
        closeBtn.setAttribute('aria-label', '关闭');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.remove();
        });

        // 内容区域
        const contentEl = popover.createDiv({ cls: 'note-bar-translate-content' });
        const loadingEl = contentEl.createDiv({ cls: 'note-bar-translate-loading' });
        const spinnerEl = loadingEl.createDiv({ cls: 'note-bar-translate-spinner' });
        setIcon(spinnerEl, 'loader');
        loadingEl.createSpan({ text: '翻译中...' });

        // 阻止浮窗内的 mousedown 冒泡
        popover.addEventListener('mousedown', (e) => e.stopPropagation());

        document.body.appendChild(popover);

        // 定位浮窗
        requestAnimationFrame(() => {
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let left = rect.left + scrollLeft;
            let top = rect.bottom + scrollTop + 6;

            const popoverRect = popover.getBoundingClientRect();

            if (left + popoverRect.width > viewportWidth + scrollLeft - 10) {
                left = viewportWidth + scrollLeft - popoverRect.width - 10;
            }
            if (left < scrollLeft + 10) left = scrollLeft + 10;
            if (rect.bottom + popoverRect.height + 10 > viewportHeight) {
                top = rect.top + scrollTop - popoverRect.height - 6;
            }

            popover.style.left = left + 'px';
            popover.style.top = top + 'px';
        });

        this.activePopover = popover;

        // 发起翻译
        void this.doTranslate(text, contentEl);
    }

    /**
     * 获取选中文本所在的句子
     */
    private getSentence(): string {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = activeView?.editor;
        const viewMode = activeView?.getMode();
        if (editor && viewMode === 'source') {
            return extractSentenceFromEditorMultiline(editor);
        }
        return extractSentenceFromSelection(window.getSelection());
    }

    private async doTranslate(text: string, contentEl: HTMLElement) {
        if (this.isTranslating) this.translationService.abort();
        this.isTranslating = true;
        try {
            const result = await this.translationService.translate(text);
            contentEl.empty();
            contentEl.createDiv({ cls: 'note-bar-translate-result', text: result });
        } catch (error) {
            contentEl.empty();
            const errorEl = contentEl.createDiv({ cls: 'note-bar-translate-error' });
            const errorIconEl = errorEl.createDiv({ cls: 'note-bar-translate-error-icon' });
            setIcon(errorIconEl, 'alert-circle');
            errorEl.createSpan({ text: error instanceof Error ? error.message : '翻译失败' });
        } finally {
            this.isTranslating = false;
        }
    }

    remove() {
        if (this.activePopover && this.activePopover.parentNode) {
            this.activePopover.parentNode.removeChild(this.activePopover);
        }
        this.activePopover = null;
    }

    destroy() {
        this.remove();
        this.translationService.abort();
    }
}

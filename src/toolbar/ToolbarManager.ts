import { App, MarkdownView, Notice, Plugin, setIcon } from "obsidian";
import {
  TOOLBAR_CLASS,
  TOOLBAR_VISIBLE_CLASS,
  TOOLBAR_THEME_LIGHT,
  TOOLBAR_THEME_DARK,
} from "../constants";
import { getSelectionPosition, calculateToolbarPosition, shouldHideToolbar, ToolbarPosition } from "../utils/position-calc";
import { createStyleDropdown } from "./components/StyleDropdown";
import { createAlignDropdown } from "./components/AlignDropdown";
import { createFormatButtons } from "./components/FormatButtons";
import { FormattingContext } from "./formatting-context";
import { TranslatePopover } from "../hiwords/ui/translate-popover";
import { AddWordModal } from "../hiwords/ui/add-word-modal";
import { VocabularyManager } from "../hiwords/core/vocabulary-manager";
import { highlighterManager } from "../hiwords/core/word-highlighter";
import type { HiWordsSettings } from "../hiwords/utils/types";
import { extractSentenceFromEditorMultiline, extractSentenceFromSelection } from "../hiwords/utils/sentence-extractor";
import { getHighlightState, detectPreviewHighlight, insertComment, insertCommentToFileSelection } from "../utils/editor-formatter";
import { HIGHLIGHT_COLORS, type HighlightColorKey } from "../constants";

interface ToolbarComponent {
  el: HTMLElement;
  destroy: () => void;
  updateHighlightState?: (isActive: boolean, colorKey?: HighlightColorKey) => void;
}

export class ToolbarManager {
  private toolbarEl: HTMLElement;
  private plugin: Plugin;
  private app: App;
  private isVisible = false;
  private debounceTimer: number | null = null;
  private currentContext: FormattingContext | null = null;
  private onDismiss: () => void;
  private components: ToolbarComponent[] = [];
  private hiwordsSettings: HiWordsSettings;
  private vocabularyManager: VocabularyManager;
  private translatePopover: TranslatePopover;
  private onVocabularyChanged: (() => void) | undefined;

  constructor(
    plugin: Plugin,
    hiwordsSettings: HiWordsSettings,
    vocabularyManager: VocabularyManager,
    onVocabularyChanged?: () => void
  ) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.hiwordsSettings = hiwordsSettings;
    this.vocabularyManager = vocabularyManager;
    this.onVocabularyChanged = onVocabularyChanged;
    this.onDismiss = () => this.hide();
    this.toolbarEl = this.createToolbarElement();
    this.translatePopover = new TranslatePopover(
      this.app,
      hiwordsSettings,
      (word, sentence, translation) => {
        // 从翻译结果点击"加入词库"后的回调
        new AddWordModal(
          this.app,
          this.hiwordsSettings,
          this.vocabularyManager,
          word,
          sentence,
          false,
          translation,
          undefined,
          () => {
            void this.vocabularyManager.loadAllVocabularyBooks();
            this.onVocabularyChanged?.();
          }
        ).open();
      }
    );
  }

  private createToolbarElement(): HTMLElement {
    const el = document.createElement("div");
    el.className = `${TOOLBAR_CLASS} ${TOOLBAR_THEME_LIGHT}`;
    el.style.pointerEvents = "none";

    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener("click", (e) => e.stopPropagation());

    const getContext = () => this.currentContext;
    const styleDropdown = createStyleDropdown(this.app, getContext, this.onDismiss);
    const alignDropdown = createAlignDropdown(this.app, getContext, this.onDismiss);
    const formatButtons = createFormatButtons(this.app, getContext, this.onDismiss);

    this.components.push(styleDropdown, alignDropdown, formatButtons);

    const divider = (): HTMLElement => {
      const d = document.createElement("div");
      d.className = "note-bar-divider";
      return d;
    };

    el.appendChild(styleDropdown.el);
    el.appendChild(divider());
    el.appendChild(alignDropdown.el);
    el.appendChild(divider());
    el.appendChild(formatButtons.el);

    // 添加 HiWords 功能按钮分隔线
    el.appendChild(divider());

    // 翻译按钮
    const translateBtn = document.createElement("button");
    translateBtn.className = "note-bar-format-btn note-bar-hiwords-btn";
    translateBtn.textContent = "翻译";
    translateBtn.style.fontSize = "12px";
    translateBtn.style.fontWeight = "500";
    translateBtn.style.padding = "4px 10px";
    translateBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleTranslate();
    });
    el.appendChild(translateBtn);

    // 加入词库按钮
    const addWordBtn = document.createElement("button");
    addWordBtn.className = "note-bar-format-btn note-bar-hiwords-btn";
    addWordBtn.textContent = "加入词库";
    addWordBtn.style.fontSize = "12px";
    addWordBtn.style.fontWeight = "500";
    addWordBtn.style.padding = "4px 10px";
    addWordBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleAddWord();
    });
    el.appendChild(addWordBtn);

    // 增加注释按钮
    const commentBtn = document.createElement("button");
    commentBtn.className = "note-bar-format-btn note-bar-hiwords-btn";
    commentBtn.textContent = "注释";
    commentBtn.style.fontSize = "12px";
    commentBtn.style.fontWeight = "500";
    commentBtn.style.padding = "4px 10px";
    commentBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const context = getContext();
        if (context?.mode === "source") {
          context.editor.focus();
          insertComment(context.editor);
        } else if (context?.mode === "preview") {
          void insertCommentToFileSelection(this.app, context.file, context.selection);
        }
      } catch (err) {
        console.error("Note Bar: failed to insert comment", err);
      }
      this.onDismiss();
    });
    el.appendChild(commentBtn);

    // 终端按钮（最右侧，视觉突出）
    el.appendChild(divider());
    const terminalBtn = document.createElement("button");
    terminalBtn.className = "note-bar-format-btn note-bar-terminal-btn";
    terminalBtn.textContent = "终端";
    terminalBtn.style.fontSize = "12px";
    terminalBtn.style.fontWeight = "600";
    terminalBtn.style.padding = "4px 10px";
    terminalBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleTerminal();
    });
    el.appendChild(terminalBtn);

    document.body.appendChild(el);
    return el;
  }

  /**
   * 处理翻译按钮点击
   */
  private handleTranslate() {
    const selectedText = this.getSelectedText();
    if (!selectedText) return;
    // 先隐藏 toolbar，避免遮挡
    this.hide();
    this.translatePopover.show(selectedText);
  }

  /**
   * 处理加入词库按钮点击
   */
  private handleAddWord() {
    const selectedText = this.getSelectedText();
    if (!selectedText) return;
    const sentence = this.getSentence();
    this.hide();
    new AddWordModal(
      this.app,
      this.hiwordsSettings,
      this.vocabularyManager,
      selectedText,
      sentence,
      false,
      "",
      undefined,
      () => {
        void this.vocabularyManager.loadAllVocabularyBooks();
        this.onVocabularyChanged?.();
      }
    ).open();
  }

  /**
   * 处理终端按钮点击：将选中文本与文件路径组合后发送到终端输入
   */
  private async handleTerminal() {
    const selectedText = this.getSelectedText();
    if (!selectedText) return;

    const activeFile = this.app.workspace.getActiveFile();
    const filePath = activeFile?.path ?? "未命名文件";
    const terminalInput = `${filePath}: ${selectedText}`;

    try {
      await navigator.clipboard.writeText(terminalInput);
      new Notice(`已发送到终端: ${terminalInput.substring(0, 40)}${terminalInput.length > 40 ? "..." : ""}`, 3000);
    } catch (err) {
      console.error("Note Bar: 复制到剪贴板失败", err);
      new Notice("发送到终端失败，请重试", 2000);
    }

    this.hide();
  }

  /**
   * 获取当前选中的文本
   */
  private getSelectedText(): string {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = activeView?.editor;
    const viewMode = activeView?.getMode();

    if (editor && viewMode === "source") {
      return editor.getSelection().trim();
    }

    const selection = window.getSelection();
    return selection?.toString().trim() || "";
  }

  /**
   * 获取选中文本所在的句子
   */
  private getSentence(): string {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = activeView?.editor;
    const viewMode = activeView?.getMode();

    if (editor && viewMode === "source") {
      return extractSentenceFromEditorMultiline(editor);
    }

    return extractSentenceFromSelection(window.getSelection());
  }

  /**
   * 更新 HiWords 设置
   */
  updateHiWordsSettings(settings: HiWordsSettings) {
    this.hiwordsSettings = settings;
    this.translatePopover.updateSettings(settings);
    this.vocabularyManager.updateSettings(settings);
  }

  /**
   * 响应选区变化
   */
  onSelectionChange(context: FormattingContext | null): void {
    this.currentContext = context;

    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.updateToolbar(context);
    }, 50);
  }

  private updateToolbar(context: FormattingContext | null): void {
    const shouldHide = shouldHideToolbar(context);

    if (shouldHide) {
      this.hide();
      return;
    }

    const selectionPos = getSelectionPosition(context);
    if (!selectionPos) {
      this.hide();
      return;
    }

    this.updateTheme();
    this.detectAndUpdateHighlightState(context);
    this.show(selectionPos);
  }

  /**
   * 检测当前选区的高亮状态并更新按钮视觉反馈
   */
  private detectAndUpdateHighlightState(context: FormattingContext | null): void {
    let isActive = false;
    let colorKey: HighlightColorKey | undefined;

    if (context?.mode === "source") {
      const selection = context.editor.getSelection();
      if (selection) {
        const state = getHighlightState(selection);
        isActive = state.isHighlighted;
        if (state.color) {
          const entry = Object.entries(HIGHLIGHT_COLORS).find(([_, c]) => c.value === state.color);
          if (entry) colorKey = entry[0] as HighlightColorKey;
        }
      }
    } else if (context?.mode === "preview") {
      const state = detectPreviewHighlight();
      isActive = state.isHighlighted;
      if (state.color) {
        colorKey = state.color as HighlightColorKey;
      }
    }

    const formatButtons = this.components.find((c) => c.updateHighlightState);
    if (formatButtons) {
      formatButtons.updateHighlightState!(isActive, colorKey);
    }
  }

  private show(selectionPos: ToolbarPosition): void {
    if (!this.isVisible) {
      this.toolbarEl.classList.add(TOOLBAR_VISIBLE_CLASS);
      this.isVisible = true;
    }

    // 使用 getBoundingClientRect() 强制回流，获取准确尺寸
    const rect = this.toolbarEl.getBoundingClientRect();
    const toolbarWidth = rect.width || 200;
    const toolbarHeight = rect.height || 40;

    const pos = calculateToolbarPosition(selectionPos, toolbarWidth, toolbarHeight);

    this.toolbarEl.style.left = `${pos.left}px`;
    this.toolbarEl.style.top = `${pos.top}px`;
    this.toolbarEl.style.pointerEvents = "auto";
  }

  private hide(): void {
    if (!this.isVisible) return;

    this.toolbarEl.classList.remove(TOOLBAR_VISIBLE_CLASS);
    this.toolbarEl.style.pointerEvents = "none";
    this.isVisible = false;
    this.currentContext = null;
    this.translatePopover.remove();
  }

  private updateTheme(): void {
    const isDark = document.body.classList.contains("theme-dark");
    this.toolbarEl.classList.toggle(TOOLBAR_THEME_LIGHT, !isDark);
    this.toolbarEl.classList.toggle(TOOLBAR_THEME_DARK, isDark);
  }

  /**
   * 全局点击处理：点击空白区域时消失
   */
  onGlobalClick(e: MouseEvent): void {
    if (!this.isVisible) return;

    const target = e.target as HTMLElement;
    if (!this.toolbarEl.contains(target)) {
      // 不关闭已打开的下拉面板或颜色选择器
      if (target.closest(".note-bar-dropdown-panel")) return;
      if (target.closest(".note-bar-submenu")) return;
      if (target.closest(".note-bar-color-picker")) return;
      // 不关闭翻译浮窗
      if (target.closest(".note-bar-translate-popover")) return;
      this.hide();
    }
  }

  /**
   * ESC 键处理：按下 Esc 时消失
   */
  onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape" && this.isVisible) {
      this.hide();
    }
  }

  /**
   * 清理资源
   */
  destroy(): void {
    this.hide();
    this.translatePopover.destroy();
    this.components.forEach((component) => component.destroy());
    this.components = [];
    this.toolbarEl.remove();
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

import { App } from "obsidian";
import {
  applyInlineFormat,
  applyInlineFormatToFileSelection,
  applyHighlight,
  applyHighlightToFileSelection,
  FormatType,
} from "../../utils/editor-formatter";
import { createHighlightPicker } from "./HighlightPicker";
import { DEFAULT_HIGHLIGHT_COLOR, HighlightColorKey, HIGHLIGHT_COLORS } from "../../constants";
import { FormattingContextProvider } from "../formatting-context";

export interface ToolbarComponent {
  el: HTMLElement;
  destroy: () => void;
  updateHighlightState?: (isActive: boolean, colorKey?: HighlightColorKey) => void;
}

export function createFormatButtons(
  app: App,
  getContext: FormattingContextProvider,
  onAction: () => void
): ToolbarComponent {
  const container = document.createElement("div");
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.gap = "2px";

  let currentHighlightColor: HighlightColorKey = DEFAULT_HIGHLIGHT_COLOR;
  let destroyHighlightPicker: (() => void) | null = null;
  let isHighlightActive = false;

  const buttons: { label: string; type: FormatType; html?: string }[] = [
    { label: "B", type: "bold", html: "<strong>B</strong>" },
    { label: "S", type: "strikethrough", html: "<span style='text-decoration:line-through'>S</span>" },
    { label: "I", type: "italic", html: "<em>I</em>" },
    { label: "U", type: "underline", html: "<span style='text-decoration:underline'>U</span>" },
    { label: "🔗", type: "link" },
  ];

  buttons.forEach((btn) => {
    const el = document.createElement("button");
    el.className = "note-bar-format-btn";
    el.innerHTML = btn.html || btn.label;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const context = getContext();
        if (context?.mode === "source") {
          context.editor.focus();
          applyInlineFormat(context.editor, btn.type);
        } else if (context?.mode === "preview") {
          void applyInlineFormatToFileSelection(app, context.file, context.selection, btn.type);
        }
      } catch (err) {
        console.error("Note Bar: failed to apply inline format", err);
      }
      onAction();
    });
    container.appendChild(el);
  });

  // 高亮按钮组（带颜色选择器）
  const highlightGroup = document.createElement("div");
  highlightGroup.className = "note-bar-highlight-group";

  const highlightMain = document.createElement("button");
  highlightMain.className = "note-bar-format-btn note-bar-highlight-btn--main";
  highlightMain.innerHTML = `
    <span>A</span>
    <span class="note-bar-highlight-color-indicator" style="background:${HIGHLIGHT_COLORS[currentHighlightColor].value}"></span>
  `;

  const updateHighlightVisual = (active: boolean, colorKey?: HighlightColorKey) => {
    isHighlightActive = active;
    if (colorKey) {
      currentHighlightColor = colorKey;
    }
    highlightMain.classList.toggle("note-bar-format-btn--active", active);
    const indicator = highlightMain.querySelector(".note-bar-highlight-color-indicator") as HTMLElement;
    if (indicator) {
      indicator.style.background = HIGHLIGHT_COLORS[currentHighlightColor].value;
    }
  };

  highlightMain.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const context = getContext();
      if (context?.mode === "source") {
        context.editor.focus();
        applyHighlight(context.editor, currentHighlightColor);
      } else if (context?.mode === "preview") {
        void applyHighlightToFileSelection(app, context.file, context.selection, currentHighlightColor);
      }
    } catch (err) {
      console.error("Note Bar: failed to apply highlight", err);
    }
    onAction();
  });

  const highlightArrow = document.createElement("button");
  highlightArrow.className = "note-bar-format-btn note-bar-highlight-btn--arrow";
  highlightArrow.textContent = "▾";
  highlightArrow.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    destroyHighlightPicker?.();
    destroyHighlightPicker = createHighlightPicker(highlightArrow, app, getContext, (colorKey) => {
      currentHighlightColor = colorKey;
      const indicator = highlightMain.querySelector(".note-bar-highlight-color-indicator") as HTMLElement;
      if (indicator) {
        indicator.style.background = HIGHLIGHT_COLORS[colorKey].value;
      }
    });
  });

  highlightGroup.appendChild(highlightMain);
  highlightGroup.appendChild(highlightArrow);
  container.appendChild(highlightGroup);

  const destroy = () => {
    destroyHighlightPicker?.();
    destroyHighlightPicker = null;
    document.querySelectorAll(".note-bar-color-picker").forEach((el) => el.remove());
  };

  return {
    el: container,
    destroy,
    updateHighlightState: (isActive, colorKey) => {
      updateHighlightVisual(isActive, colorKey);
    },
  };
}

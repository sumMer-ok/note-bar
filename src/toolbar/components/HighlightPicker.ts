import { App } from "obsidian";
import { HIGHLIGHT_COLORS, HighlightColorKey } from "../../constants";
import { applyHighlight, applyHighlightToFileSelection, getHighlightState, detectPreviewHighlight } from "../../utils/editor-formatter";
import { FormattingContextProvider } from "../formatting-context";

export function createHighlightPicker(
  anchor: HTMLElement,
  app: App,
  getContext: FormattingContextProvider,
  onColorChange: (key: HighlightColorKey) => void
): () => void {
  // 移除已有的颜色选择器
  document.querySelectorAll(".note-bar-color-picker").forEach((el) => el.remove());

  const picker = document.createElement("div");
  picker.className = "note-bar-color-picker";

  // 根据父工具栏确定主题
  const toolbar = anchor.closest(".note-bar-toolbar");
  if (toolbar) {
    picker.classList.add(...Array.from(toolbar.classList).filter((c) =>
      c.startsWith("note-bar-toolbar--")
    ));
  }

  const label = document.createElement("div");
  label.className = "note-bar-color-picker-label";
  label.textContent = "高亮颜色";
  picker.appendChild(label);

  const grid = document.createElement("div");
  grid.className = "note-bar-color-grid";

  const entries = Object.entries(HIGHLIGHT_COLORS) as [HighlightColorKey, typeof HIGHLIGHT_COLORS[HighlightColorKey]][];

  // 检测当前选区的高亮状态，用于预选颜色
  let selectedKey: HighlightColorKey | null = null;
  const context = getContext();
  if (context?.mode === "source") {
    const selection = context.editor.getSelection();
    if (selection) {
      const state = getHighlightState(selection);
      if (state.isHighlighted && state.color) {
        const entry = Object.entries(HIGHLIGHT_COLORS).find(([_, c]) => c.value === state.color);
        if (entry) selectedKey = entry[0] as HighlightColorKey;
      }
    }
  } else if (context?.mode === "preview") {
    const state = detectPreviewHighlight();
    if (state.isHighlighted && state.color) {
      selectedKey = state.color as HighlightColorKey;
    }
  }

  entries.forEach(([key, color]) => {
    const swatch = document.createElement("div");
    swatch.className = "note-bar-color-swatch";
    swatch.style.background = color.value;
    swatch.title = color.name;

    // 如果当前选区已被该颜色高亮，标记为选中状态
    if (selectedKey === key) {
      swatch.classList.add("note-bar-color-swatch--selected");
    }

    swatch.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const isAlreadySelected = swatch.classList.contains("note-bar-color-swatch--selected");

      if (isAlreadySelected) {
        // 二次点击已选中的颜色：取消高亮
        const currentContext = getContext();
        if (currentContext?.mode === "source") {
          currentContext.editor.focus();
          applyHighlight(currentContext.editor, key);
        } else if (currentContext?.mode === "preview") {
          void applyHighlightToFileSelection(app, currentContext.file, currentContext.selection, key);
        }
        onColorChange(key);
      } else {
        // 更新选中状态
        grid.querySelectorAll(".note-bar-color-swatch").forEach((s) => {
          s.classList.remove("note-bar-color-swatch--selected");
        });
        swatch.classList.add("note-bar-color-swatch--selected");

        // 应用高亮
        const currentContext = getContext();
        if (currentContext?.mode === "source") {
          currentContext.editor.focus();
          applyHighlight(currentContext.editor, key);
        } else if (currentContext?.mode === "preview") {
          void applyHighlightToFileSelection(app, currentContext.file, currentContext.selection, key);
        }

        onColorChange(key);
      }

      // 关闭选择器
      picker.classList.remove("note-bar-color-picker--open");
      window.setTimeout(() => picker.remove(), 120);
      document.removeEventListener("mousedown", onDocClick);
    });

    grid.appendChild(swatch);
  });

  picker.appendChild(grid);

  // 定位
  const rect = anchor.getBoundingClientRect();
  picker.style.left = `${rect.left}px`;
  picker.style.top = `${rect.bottom + 4}px`;
  document.body.appendChild(picker);

  // 动画
  requestAnimationFrame(() => {
    picker.classList.add("note-bar-color-picker--open");
  });

  // 点击外部关闭
  const onDocClick = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node) && e.target !== anchor) {
      picker.classList.remove("note-bar-color-picker--open");
      window.setTimeout(() => picker.remove(), 120);
      document.removeEventListener("mousedown", onDocClick);
    }
  };
  const listenerTimer = window.setTimeout(() => document.addEventListener("mousedown", onDocClick), 0);

  return () => {
    window.clearTimeout(listenerTimer);
    document.removeEventListener("mousedown", onDocClick);
    picker.remove();
  };
}

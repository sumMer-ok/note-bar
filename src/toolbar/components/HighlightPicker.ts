import { App } from "obsidian";
import { HIGHLIGHT_COLORS, HighlightColorKey } from "../../constants";
import { applyHighlight, applyHighlightToFileSelection } from "../../utils/editor-formatter";
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

  entries.forEach(([key, color]) => {
    const swatch = document.createElement("div");
    swatch.className = "note-bar-color-swatch";
    swatch.style.background = color.value;
    swatch.title = color.name;

    swatch.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      // 更新选中状态
      grid.querySelectorAll(".note-bar-color-swatch").forEach((s) => {
        s.classList.remove("note-bar-color-swatch--selected");
      });
      swatch.classList.add("note-bar-color-swatch--selected");

      // 应用高亮
      const context = getContext();
      if (context?.mode === "source") {
        context.editor.focus();
        applyHighlight(context.editor, key);
      } else if (context?.mode === "preview") {
        void applyHighlightToFileSelection(app, context.file, context.selection, key);
      }

      onColorChange(key);

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

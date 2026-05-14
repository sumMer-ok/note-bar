import { FormattingContext } from "../toolbar/formatting-context";

export interface ToolbarPosition {
  top: number;
  left: number;
}

/**
 * 获取编辑器选区在视口中的位置（像素坐标）
 * 使用浏览器 Selection API 获取当前编辑器选区的 DOM 坐标。
 */
export function getSelectionPosition(context: FormattingContext | null): ToolbarPosition | null {
  if (!context) return null;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (!isObsidianEditorSelection(selection)) return null;

  try {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    return {
      top: rect.top,
      left: rect.left + rect.width / 2,
    };
  } catch (_) {
    return null;
  }
}

/**
 * 计算工具栏的最终位置，确保不超出视口边界
 */
export function calculateToolbarPosition(
  selectionPos: ToolbarPosition,
  toolbarWidth: number,
  toolbarHeight: number,
  gap: number = 8
): ToolbarPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = selectionPos.left - toolbarWidth / 2;
  let top = selectionPos.top - toolbarHeight - gap;

  if (left < 12) left = 12;
  if (left + toolbarWidth + 12 > viewportWidth) {
    left = viewportWidth - toolbarWidth - 12;
  }

  if (top < 12) {
    top = selectionPos.top + gap;
  }

  if (top + toolbarHeight + 12 > viewportHeight) {
    top = viewportHeight - toolbarHeight - 12;
  }

  return { top, left };
}

/**
 * 检查工具栏是否应该隐藏（选区消失或折叠）
 * 以 Obsidian Editor API 为准，避免依赖 CodeMirror 私有字段。
 */
export function shouldHideToolbar(context: FormattingContext | null): boolean {
  if (!context) return true;

  if (context.mode === "preview") {
    const selection = window.getSelection();
    return !selection || selection.isCollapsed || selection.toString().trim().length === 0;
  }

  try {
    return context.editor.getSelection().trim().length === 0;
  } catch (_) {
    return true;
  }
}

function isObsidianEditorSelection(selection: Selection): boolean {
  const anchorNode = selection.anchorNode;
  if (!anchorNode) return false;

  const anchorEl = anchorNode instanceof HTMLElement
    ? anchorNode
    : anchorNode.parentElement;

  return Boolean(anchorEl?.closest(".markdown-source-view, .markdown-preview-view, .cm-editor"));
}

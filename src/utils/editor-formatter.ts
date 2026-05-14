import { App, Editor, TFile } from "obsidian";
import { HighlightColorKey, HIGHLIGHT_COLORS } from "../constants";

export type TextStyle =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "ordered-list"
  | "unordered-list"
  | "task"
  | "code-block"
  | "blockquote"
  | "callout";

export type AlignIndent = "align-left" | "align-center" | "align-right" | "indent-increase" | "indent-decrease";

export type FormatType = "bold" | "strikethrough" | "italic" | "underline" | "link";

/**
 * 应用文本样式（标题、列表、引用等）
 */
export function applyTextStyle(editor: Editor, style: TextStyle): void {
  const range = getSelectedLineRange(editor);
  const lines = getLines(editor, range.fromLine, range.toLine);

  if (style === "code-block") {
    replaceLines(editor, range.fromLine, range.toLine, `\`\`\`\n${lines.join("\n")}\n\`\`\``);
    return;
  }

  if (style === "callout") {
    const calloutLines = lines.map((line, index) => {
      const content = stripPrefix(line);
      return index === 0 ? `> [!note]\n> ${content}` : `> ${content}`;
    });
    replaceLines(editor, range.fromLine, range.toLine, calloutLines.join("\n"));
    return;
  }

  const transformed = lines.map((line, index) => {
    if (line.trim().length === 0) return line;
    const content = stripPrefix(line);

    switch (style) {
      case "paragraph":
        return content;
      case "heading1":
        return `# ${content}`;
      case "heading2":
        return `## ${content}`;
      case "heading3":
        return `### ${content}`;
      case "heading4":
        return `#### ${content}`;
      case "heading5":
        return `##### ${content}`;
      case "heading6":
        return `###### ${content}`;
      case "ordered-list":
        return `${index + 1}. ${content}`;
      case "unordered-list":
        return `- ${content}`;
      case "task":
        return `- [ ] ${content}`;
      case "blockquote":
        return `> ${content}`;
    }
  });

  replaceLines(editor, range.fromLine, range.toLine, transformed.join("\n"));
}

export async function applyTextStyleToFileSelection(
  app: App,
  file: TFile,
  selection: string,
  style: TextStyle
): Promise<void> {
  const content = await app.vault.read(file);
  const selectedRange = findSelectionRange(content, selection);
  if (!selectedRange) return;

  const fromLine = getLineAtOffset(content, selectedRange.from);
  const toLine = getLineAtOffset(content, Math.max(selectedRange.to - 1, selectedRange.from));
  const lineRanges = getLineRanges(content);
  const fromOffset = lineRanges[fromLine].from;
  const toOffset = lineRanges[toLine].to;
  const lines = content.slice(fromOffset, toOffset).split("\n");
  const replacement = transformLines(lines, style);

  await app.vault.modify(file, content.slice(0, fromOffset) + replacement + content.slice(toOffset));
}

/**
 * 应用对齐与缩进
 */
export function applyAlignIndent(editor: Editor, action: AlignIndent): void {
  const range = getSelectedLineRange(editor);
  const lines = getLines(editor, range.fromLine, range.toLine);

  const transformed = lines.map((line) => {
    const cleanLine = stripAlignment(line);

    switch (action) {
      case "align-left":
        return cleanLine;
      case "align-center":
        return `<div align="center">${cleanLine}</div>`;
      case "align-right":
        return `<div align="right">${cleanLine}</div>`;
      case "indent-increase":
        return `\t${line}`;
      case "indent-decrease":
        return decreaseIndent(line);
    }
  });

  replaceLines(editor, range.fromLine, range.toLine, transformed.join("\n"));
}

export async function applyAlignIndentToFileSelection(
  app: App,
  file: TFile,
  selection: string,
  action: AlignIndent
): Promise<void> {
  const content = await app.vault.read(file);
  const selectedRange = findSelectionRange(content, selection);
  if (!selectedRange) return;

  const fromLine = getLineAtOffset(content, selectedRange.from);
  const toLine = getLineAtOffset(content, Math.max(selectedRange.to - 1, selectedRange.from));
  const lineRanges = getLineRanges(content);
  const fromOffset = lineRanges[fromLine].from;
  const toOffset = lineRanges[toLine].to;
  const lines = content.slice(fromOffset, toOffset).split("\n");
  const replacement = transformAlignLines(lines, action);

  await app.vault.modify(file, content.slice(0, fromOffset) + replacement + content.slice(toOffset));
}

/**
 * 应用内联格式（加粗/斜体等）
 */
export function applyInlineFormat(editor: Editor, type: FormatType): void {
  const selection = editor.getSelection();
  if (!selection) return;

  switch (type) {
    case "bold":
      editor.replaceSelection(toggleWrapper(selection, "**", "**"));
      return;
    case "italic":
      editor.replaceSelection(toggleWrapper(selection, "*", "*"));
      return;
    case "strikethrough":
      editor.replaceSelection(toggleWrapper(selection, "~~", "~~"));
      return;
    case "underline":
      editor.replaceSelection(toggleWrapper(selection, "<u>", "</u>"));
      return;
    case "link":
      editor.replaceSelection(`[${selection}](url)`);
      return;
  }
}

export async function applyInlineFormatToFileSelection(
  app: App,
  file: TFile,
  selection: string,
  type: FormatType
): Promise<void> {
  const content = await app.vault.read(file);
  const selectedRange = findSelectionRange(content, selection);
  if (!selectedRange) return;

  const replacement = formatInlineSelection(content.slice(selectedRange.from, selectedRange.to), type);
  await app.vault.modify(file, content.slice(0, selectedRange.from) + replacement + content.slice(selectedRange.to));
}

/**
 * 应用高亮颜色
 */
export function applyHighlight(editor: Editor, colorKey: HighlightColorKey): void {
  const selection = editor.getSelection();
  if (!selection) return;

  const color = HIGHLIGHT_COLORS[colorKey].value;
  const wrapped = `<mark style="background:${color}">${selection}</mark>`;

  editor.replaceSelection(wrapped);
}

export async function applyHighlightToFileSelection(
  app: App,
  file: TFile,
  selection: string,
  colorKey: HighlightColorKey
): Promise<void> {
  const content = await app.vault.read(file);
  const selectedRange = findSelectionRange(content, selection);
  if (!selectedRange) return;

  const color = HIGHLIGHT_COLORS[colorKey].value;
  const selectedText = content.slice(selectedRange.from, selectedRange.to);
  const replacement = `<mark style="background:${color}">${selectedText}</mark>`;
  await app.vault.modify(file, content.slice(0, selectedRange.from) + replacement + content.slice(selectedRange.to));
}

function getSelectedLineRange(editor: Editor): { fromLine: number; toLine: number } {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  let toLine = to.line;

  if (to.ch === 0 && to.line > from.line) {
    toLine = to.line - 1;
  }

  return { fromLine: from.line, toLine };
}

function getLines(editor: Editor, fromLine: number, toLine: number): string[] {
  const lines: string[] = [];

  for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
    lines.push(editor.getLine(lineNumber));
  }

  return lines;
}

function transformLines(lines: string[], style: TextStyle): string {
  if (style === "code-block") {
    return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
  }

  if (style === "callout") {
    return lines.map((line, index) => {
      const content = stripPrefix(line);
      return index === 0 ? `> [!note]\n> ${content}` : `> ${content}`;
    }).join("\n");
  }

  return lines.map((line, index) => {
    if (line.trim().length === 0) return line;
    const content = stripPrefix(line);

    switch (style) {
      case "paragraph":
        return content;
      case "heading1":
        return `# ${content}`;
      case "heading2":
        return `## ${content}`;
      case "heading3":
        return `### ${content}`;
      case "heading4":
        return `#### ${content}`;
      case "heading5":
        return `##### ${content}`;
      case "heading6":
        return `###### ${content}`;
      case "ordered-list":
        return `${index + 1}. ${content}`;
      case "unordered-list":
        return `- ${content}`;
      case "task":
        return `- [ ] ${content}`;
      case "blockquote":
        return `> ${content}`;
    }
  }).join("\n");
}

function transformAlignLines(lines: string[], action: AlignIndent): string {
  return lines.map((line) => {
    const cleanLine = stripAlignment(line);

    switch (action) {
      case "align-left":
        return cleanLine;
      case "align-center":
        return `<div align="center">${cleanLine}</div>`;
      case "align-right":
        return `<div align="right">${cleanLine}</div>`;
      case "indent-increase":
        return `\t${line}`;
      case "indent-decrease":
        return decreaseIndent(line);
    }
  }).join("\n");
}

function replaceLines(editor: Editor, fromLine: number, toLine: number, replacement: string): void {
  editor.replaceRange(
    replacement,
    { line: fromLine, ch: 0 },
    { line: toLine, ch: editor.getLine(toLine).length }
  );
}

function findSelectionRange(content: string, selection: string): { from: number; to: number } | null {
  const trimmedSelection = selection.trim();
  const exactIndex = content.indexOf(trimmedSelection);
  if (exactIndex !== -1) {
    return { from: exactIndex, to: exactIndex + trimmedSelection.length };
  }

  const escaped = trimmedSelection
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const match = content.match(new RegExp(escaped));
  if (!match || match.index === undefined) return null;

  return { from: match.index, to: match.index + match[0].length };
}

function getLineRanges(content: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let from = 0;

  content.split("\n").forEach((line) => {
    const to = from + line.length;
    ranges.push({ from, to });
    from = to + 1;
  });

  return ranges;
}

function getLineAtOffset(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length - 1;
}

function stripPrefix(line: string): string {
  return line.replace(
    /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|```\s*)/,
    "$1"
  );
}

function stripAlignment(line: string): string {
  const match = line.match(
    /^<(?:div|p)(?:\s+align="(?:left|center|right)"|\s+style="text-align:\s*(?:left|center|right);?")>([\s\S]*)<\/(?:div|p)>$/
  );
  return match ? match[1] : line;
}

function decreaseIndent(line: string): string {
  if (line.startsWith("\t")) return line.slice(1);
  return line.replace(/^ {1,4}/, "");
}

function toggleWrapper(selection: string, open: string, close: string): string {
  if (selection.startsWith(open) && selection.endsWith(close)) {
    return selection.slice(open.length, selection.length - close.length);
  }

  return `${open}${selection}${close}`;
}

function formatInlineSelection(selection: string, type: FormatType): string {
  switch (type) {
    case "bold":
      return toggleWrapper(selection, "**", "**");
    case "italic":
      return toggleWrapper(selection, "*", "*");
    case "strikethrough":
      return toggleWrapper(selection, "~~", "~~");
    case "underline":
      return toggleWrapper(selection, "<u>", "</u>");
    case "link":
      return `[${selection}](url)`;
  }
}

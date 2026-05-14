export const PLUGIN_ID = "note-bar";

export const HIGHLIGHT_COLORS = {
  yellow: { name: "荧黄色", value: "#FFE066" },
  blue: { name: "浅蓝色", value: "#A8D8F0" },
  green: { name: "浅绿色", value: "#B5E6B5" },
  purple: { name: "浅紫色", value: "#D4B8E8" },
  gray: { name: "浅灰色", value: "#D0D0D0" },
  pink: { name: "浅粉色", value: "#F5C6D0" },
} as const;

export type HighlightColorKey = keyof typeof HIGHLIGHT_COLORS;
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColorKey = "yellow";

export const TOOLBAR_CLASS = "note-bar-toolbar";
export const TOOLBAR_VISIBLE_CLASS = "note-bar-toolbar--visible";
export const TOOLBAR_THEME_LIGHT = "note-bar-toolbar--light";
export const TOOLBAR_THEME_DARK = "note-bar-toolbar--dark";
export const DROPDOWN_CLASS = "note-bar-dropdown";
export const DROPDOWN_OPEN_CLASS = "note-bar-dropdown-panel--open";
export const COLOR_PICKER_CLASS = "note-bar-color-picker";

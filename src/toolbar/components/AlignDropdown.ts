import { App } from "obsidian";
import { applyAlignIndent, applyAlignIndentToFileSelection, AlignIndent } from "../../utils/editor-formatter";
import { TOOLBAR_THEME_LIGHT, TOOLBAR_THEME_DARK } from "../../constants";
import { FormattingContextProvider } from "../formatting-context";

export interface ToolbarComponent {
  el: HTMLElement;
  destroy: () => void;
}

export function createAlignDropdown(
  app: App,
  getContext: FormattingContextProvider,
  onAction: () => void
): ToolbarComponent {
  const container = document.createElement("div");
  container.style.position = "relative";

  const trigger = document.createElement("button");
  trigger.className = "note-bar-dropdown-trigger";
  trigger.innerHTML = `<span>左对齐</span><span class="note-bar-dropdown-arrow">▾</span>`;
  container.appendChild(trigger);

  let panel: HTMLElement | null = null;
  let isOpen = false;

  const items: { label: string; icon: string; action: AlignIndent; desc: string }[] = [
    { label: "左对齐", icon: "⬅", action: "align-left", desc: "Alt+L" },
    { label: "居中对齐", icon: "⬌", action: "align-center", desc: "Alt+C" },
    { label: "右对齐", icon: "➡", action: "align-right", desc: "Alt+R" },
    { label: "增加缩进", icon: "→", action: "indent-increase", desc: "Tab" },
    { label: "减少缩进", icon: "←", action: "indent-decrease", desc: "Shift+Tab" },
  ];

  const getThemeClass = (): string => {
    const toolbar = trigger.closest(".note-bar-toolbar");
    if (toolbar) {
      if (toolbar.classList.contains(TOOLBAR_THEME_DARK)) return TOOLBAR_THEME_DARK;
      if (toolbar.classList.contains(TOOLBAR_THEME_LIGHT)) return TOOLBAR_THEME_LIGHT;
    }
    return TOOLBAR_THEME_LIGHT;
  };

  const openPanel = () => {
    if (panel) panel.remove();

    panel = document.createElement("div");
    panel.className = `note-bar-dropdown-panel ${getThemeClass()}`;

    items.forEach((item) => {
      const el = document.createElement("div");
      el.className = "note-bar-dropdown-item";
      el.innerHTML = `${item.icon} ${item.label} <span style="opacity:0.4;font-size:11px;margin-left:8px;">${item.desc}</span>`;

      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const context = getContext();
          if (context?.mode === "source") {
            context.editor.focus();
            applyAlignIndent(context.editor, item.action);
          } else if (context?.mode === "preview") {
            void applyAlignIndentToFileSelection(app, context.file, context.selection, item.action);
          }
        } catch (err) {
          console.error("Note Bar: failed to apply align/indent", err);
        }
        closePanel();
        onAction();
      });

      panel!.appendChild(el);
    });

    const rect = trigger.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.bottom + 4}px`;
    document.body.appendChild(panel);

    isOpen = true;
    trigger.classList.add("note-bar-dropdown-trigger--active");

    requestAnimationFrame(() => {
      panel?.classList.add("note-bar-dropdown-panel--open");
    });
  };

  const closePanel = () => {
    trigger.classList.remove("note-bar-dropdown-trigger--active");
    if (panel) {
      panel.classList.remove("note-bar-dropdown-panel--open");
      setTimeout(() => {
        if (panel) {
          panel.remove();
          panel = null;
        }
      }, 120);
    }
    isOpen = false;
  };

  trigger.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  });

  const onDocClick = (e: MouseEvent) => {
    if (!isOpen || !panel) return;
    const target = e.target as HTMLElement;
    if (trigger.contains(target)) return;
    if (panel.contains(target)) return;
    closePanel();
  };
  document.addEventListener("mousedown", onDocClick, true);

  const destroy = () => {
    document.removeEventListener("mousedown", onDocClick, true);
    closePanel();
  };

  return { el: container, destroy };
}

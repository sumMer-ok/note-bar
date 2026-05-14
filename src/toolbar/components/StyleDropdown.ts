import { App } from "obsidian";
import { applyTextStyle, applyTextStyleToFileSelection, TextStyle } from "../../utils/editor-formatter";
import { DROPDOWN_OPEN_CLASS, TOOLBAR_THEME_LIGHT, TOOLBAR_THEME_DARK } from "../../constants";
import { FormattingContextProvider } from "../formatting-context";

export interface ToolbarComponent {
  el: HTMLElement;
  destroy: () => void;
}

export function createStyleDropdown(
  app: App,
  getContext: FormattingContextProvider,
  onAction: () => void
): ToolbarComponent {
  const container = document.createElement("div");
  container.style.position = "relative";

  const trigger = document.createElement("button");
  trigger.className = "note-bar-dropdown-trigger";
  trigger.innerHTML = `<span>正文</span><span class="note-bar-dropdown-arrow">▾</span>`;
  container.appendChild(trigger);

  let panel: HTMLElement | null = null;
  let isOpen = false;

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

    const items: { label: string; style: TextStyle; isSub?: boolean }[] = [
      { label: "正文", style: "paragraph" },
      { label: "一级标题", style: "heading1" },
      { label: "二级标题", style: "heading2" },
      { label: "三级标题", style: "heading3" },
      { label: "其他标题 (H4-H6)", style: "heading4", isSub: true },
      { label: "有序列表", style: "ordered-list" },
      { label: "无序列表", style: "unordered-list" },
      { label: "任务", style: "task" },
      { label: "代码块", style: "code-block" },
      { label: "引用", style: "blockquote" },
      { label: "高亮块", style: "callout" },
    ];

    let subMenu: HTMLElement | null = null;

    items.forEach((item) => {
      const el = document.createElement("div");
      el.className = `note-bar-dropdown-item${item.isSub ? " note-bar-dropdown-item--sub" : ""}`;

      if (item.isSub) {
        el.textContent = "▶ " + item.label;
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (subMenu) {
            subMenu.remove();
            subMenu = null;
            return;
          }
          subMenu = document.createElement("div");
          subMenu.className = `note-bar-submenu ${getThemeClass()}`;

          const subItems: { label: string; style: TextStyle }[] = [
            { label: "四级标题", style: "heading4" },
            { label: "五级标题", style: "heading5" },
            { label: "六级标题", style: "heading6" },
          ];

          subItems.forEach((sub) => {
            const subEl = document.createElement("div");
            subEl.className = "note-bar-dropdown-item";
            subEl.textContent = sub.label;
            subEl.addEventListener("mousedown", (se) => {
              se.preventDefault();
              se.stopPropagation();
              try {
                applyTextStyleFromEditor(sub.style);
              } catch (err) {
                console.error("Note Bar: failed to apply text style", err);
              }
              closePanel();
              onAction();
            });
            subMenu!.appendChild(subEl);
          });

          const rect = el.getBoundingClientRect();
          subMenu.style.left = `${rect.right + 4}px`;
          subMenu.style.top = `${rect.top}px`;
          document.body.appendChild(subMenu);

          requestAnimationFrame(() => {
            subMenu?.classList.add("note-bar-submenu--open");
          });
        });
      } else {
        el.textContent = item.label;
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            applyTextStyleFromEditor(item.style);
          } catch (err) {
            console.error("Note Bar: failed to apply text style", err);
          }
          closePanel();
          onAction();
        });
      }

      panel!.appendChild(el);
    });

    const rect = trigger.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.bottom + 4}px`;
    document.body.appendChild(panel);

    isOpen = true;
    trigger.classList.add("note-bar-dropdown-trigger--active");

    requestAnimationFrame(() => {
      panel?.classList.add(DROPDOWN_OPEN_CLASS);
    });
  };

  const closePanel = () => {
    trigger.classList.remove("note-bar-dropdown-trigger--active");
    if (panel) {
      panel.classList.remove(DROPDOWN_OPEN_CLASS);
      setTimeout(() => {
        if (panel) {
          panel.remove();
          panel = null;
        }
      }, 120);
    }
    document.querySelectorAll(".note-bar-submenu").forEach((el) => el.remove());
    isOpen = false;
  };

  const applyTextStyleFromEditor = (style: TextStyle) => {
    const context = getContext();
    if (context?.mode === "source") {
      context.editor.focus();
      applyTextStyle(context.editor, style);
    } else if (context?.mode === "preview") {
      void applyTextStyleToFileSelection(app, context.file, context.selection, style);
    }
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
    const subMenu = document.querySelector(".note-bar-submenu");
    if (subMenu && subMenu.contains(target)) return;
    closePanel();
  };
  document.addEventListener("mousedown", onDocClick, true);

  const destroy = () => {
    document.removeEventListener("mousedown", onDocClick, true);
    closePanel();
  };

  return { el: container, destroy };
}

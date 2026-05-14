import { Plugin } from "obsidian";
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

interface ToolbarComponent {
  el: HTMLElement;
  destroy: () => void;
}

export class ToolbarManager {
  private toolbarEl: HTMLElement;
  private plugin: Plugin;
  private isVisible = false;
  private debounceTimer: number | null = null;
  private currentContext: FormattingContext | null = null;
  private onDismiss: () => void;
  private components: ToolbarComponent[] = [];

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.onDismiss = () => this.hide();
    this.toolbarEl = this.createToolbarElement();
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
    const styleDropdown = createStyleDropdown(this.plugin.app, getContext, this.onDismiss);
    const alignDropdown = createAlignDropdown(this.plugin.app, getContext, this.onDismiss);
    const formatButtons = createFormatButtons(this.plugin.app, getContext, this.onDismiss);

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

    document.body.appendChild(el);
    return el;
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
    this.show(selectionPos);
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
    this.components.forEach((component) => component.destroy());
    this.components = [];
    this.toolbarEl.remove();
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

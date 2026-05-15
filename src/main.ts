import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ToolbarManager } from "./toolbar/ToolbarManager";
import { FormattingContext } from "./toolbar/formatting-context";
import { VocabularyManager } from "./hiwords/core/vocabulary-manager";
import type { HiWordsSettings } from "./hiwords/utils/types";

const DEFAULT_AI_DEFINITION_PROMPT = 'Please provide a concise definition for the word "{{word}}" based on this context:\n\nSentence: {{sentence}}\n\nFormat:\n1) Part of speech\n2) English definition\n3) Chinese translation\n4) Example sentence (use the original sentence if appropriate)';

const DEFAULT_TRANSLATE_PROMPT = 'Translate the following text to {{to}}. Only return the translation, no explanation.\n\nText: {{text}}';

const DEFAULT_HIWORDS_SETTINGS: HiWordsSettings = {
  vocabularyBooks: [],
  studyProgress: {},
  showDefinitionOnHover: true,
  enableAutoHighlight: true,
  highlightStyle: 'underline',
  enableMasteredFeature: true,
  showMasteredInSidebar: true,
  blurDefinitions: false,
  masteredDetection: 'group',
  ttsTemplate: 'https://dict.youdao.com/dictvoice?audio={{word}}&type=2',
  pronunciationVariant: 'us',
  aiService: {
    provider: 'openai-compatible',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    extraParams: '{}'
  },
  aiDefinition: {
    enabled: true,
    prompt: DEFAULT_AI_DEFINITION_PROMPT
  },
  autoLayoutEnabled: true,
  cardWidth: 260,
  cardHeight: 120,
  highlightMode: 'all',
  highlightPaths: '',
  fileNodeParseMode: 'filename-with-alias',
  enableSectionTabs: true,
  sidebarDefaultDisplayMode: 'detail',
  selectionTranslate: {
    enabled: true,
    targetLang: 'zh-CN',
    prompt: DEFAULT_TRANSLATE_PROMPT
  },
};

export default class NoteBarPlugin extends Plugin {
  toolbarManager: ToolbarManager | null = null;
  hiwordsSettings: HiWordsSettings = DEFAULT_HIWORDS_SETTINGS;
  vocabularyManager: VocabularyManager | null = null;

  async onload() {
    console.log("Note Bar plugin loaded");

    // 加载 HiWords 设置
    await this.loadHiWordsSettings();

    // 初始化词库管理器
    this.vocabularyManager = new VocabularyManager(this.app, this.hiwordsSettings);

    // 延迟加载生词本（避免阻塞 Obsidian 启动）
    this.app.workspace.onLayoutReady(() => {
      void (async () => {
        await this.vocabularyManager!.loadAllVocabularyBooks();
      })().catch(error => {
        console.error('Note Bar: failed to load vocabulary books:', error);
      });
    });

    // 初始化工具栏管理器
    this.toolbarManager = new ToolbarManager(this, this.hiwordsSettings, this.vocabularyManager);

    this.registerSelectionChangeListener();
    this.registerDomEvent(document, "mousedown", (e) => this.toolbarManager?.onGlobalClick(e));
    this.registerDomEvent(document, "keydown", (e) => this.toolbarManager?.onKeyDown(e));

    // 注册设置页面
    this.addSettingTab(new NoteBarSettingTab(this.app, this));
  }

  async loadHiWordsSettings() {
    const savedData = await this.loadData();
    this.hiwordsSettings = Object.assign({}, DEFAULT_HIWORDS_SETTINGS, savedData || {});
  }

  async saveHiWordsSettings() {
    await this.saveData(this.hiwordsSettings);
    this.toolbarManager?.updateHiWordsSettings(this.hiwordsSettings);
  }

  private registerSelectionChangeListener(): void {
    this.registerInterval(
      window.setInterval(() => {
        const context = this.getActiveFormattingContext();
        this.toolbarManager?.onSelectionChange(context);
      }, 80)
    );
  }

  private getActiveFormattingContext(): FormattingContext | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;

    if (view.getMode() === "source") {
      const editor = view.editor;
      if (!editor?.getSelection().trim()) return null;
      return {
        mode: "source",
        editor,
        file: view.file,
      };
    }

    const file = view.file;
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    if (!file || !selection || selection.isCollapsed || !selectedText) return null;

    const anchorNode = selection.anchorNode;
    const anchorEl = anchorNode instanceof HTMLElement
      ? anchorNode
      : anchorNode?.parentElement;

    if (!anchorEl?.closest(".markdown-preview-view")) return null;

    return {
      mode: "preview",
      editor: null,
      file,
      selection: selectedText,
    };
  }

  async onunload() {
    console.log("Note Bar plugin unloaded");

    if (this.toolbarManager) {
      this.toolbarManager.destroy();
      this.toolbarManager = null;
    }
    if (this.vocabularyManager) {
      this.vocabularyManager.destroy();
      this.vocabularyManager = null;
    }
  }
}

class NoteBarSettingTab extends PluginSettingTab {
  plugin: NoteBarPlugin;

  constructor(app: App, plugin: NoteBarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Note Bar 设置' });

    // AI 服务设置
    containerEl.createEl('h3', { text: 'AI 服务（翻译 / 释义）' });

    new Setting(containerEl)
      .setName('服务商')
      .setDesc('选择 AI 服务商预设')
      .addDropdown(dropdown =>
        dropdown
          .addOption('openai-compatible', 'OpenAI 兼容')
          .addOption('anthropic', 'Anthropic Claude')
          .addOption('gemini', 'Google Gemini')
          .addOption('custom', '自定义')
          .setValue(this.plugin.hiwordsSettings.aiService.provider)
          .onChange(async (value) => {
            this.plugin.hiwordsSettings.aiService.provider = value as HiWordsSettings['aiService']['provider'];
            await this.plugin.saveHiWordsSettings();
          })
      );

    new Setting(containerEl)
      .setName('API Base URL')
      .setDesc('服务商 API 基础地址')
      .addText(text =>
        text
          .setPlaceholder('https://api.openai.com/v1')
          .setValue(this.plugin.hiwordsSettings.aiService.apiUrl)
          .onChange(async (value) => {
            this.plugin.hiwordsSettings.aiService.apiUrl = value;
            await this.plugin.saveHiWordsSettings();
          })
      );

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('你的 AI API 密钥')
      .addText(text => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.hiwordsSettings.aiService.apiKey)
          .onChange(async (value) => {
            this.plugin.hiwordsSettings.aiService.apiKey = value;
            await this.plugin.saveHiWordsSettings();
          });
      });

    new Setting(containerEl)
      .setName('模型 ID')
      .setDesc('AI 模型标识符')
      .addText(text =>
        text
          .setPlaceholder('gpt-4o-mini')
          .setValue(this.plugin.hiwordsSettings.aiService.model)
          .onChange(async (value) => {
            this.plugin.hiwordsSettings.aiService.model = value;
            await this.plugin.saveHiWordsSettings();
          })
      );

    // 翻译设置
    containerEl.createEl('h3', { text: '翻译设置' });

    new Setting(containerEl)
      .setName('目标语言')
      .setDesc('翻译的目标语言代码')
      .addText(text =>
        text
          .setPlaceholder('zh-CN')
          .setValue(this.plugin.hiwordsSettings.selectionTranslate.targetLang)
          .onChange(async (value) => {
            this.plugin.hiwordsSettings.selectionTranslate.targetLang = value;
            await this.plugin.saveHiWordsSettings();
          })
      );

    // 词库设置
    containerEl.createEl('h3', { text: '词库设置' });

    new Setting(containerEl)
      .setName('生词本')
      .setDesc('管理 Canvas 生词本文件')
      .addButton(button => {
        button.setButtonText('添加生词本');
        button.onClick(async () => {
          // 获取所有 Canvas 文件
          const canvasFiles = this.app.vault.getFiles()
            .filter(f => f.extension === 'canvas');
          if (canvasFiles.length === 0) {
            new Notice('未找到 Canvas 文件，请先创建一个 .canvas 文件');
            return;
          }
          // 简单添加第一个未添加的 Canvas 文件
          for (const file of canvasFiles) {
            const exists = this.plugin.hiwordsSettings.vocabularyBooks.some(b => b.path === file.path);
            if (!exists) {
              this.plugin.hiwordsSettings.vocabularyBooks.push({
                path: file.path,
                name: file.basename,
                enabled: true
              });
              await this.plugin.saveHiWordsSettings();
              await this.plugin.vocabularyManager!.loadAllVocabularyBooks();
              new Notice(`已添加生词本: ${file.basename}`);
              this.display();
              return;
            }
          }
          new Notice('所有 Canvas 文件已添加');
        });
      });

    // 显示当前生词本列表
    const bookList = containerEl.createDiv();
    bookList.style.marginTop = '10px';
    this.plugin.hiwordsSettings.vocabularyBooks.forEach((book, index) => {
      const bookRow = bookList.createDiv({ cls: 'setting-item' });
      bookRow.style.display = 'flex';
      bookRow.style.justifyContent = 'space-between';
      bookRow.style.alignItems = 'center';
      bookRow.style.padding = '6px 0';
      const info = bookRow.createSpan({ text: `${book.name} (${book.path})` });
      info.style.flex = '1';
      const removeBtn = bookRow.createEl('button', { text: '移除' });
      removeBtn.onclick = async () => {
        this.plugin.hiwordsSettings.vocabularyBooks.splice(index, 1);
        await this.plugin.saveHiWordsSettings();
        await this.plugin.vocabularyManager!.loadAllVocabularyBooks();
        this.display();
      };
    });

    if (this.plugin.hiwordsSettings.vocabularyBooks.length === 0) {
      bookList.createEl('p', {
        text: '暂无单词本。点击上方按钮添加 Canvas 文件作为单词本。',
        cls: 'setting-item-description'
      });
    }
  }
}

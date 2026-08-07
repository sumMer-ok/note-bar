import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { Extension } from '@codemirror/state';
import { ToolbarManager } from "./toolbar/ToolbarManager";
import { FormattingContext } from "./toolbar/formatting-context";
import { VocabularyManager } from "./hiwords/core/vocabulary-manager";
import { MasteredService } from "./hiwords/core/mastered-service";
import { createWordHighlighterExtension, highlighterManager } from "./hiwords/core/word-highlighter";
import { registerReadingModeHighlighter } from "./hiwords/ui/reading-mode-highlighter";
import { HiWordsSidebarView, SIDEBAR_VIEW_TYPE } from "./hiwords/ui/sidebar-view";
import { DefinitionPopover } from "./hiwords/ui/definition-popover";
import { ExportVocabularyModal } from "./hiwords/ui/export-vocabulary-modal";
import { FlashcardBookPickerModal } from "./hiwords/ui/flashcard-book-picker-modal";
import { shouldHighlightFile } from "./hiwords/utils/highlight-utils";
import { LocalDictionaryService, getLocalDictionaryService } from "./hiwords/services/local-dictionary-service";
import type { HiWordsSettings, VocabularyBookDisplaySettings, WordDefinition } from "./hiwords/utils/types";

const DEFAULT_AI_DEFINITION_PROMPT = '请为单词 "{{word}}" 提供释义和常见词形变化，上下文句子：{{sentence}}\n\n如果 "{{word}}" 是某个单词的变形（如动词的 -ing / -ed 形式、名词复数、形容词或副词的比较级/最高级），请务必在 aliases 中返回其原形（lemma），且 aliases 不能为空。例如：suing 应返回 ["sue", "sued", "sues"]；went 应返回 ["go", "goes", "going", "gone"]；better 应返回 ["good"]。\n\n请严格按照以下 JSON 格式输出，不要加入任何其他内容（如 markdown 代码块）：\n{\n  "aliases": ["原形", "其他常见变形1", "其他常见变形2"],\n  "definition": "1）音标\\n2）中文含义\\n3）英文释义\\n4）例句"\n}\n\n示例输出：\n{\n  "aliases": ["sustain", "sustained", "sustaining", "sustains"],\n  "definition": "1）英/ sə\'steɪn / 美/ sə\'steɪn /\\n2）v. 维持，保持；遭受，经受；支持，支撑\\nn. （乐）延音\\n3）to cause or allow something to continue for a period of time\\n4）The economy looks set to sustain its growth into next year."\n}';

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
  showSidebar: true,
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
  flashcard: {
    defaultMode: 'word-to-definition',
    newWordSteps: 2,
    masteredThreshold: { reps: 3, minEf: 2.5 },
    dailyNewWordLimit: 20,
    dailyReviewLimit: 50,
    studyOrder: 'review-first',
    syncMasteredToCanvas: true,
    enableAnimation: true,
  },
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
  hideDefinitions: false,
  defaultVocabularyBookPaths: [],
  chineseDictionary: {
    enabled: true,
    path: '.obsidian/plugins/note-bar/data/dictionary.json',
  },
  legalDictionary: {
    enabled: false,
    path: '.obsidian/plugins/note-bar/data/legal-dictionary.json',
  },
};

interface HiWordsRefreshHooks {
    _refreshReadingModeHighlighter?: () => void;
}

export default class NoteBarPlugin extends Plugin {
  toolbarManager: ToolbarManager | null = null;
  hiwordsSettings: HiWordsSettings = DEFAULT_HIWORDS_SETTINGS;
  vocabularyManager: VocabularyManager | null = null;
  masteredService: MasteredService | null = null;
  definitionPopover: DefinitionPopover | null = null;
  private editorExtensions: Extension[] = [];
  private isSidebarInitialized = false;

  async onload() {
    console.log("Note Bar plugin loaded");

    // 加载 HiWords 设置
    await this.loadHiWordsSettings();

    // 初始化词库管理器
    this.vocabularyManager = new VocabularyManager(this.app, this.hiwordsSettings);

    // 初始化已掌握服务
    this.masteredService = new MasteredService(this, this.vocabularyManager);

    // 初始化定义弹出框
    this.definitionPopover = new DefinitionPopover(this);
    this.addChild(this.definitionPopover);
    this.definitionPopover.setVocabularyManager(this.vocabularyManager);
    this.definitionPopover.setMasteredService(this.masteredService);

    // 注册侧边栏视图
    this.registerView(
      SIDEBAR_VIEW_TYPE,
      (leaf) => new HiWordsSidebarView(leaf, this)
    );

    // 注册编辑器扩展
    this.setupEditorExtensions();

    // 注册阅读模式高亮
    registerReadingModeHighlighter({
      settings: this.hiwordsSettings,
      vocabularyManager: this.vocabularyManager,
      shouldHighlightFile: (filePath: string) => this.shouldHighlightFile(filePath),
      registerMarkdownPostProcessor: this.registerMarkdownPostProcessor.bind(this),
      _refreshReadingModeHighlighter: undefined,
    });

    // 延迟加载生词本（避免阻塞 Obsidian 启动）
    this.app.workspace.onLayoutReady(() => {
      void (async () => {
        await this.vocabularyManager!.loadAllVocabularyBooks();
        this.refreshHighlighter();

        // 初始化词典服务路径（不立即加载，首次查词时懒加载）
        const dictService = getLocalDictionaryService(this.app);
        const cnConfig = this.hiwordsSettings.chineseDictionary;
        if (cnConfig?.enabled && cnConfig?.path) {
          dictService.setCnDictionaryPath(cnConfig.path);
        }
        const legalConfig = this.hiwordsSettings.legalDictionary;
        if (legalConfig?.enabled && legalConfig?.path) {
          dictService.setLegalDictionaryPath(legalConfig.path);
        }
      })().catch(error => {
        console.error('Note Bar: failed to load vocabulary books:', error);
      });
    });

    // 初始化工具栏管理器
    this.toolbarManager = new ToolbarManager(
      this,
      this.hiwordsSettings,
      this.vocabularyManager,
      () => this.refreshHighlighter()
    );

    this.registerSelectionChangeListener();
    this.registerDomEvent(document, "mousedown", (e) => this.toolbarManager?.onGlobalClick(e));
    this.registerDomEvent(document, "keydown", (e) => this.toolbarManager?.onKeyDown(e));

    // 注册设置页面
    this.addSettingTab(new NoteBarSettingTab(this.app, this));

    // 初始化侧边栏
    this.initializeSidebar();

    // Ribbon 图标：打开/聚焦侧边栏
    this.addRibbonIcon('book-open', 'HiWords 生词本', () => {
      void this.activateSidebarView();
    });

    // 命令：导出单词本为 Excel
    this.addCommand({
      id: 'note-bar-export-vocabulary',
      name: '导出单词本为 Excel',
      callback: () => {
        new ExportVocabularyModal(this.app, this.hiwordsSettings).open();
      }
    });

    // 命令：开始闪卡复习
    this.addCommand({
      id: 'note-bar-start-flashcard-review',
      name: '开始闪卡复习',
      callback: () => {
        new FlashcardBookPickerModal(this.app, this).open();
      }
    });

    // 根据设置自动打开侧边栏
    if (this.hiwordsSettings.showSidebar !== false) {
      this.app.workspace.onLayoutReady(() => {
        void this.activateSidebarView();
      });
    }

    // 注册文件变更事件（Canvas 生词本删除/修改同步）
    this.registerVaultEvents();
  }

  private setupEditorExtensions() {
    const extension = createWordHighlighterExtension(
      this.vocabularyManager!,
      (filePath: string) => this.shouldHighlightFile(filePath)
    );
    this.editorExtensions = [extension];
    this.registerEditorExtension(this.editorExtensions);
  }

  shouldHighlightFile(filePath: string): boolean {
    return shouldHighlightFile(filePath, this.hiwordsSettings);
  }

  refreshHighlighter() {
    highlighterManager.refreshAll();

    const hooks = this as NoteBarPlugin & HiWordsRefreshHooks;
    if (hooks._refreshReadingModeHighlighter) {
      hooks._refreshReadingModeHighlighter();
    }

    const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
    leaves.forEach(leaf => {
      if (leaf.view instanceof HiWordsSidebarView) {
        leaf.view.refresh();
      }
    });
  }

  private initializeSidebar() {
    if (this.isSidebarInitialized) return;
    this.app.workspace.onLayoutReady(() => {
      this.isSidebarInitialized = true;
    });
  }

  private registerVaultEvents() {
    const modifiedCanvasFiles = new Set<string>();
    let activeCanvasFile: string | null = null;

    // 1) 监听文件变化：记录被修改的 Canvas 生词本
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'canvas') {
          const isVocabBook = this.hiwordsSettings.vocabularyBooks.some(
            (book) => book.path === file.path
          );
          if (isVocabBook) {
            modifiedCanvasFiles.add(file.path);
          }
        }
      })
    );

    // 2) 监听活动标签页变化：当用户离开被修改的 Canvas 时立即重载
    const handleActiveLeafChange = async () => {
      const activeFile = this.app.workspace.getActiveFile();

      // 如果之前有活动的 Canvas 文件被修改，且现在切换到了其他文件
      if (
        activeCanvasFile &&
        modifiedCanvasFiles.has(activeCanvasFile) &&
        (!activeFile || activeFile.path !== activeCanvasFile)
      ) {
        await this.vocabularyManager!.reloadVocabularyBook(activeCanvasFile);
        this.refreshHighlighter();
        modifiedCanvasFiles.delete(activeCanvasFile);
      }

      // 更新当前活动的 Canvas 文件
      if (activeFile && activeFile.extension === 'canvas') {
        activeCanvasFile = activeFile.path;
      } else {
        activeCanvasFile = null;

        // 如果切换到非 Canvas 文件，处理所有待解析的修改
        if (modifiedCanvasFiles.size > 0) {
          const filesToProcess = Array.from(modifiedCanvasFiles);
          modifiedCanvasFiles.clear();

          for (const filePath of filesToProcess) {
            await this.vocabularyManager!.reloadVocabularyBook(filePath);
          }
          this.refreshHighlighter();
        } else {
          activeWindow.setTimeout(() => this.refreshHighlighter(), 100);
        }
      }
    };

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        void handleActiveLeafChange().catch((error) => {
          console.error('Note Bar: 处理活动文件变化失败:', error);
        });
      })
    );

    // 3) 监听文件重命名/移动：同步更新生词本路径
    const handleRename = async (file: TAbstractFile, oldPath: string) => {
      if (
        file instanceof TFile &&
        (file.extension === 'canvas' || file.extension === 'hiwords')
      ) {
        const bookIndex = this.hiwordsSettings.vocabularyBooks.findIndex(
          (book) => book.path === oldPath
        );
        if (bookIndex !== -1) {
          this.hiwordsSettings.vocabularyBooks[bookIndex].path = file.path;
          this.hiwordsSettings.vocabularyBooks[bookIndex].name = file.basename;
          await this.saveData(this.hiwordsSettings);

          this.vocabularyManager!.removeBookData(oldPath);
          await this.vocabularyManager!.reloadVocabularyBook(file.path);
          this.refreshHighlighter();

          new Notice(`生词本路径已更新: ${file.basename}`);
        }
      }
    };

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        void handleRename(file, oldPath).catch((error) => {
          console.error('Note Bar: 处理文件重命名失败:', error);
        });
      })
    );
  }

  async activateSidebarView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
      }
    }

    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }

  async showWordInSidebar(wordDef: WordDefinition, origin: 'document' | 'library' = 'document') {
    await this.activateSidebarView();
    const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
    const view = leaves[0]?.view;
    if (view instanceof HiWordsSidebarView) {
      await view.focusWord(wordDef, origin);
    }
  }

  getVocabularyBookDisplaySettings(sourcePath: string): VocabularyBookDisplaySettings | undefined {
    return this.hiwordsSettings.vocabularyBooks.find(book => book.path === sourcePath)?.display;
  }

  async loadHiWordsSettings() {
    const savedData = await this.loadData();
    this.hiwordsSettings = Object.assign({}, DEFAULT_HIWORDS_SETTINGS, savedData || {});
  }

  async saveHiWordsSettings() {
    await this.saveData(this.hiwordsSettings);
    this.toolbarManager?.updateHiWordsSettings(this.hiwordsSettings);
    this.vocabularyManager?.updateSettings(this.hiwordsSettings);
    this.masteredService?.updateSettings();
    this.app.workspace.trigger('hi-words:settings-changed');
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
    if (this.definitionPopover) {
      this.definitionPopover = null;
    }
    if (this.masteredService) {
      this.masteredService = null;
    }
    highlighterManager.clear();
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

    // 获取所有未添加的 Canvas 文件
    const allCanvasFiles = this.app.vault.getFiles().filter(f => f.extension === 'canvas');
    const existingPaths = new Set(this.plugin.hiwordsSettings.vocabularyBooks.map(b => b.path));
    const availableCanvasFiles = allCanvasFiles.filter(f => !existingPaths.has(f.path));

    const addBookSetting = new Setting(containerEl)
      .setName('添加生词本')
      .setDesc('选择一个 Canvas 文件作为生词本');

    let selectedCanvasPath = '';

    if (availableCanvasFiles.length === 0) {
      addBookSetting.setDesc('没有可用的 Canvas 文件（所有 Canvas 文件已添加或尚未创建）');
      addBookSetting.addButton(button => {
        button.setButtonText('无可用文件');
        button.setDisabled(true);
      });
    } else {
      addBookSetting.addDropdown(dropdown => {
        dropdown.addOption('', '选择 Canvas 文件...');
        availableCanvasFiles.forEach(file => {
          dropdown.addOption(file.path, `${file.basename} (${file.path})`);
        });
        dropdown.onChange(value => {
          selectedCanvasPath = value;
        });
      });

      addBookSetting.addButton(button => {
        button.setButtonText('添加');
        button.setCta();
        button.onClick(async () => {
          if (!selectedCanvasPath) {
            new Notice('请先选择一个 Canvas 文件');
            return;
          }
          const file = availableCanvasFiles.find(f => f.path === selectedCanvasPath);
          if (!file) {
            new Notice('选择的文件无效');
            return;
          }
          this.plugin.hiwordsSettings.vocabularyBooks.push({
            path: file.path,
            name: file.basename,
            enabled: true
          });
          await this.plugin.saveHiWordsSettings();
          await this.plugin.vocabularyManager!.loadAllVocabularyBooks();
          new Notice(`已添加生词本: ${file.basename}`);
          this.display();
        });
      });
    }

    // 显示当前生词本列表
    const bookList = containerEl.createDiv();
    bookList.style.marginTop = '10px';
    const defaultPaths = new Set(this.plugin.hiwordsSettings.defaultVocabularyBookPaths ?? []);
    this.plugin.hiwordsSettings.vocabularyBooks.forEach((book, index) => {
      const bookRow = bookList.createDiv({ cls: 'setting-item' });
      bookRow.style.display = 'flex';
      bookRow.style.justifyContent = 'space-between';
      bookRow.style.alignItems = 'center';
      bookRow.style.padding = '6px 0';
      const info = bookRow.createSpan({ text: `${book.name} (${book.path})` });
      info.style.flex = '1';

      const defaultBtn = bookRow.createEl('button', {
        text: defaultPaths.has(book.path) ? '默认' : '设默认'
      });
      defaultBtn.style.marginRight = '8px';
      defaultBtn.style.fontSize = '11px';
      defaultBtn.style.padding = '2px 8px';
      if (defaultPaths.has(book.path)) {
        defaultBtn.style.background = 'var(--interactive-accent)';
        defaultBtn.style.color = 'var(--text-on-accent)';
      }
      defaultBtn.onclick = async () => {
        const isDefault = defaultPaths.has(book.path);
        if (isDefault) {
          this.plugin.hiwordsSettings.defaultVocabularyBookPaths =
            (this.plugin.hiwordsSettings.defaultVocabularyBookPaths ?? []).filter(p => p !== book.path);
        } else {
          this.plugin.hiwordsSettings.defaultVocabularyBookPaths = [
            ...(this.plugin.hiwordsSettings.defaultVocabularyBookPaths ?? []),
            book.path
          ];
        }
        await this.plugin.saveHiWordsSettings();
        this.display();
      };

      const removeBtn = bookRow.createEl('button', { text: '移除' });
      removeBtn.onclick = async () => {
        this.plugin.hiwordsSettings.vocabularyBooks.splice(index, 1);
        this.plugin.hiwordsSettings.defaultVocabularyBookPaths =
          (this.plugin.hiwordsSettings.defaultVocabularyBookPaths ?? []).filter(p => p !== book.path);
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

    // 中文词典设置
    containerEl.createEl('h3', { text: '中文词典（离线英汉词典）' });
    const cnConfig = this.plugin.hiwordsSettings.chineseDictionary ?? { enabled: true, path: '' };
    this.plugin.hiwordsSettings.chineseDictionary = cnConfig;

    new Setting(containerEl)
      .setName('启用中文词典')
      .setDesc('启用后，添加单词时可自动查询离线英汉词典填充中文释义')
      .addToggle(toggle => toggle
        .setValue(cnConfig.enabled)
        .onChange(async (value) => {
          cnConfig.enabled = value;
          await this.plugin.saveHiWordsSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName('词典文件路径')
      .setDesc('dictionary.json 在 vault 中的路径')
      .addText(text => text
        .setPlaceholder('.obsidian/plugins/note-bar/data/dictionary.json')
        .setValue(cnConfig.path)
        .onChange(async (value) => {
          cnConfig.path = value.trim();
          await this.plugin.saveHiWordsSettings();
        }));

    const cnStatus = new Setting(containerEl)
      .setName('词典状态')
      .setDesc('点击加载中文词典到内存')
      .addButton(btn => btn
        .setButtonText('加载词典')
        .onClick(async () => {
          if (!cnConfig.path) {
            new Notice('请先设置词典文件路径');
            return;
          }
          btn.setButtonText('加载中...');
          btn.setDisabled(true);
          try {
            const service = getLocalDictionaryService(this.app);
            await service.loadChineseDictionary(cnConfig.path);
            const count = service.getCnDictionaryWordCount();
            new Notice(`中文词典加载成功，共 ${count} 个词条`);
            cnStatus.setDesc(`已加载：${count} 个词条`);
          } catch (err) {
            new Notice(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            btn.setButtonText('重新加载');
            btn.setDisabled(false);
          }
        }));

    // 法律词典设置
    containerEl.createEl('h3', { text: '法律词典（Black\'s Law Dictionary）' });
    const legalConfig = this.plugin.hiwordsSettings.legalDictionary ?? { enabled: false, path: '' };
    this.plugin.hiwordsSettings.legalDictionary = legalConfig;

    new Setting(containerEl)
      .setName('启用法律词典')
      .setDesc('启用后，添加单词时可同时查询 Black\'s Law Dictionary 英文释义')
      .addToggle(toggle => toggle
        .setValue(legalConfig.enabled)
        .onChange(async (value) => {
          legalConfig.enabled = value;
          await this.plugin.saveHiWordsSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName('词典文件路径')
      .setDesc('legal-dictionary.json 在 vault 中的路径')
      .addText(text => text
        .setPlaceholder('.obsidian/plugins/note-bar/data/legal-dictionary.json')
        .setValue(legalConfig.path)
        .onChange(async (value) => {
          legalConfig.path = value.trim();
          await this.plugin.saveHiWordsSettings();
        }));

    const legalStatus = new Setting(containerEl)
      .setName('词典状态')
      .setDesc('点击加载法律词典到内存')
      .addButton(btn => btn
        .setButtonText('加载词典')
        .onClick(async () => {
          if (!legalConfig.path) {
            new Notice('请先设置词典文件路径');
            return;
          }
          btn.setButtonText('加载中...');
          btn.setDisabled(true);
          try {
            const service = getLocalDictionaryService(this.app);
            await service.loadLegalDictionary(legalConfig.path);
            const count = service.getLegalDictionaryWordCount();
            new Notice(`法律词典加载成功，共 ${count} 个词条`);
            legalStatus.setDesc(`已加载：${count} 个词条`);
          } catch (err) {
            new Notice(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            btn.setButtonText('重新加载');
            btn.setDisabled(false);
          }
        }));

    // 闪卡复习设置
    containerEl.createEl('h3', { text: '闪卡复习' });

    const flashcard = this.plugin.hiwordsSettings.flashcard ?? {
      defaultMode: 'word-to-definition',
      newWordSteps: 2,
      masteredThreshold: { reps: 3, minEf: 2.5 },
      dailyNewWordLimit: 20,
      dailyReviewLimit: 50,
      studyOrder: 'review-first',
      syncMasteredToCanvas: true,
      enableAnimation: true,
    };
    this.plugin.hiwordsSettings.flashcard = flashcard;

    new Setting(containerEl)
      .setName('默认复习模式')
      .setDesc('打开复习弹窗时默认正面显示的内容')
      .addDropdown(dropdown => dropdown
        .addOption('word-to-definition', '英→中')
        .addOption('definition-to-word', '中→英')
        .setValue(flashcard.defaultMode)
        .onChange(async (value) => {
          flashcard.defaultMode = value as 'word-to-definition' | 'definition-to-word';
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('每日新词上限')
      .setDesc('每轮复习最多出现几个新词')
      .addText(text => text
        .setValue(String(flashcard.dailyNewWordLimit))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          flashcard.dailyNewWordLimit = isNaN(num) ? 20 : Math.max(0, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('每日复习上限')
      .setDesc('每轮复习最多出现几个到期复习词')
      .addText(text => text
        .setValue(String(flashcard.dailyReviewLimit))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          flashcard.dailyReviewLimit = isNaN(num) ? 50 : Math.max(0, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('学习顺序')
      .setDesc('复习词与新词的出现顺序')
      .addDropdown(dropdown => dropdown
        .addOption('review-first', '先复习再学习新词')
        .addOption('new-first', '先学习新词再复习')
        .setValue(flashcard.studyOrder)
        .onChange(async (value) => {
          flashcard.studyOrder = value as 'review-first' | 'new-first';
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('新词学习步数')
      .setDesc('新词需要连续认识/太简单几次才进入复习阶段')
      .addText(text => text
        .setValue(String(flashcard.newWordSteps))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          flashcard.newWordSteps = isNaN(num) ? 2 : Math.max(1, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('掌握阈值 - 连续成功次数')
      .setDesc('reps 达到多少时判定为已掌握')
      .addText(text => text
        .setValue(String(flashcard.masteredThreshold.reps))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          flashcard.masteredThreshold.reps = isNaN(num) ? 3 : Math.max(1, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('掌握阈值 - 最低 EF')
      .setDesc('熟练度因子最低值')
      .addText(text => text
        .setValue(String(flashcard.masteredThreshold.minEf))
        .onChange(async (value) => {
          const num = parseFloat(value);
          flashcard.masteredThreshold.minEf = isNaN(num) ? 2.5 : Math.max(1.3, num);
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('自动同步已掌握到 Canvas')
      .setDesc('达到掌握阈值后自动移动到 Canvas 的 Mastered 分组')
      .addToggle(toggle => toggle
        .setValue(flashcard.syncMasteredToCanvas)
        .onChange(async (value) => {
          flashcard.syncMasteredToCanvas = value;
          await this.plugin.saveHiWordsSettings();
        }));

    new Setting(containerEl)
      .setName('启用动画')
      .setDesc('翻转与切题动画开关')
      .addToggle(toggle => toggle
        .setValue(flashcard.enableAnimation)
        .onChange(async (value) => {
          flashcard.enableAnimation = value;
          await this.plugin.saveHiWordsSettings();
        }));

    // 显示设置
    containerEl.createEl('h3', { text: '显示设置' });

    new Setting(containerEl)
      .setName('显示 HiWords 侧边栏')
      .setDesc('开启后，插件启动时自动显示右侧生词本侧边栏')
      .addToggle(toggle => toggle
        .setValue(this.plugin.hiwordsSettings.showSidebar ?? true)
        .onChange(async (value) => {
          this.plugin.hiwordsSettings.showSidebar = value;
          await this.plugin.saveHiWordsSettings();
          if (value) {
            void this.plugin.activateSidebarView();
          } else {
            const leaves = this.plugin.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
            leaves.forEach(leaf => leaf.detach());
          }
        }));

    new Setting(containerEl)
      .setName('释义毛玻璃效果')
      .setDesc('开启后，鼠标悬停单词时释义呈现半透明模糊状态，悬停释义区域后清晰显示')
      .addToggle(toggle => toggle
        .setValue(this.plugin.hiwordsSettings.blurDefinitions)
        .onChange(async (value) => {
          this.plugin.hiwordsSettings.blurDefinitions = value;
          await this.plugin.saveHiWordsSettings();
          this.plugin.refreshHighlighter();
        }));

    new Setting(containerEl)
      .setName('隐藏单词释义')
      .setDesc('开启后，在相关视图中默认隐藏单词释义内容')
      .addToggle(toggle => toggle
        .setValue(this.plugin.hiwordsSettings.hideDefinitions ?? false)
        .onChange(async (value) => {
          this.plugin.hiwordsSettings.hideDefinitions = value;
          await this.plugin.saveHiWordsSettings();
        }));
  }
}

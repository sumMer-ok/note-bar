import { App, MarkdownRenderer, MarkdownView, Notice, setIcon, TFile, Component } from 'obsidian';
import type NoteBarPlugin from '../../main';
import type { VocabularyManager } from '../core/vocabulary-manager';
import type { MasteredService } from '../core/mastered-service';
import { playWordTTS, WordDefinition } from '../utils';
import { renderWordCard } from './word-card-renderer';
import { AddWordModal } from './add-word-modal';
import { getEncounterTracker, formatYYYYMMDD } from '../core/encounter-tracker';

interface HoverLinkWorkspace {
    trigger(name: 'hover-link', payload: {
        event: Event;
        source: string;
        hoverParent: HTMLElement;
        target: HTMLElement;
        linktext: string;
        sourcePath: string;
    }): void;
}

interface SearchViewLike {
    setQuery?: (query: string) => void;
}

export class DefinitionPopover extends Component {
    private app: App;
    private plugin: NoteBarPlugin;
    private activeTooltip: HTMLElement | null = null;
    private vocabularyManager: VocabularyManager | null = null;
    private masteredService: MasteredService | null = null;
    private eventHandlers: {[key: string]: (event: Event) => void} = {};
    private tooltipHideTimeout: number | undefined;
    private currentTargetEl: HTMLElement | null = null;
    private hoverIntentTimer: number | null = null;
    private lastShowTs = 0;
    private currentTooltipComponent: Component | null = null;
    private static readonly SHOW_DELAY_MS = 120;
    private static readonly MIN_INTERVAL_MS = 150;

    constructor(plugin: NoteBarPlugin) {
        super();
        this.app = plugin.app;
        this.plugin = plugin;

        this.eventHandlers = {
            mouseover: (event: Event) => this.handleMouseOver(event as MouseEvent),
            mouseout: (event: Event) => this.handleMouseOut(event as MouseEvent),
            click: (event: Event) => this.handleClick(event as MouseEvent),
            scroll: (() => this.removeTooltip()).bind(this),
            resize: (() => this.removeTooltip()).bind(this),
        };

        this.registerEvents();
    }

    private bindInternalLinksAndTags(root: HTMLElement, sourcePath: string, hoverParent: HTMLElement) {
        root.querySelectorAll('a.internal-link').forEach((a) => {
            const linkEl = a as HTMLAnchorElement;
            const linktext = (linkEl.getAttribute('href') || linkEl.dataset.href || '').trim();
            if (!linktext) return;

            linkEl.addEventListener('mouseover', (evt) => {
                (this.app.workspace as unknown as HoverLinkWorkspace).trigger('hover-link', {
                    event: evt,
                    source: 'hi-words',
                    hoverParent,
                    target: linkEl,
                    linktext,
                    sourcePath
                });
            });

            linkEl.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                void this.app.workspace.openLinkText(linktext, sourcePath).catch(error => {
                    console.error('生词本 打开内部链接失败:', error);
                });
                this.removeTooltip();
            });
        });

        root.querySelectorAll('a.tag').forEach((a) => {
            const tagEl = a as HTMLAnchorElement;
            const query = (tagEl.getAttribute('href') || tagEl.textContent || '').trim();
            if (!query) return;
            tagEl.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.openOrUpdateSearch(query.startsWith('#') ? query : `#${query}`);
                this.removeTooltip();
            });
        });
    }

    private openOrUpdateSearch(query: string) {
        try {
            const leaves = this.app.workspace.getLeavesOfType('search');
            if (leaves.length > 0) {
                const view = leaves[0].view as SearchViewLike;
                view.setQuery?.(query);
                void this.app.workspace.revealLeaf(leaves[0]).catch(error => {
                    console.error('生词本 打开搜索视图失败:', error);
                });
                return;
            }
            new Notice('请先启用核心搜索插件');
        } catch (e) {
            console.error('打开搜索失败:', e);
        }
    }

    setVocabularyManager(manager: VocabularyManager) {
        this.vocabularyManager = manager;
    }

    setMasteredService(service: MasteredService) {
        this.masteredService = service;
    }

    private registerEvents() {
        this.registerDomEvent(document, 'mouseover', this.eventHandlers.mouseover);
        this.registerDomEvent(document, 'mouseout', this.eventHandlers.mouseout);
        this.registerDomEvent(document, 'click', this.eventHandlers.click);
        this.registerDomEvent(window, 'scroll', this.eventHandlers.scroll as EventListener, { passive: true });
        this.registerDomEvent(window, 'resize', this.eventHandlers.resize as EventListener);
    }

    /**
     * 点击原文中的高亮词同样弹出释义弹窗（悬停显示释义关闭时也能用），
     * 弹窗里提供「编辑」入口直接进入 AddWordModal 编辑模式。
     */
    private handleClick(event: MouseEvent) {
        const raw = event.target as HTMLElement | null;
        const target = raw?.closest?.('.hi-words-highlight') as HTMLElement | null;
        if (!target) return;
        if (this.currentTargetEl === target && this.activeTooltip) return;

        const word = target.getAttribute('data-word');
        const definition = target.getAttribute('data-definition');
        if (!word || !definition) return;

        this.currentTargetEl = target;
        void this.createTooltip(target, word, definition);
    }

    private handleMouseOut(event: MouseEvent) {
        activeWindow.clearTimeout(this.tooltipHideTimeout);
        if (this.hoverIntentTimer !== null) {
            activeWindow.clearTimeout(this.hoverIntentTimer);
            this.hoverIntentTimer = null;
        }
        const from = event.target as HTMLElement;
        const to = event.relatedTarget as HTMLElement | null;

        if (
            to &&
            this.activeTooltip &&
            (to === this.activeTooltip || this.activeTooltip.contains(to))
        ) {
            return;
        }

        if (
            from &&
            to &&
            from.classList.contains('hi-words-highlight') &&
            to.classList.contains('hi-words-highlight')
        ) {
            return;
        }

        if (
            from &&
            this.activeTooltip &&
            this.activeTooltip.contains(from) &&
            to &&
            to.classList.contains('hi-words-highlight')
        ) {
            return;
        }

        this.tooltipHideTimeout = activeWindow.setTimeout(() => {
            this.removeTooltip();
        }, 80);
    }

    private async renderSectionContent(contentEl: HTMLElement, content: string, tooltip: HTMLElement): Promise<void> {
        contentEl.empty();

        if (!content || content.trim() === '') {
            contentEl.textContent = '暂无释义';
            return;
        }

        try {
            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            const sourcePath = (activeView && activeView.file?.path) || this.app.workspace.getActiveFile()?.path || '';

            if (this.currentTooltipComponent) {
                this.removeChild(this.currentTooltipComponent);
                this.currentTooltipComponent = null;
            }

            const tempComponent = new Component();
            this.addChild(tempComponent);
            this.currentTooltipComponent = tempComponent;

            await MarkdownRenderer.render(
                this.app,
                content,
                contentEl,
                sourcePath,
                tempComponent
            );

            requestAnimationFrame(() => this.bindInternalLinksAndTags(contentEl, sourcePath, tooltip));
        } catch (error) {
            console.error('Markdown 渲染失败:', error);
            contentEl.textContent = content;
        }
    }

    private handleMouseOver(event: MouseEvent) {
        if (!this.plugin.hiwordsSettings.showDefinitionOnHover) {
            return;
        }

        const raw = event.target as HTMLElement;
        const target = raw?.closest?.('.hi-words-highlight') as HTMLElement | null;

        if (target) {
            if (this.currentTargetEl === target && this.activeTooltip) return;

            if (this.hoverIntentTimer !== null) {
                activeWindow.clearTimeout(this.hoverIntentTimer);
                this.hoverIntentTimer = null;
            }
            this.currentTargetEl = target;
            const word = target.getAttribute('data-word');
            const definition = target.getAttribute('data-definition');
            if (!word || !definition) return;

            this.hoverIntentTimer = activeWindow.setTimeout(() => {
                this.hoverIntentTimer = null;
                const now = Date.now();
                if (now - this.lastShowTs < DefinitionPopover.MIN_INTERVAL_MS) {
                    return;
                }
                this.lastShowTs = now;
                void this.createTooltip(target, word, definition);
            }, DefinitionPopover.SHOW_DELAY_MS);
        }
    }

    private async createTooltip(target: HTMLElement, word: string, definition: string) {
        this.removeTooltip();

        const tooltip = document.createElement('div');
        tooltip.className = 'hi-words-tooltip';
        const wordDef = this.vocabularyManager?.getDefinition(word);
        // 相遇记账（hover）+ hover 回流：弹窗实际显示时触发
        this.trackHoverEncounter(wordDef, word);
        if (wordDef?.card) {
            tooltip.classList.add('hi-words-tooltip-structured');
        }

        const titleContainer = document.createElement('div');
        titleContainer.className = 'hi-words-tooltip-title-container';

        const titleEl = document.createElement('div');
        titleEl.className = 'hi-words-tooltip-title';
        titleEl.textContent = word;
        titleContainer.appendChild(titleEl);
        titleEl.title = '点击发音';
        titleEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            await playWordTTS(this.app, this.plugin.hiwordsSettings, word, wordDef || undefined);
        });

        tooltip.appendChild(titleContainer);

        const sections = wordDef?.card ? undefined : wordDef?.sections;
        const enableSectionTabs = this.plugin.hiwordsSettings.enableSectionTabs ?? true;

        if (sections && sections.length > 1 && enableSectionTabs && !this.plugin.hiwordsSettings.hideDefinitions) {
            const tabsContainer = document.createElement('div');
            tabsContainer.className = 'hi-words-tooltip-tabs';

            sections.forEach((section, index) => {
                const tab = document.createElement('div');
                tab.className = 'hi-words-tooltip-tab';
                if (index === 0) {
                    tab.classList.add('active');
                }
                tab.textContent = section.title;
                tab.addEventListener('click', () => {
                    tabsContainer.querySelectorAll('.hi-words-tooltip-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    void this.renderSectionContent(contentEl, sections[index].content, tooltip);
                });
                tabsContainer.appendChild(tab);
            });

            tooltip.appendChild(tabsContainer);
        }

        const contentEl = document.createElement('div');
        contentEl.className = 'hi-words-tooltip-content';

        if (this.plugin.hiwordsSettings.blurDefinitions) {
            contentEl.classList.add('hi-words-definition', 'blur-enabled');
        } else {
            contentEl.classList.add('hi-words-definition');
        }

        tooltip.appendChild(contentEl);

        if (this.plugin.hiwordsSettings.hideDefinitions) {
            contentEl.textContent = '释义已隐藏';
            contentEl.addClass('hi-words-definition-hidden');
        } else if (wordDef?.card) {
            renderWordCard(contentEl, wordDef, {
                mode: 'popover',
                app: this.app,
                pronunciationVariant: this.plugin.hiwordsSettings.pronunciationVariant || 'us',
                onPronunciationClick: (variant) => playWordTTS(this.app, this.plugin.hiwordsSettings, wordDef.word, wordDef, variant),
                display: this.plugin.getVocabularyBookDisplaySettings(wordDef.source),
                onOpenDetail: async () => {
                    this.removeTooltip();
                    await this.plugin.showWordInSidebar(wordDef, 'document');
                },
            });
        } else {
            const contentToRender = sections && sections.length > 0 && enableSectionTabs
                ? sections[0].content
                : definition;

            if (!contentToRender || contentToRender.trim() === '') {
                contentEl.textContent = '暂无释义';
            } else {
                await this.renderSectionContent(contentEl, contentToRender, tooltip);
            }
        }

        if (this.vocabularyManager) {
            const detailDef = this.vocabularyManager.getDefinition(word);
            if (detailDef && detailDef.source) {
                if (this.masteredService && this.masteredService.isEnabled) {
                    const buttonContainer = document.createElement('div');
                    buttonContainer.className = 'hi-words-tooltip-title-mastered-button';
                    setIcon(buttonContainer, detailDef.mastered ? 'frown' : 'smile');

                    buttonContainer.addEventListener('click', async (e) => {
                        e.stopPropagation();

                        try {
                            const masteredService = this.masteredService;
                            if (!masteredService) return;

                            if (detailDef.mastered) {
                                await masteredService.unmarkWordAsMastered(detailDef.source, detailDef.nodeId, detailDef.word);
                            } else {
                                await masteredService.markWordAsMastered(detailDef.source, detailDef.nodeId, detailDef.word);
                            }
                            this.removeTooltip();
                        } catch (error) {
                            console.error('切换已掌握状态失败:', error);
                        }
                    });

                    titleContainer.appendChild(buttonContainer);
                }

                if (!detailDef.source.endsWith('.hiwords')) {
                    const sourceEl = document.createElement('div');
                    sourceEl.className = 'hi-words-tooltip-source';
                    const fileName = detailDef.source.split('/').pop() || '';
                    const displayName = fileName.endsWith('.canvas') ? fileName.slice(0, -7) : fileName;
                    sourceEl.textContent = `来源: ${displayName}`;

                    sourceEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.navigateToSource(detailDef);
                        this.removeTooltip();
                    });

                    tooltip.appendChild(sourceEl);
                }

                // 编辑入口：直接打开 AddWordModal 编辑模式（.hiwords 结构化词库沿用弹窗内的只读提示）
                const editButton = document.createElement('button');
                editButton.className = 'hi-words-tooltip-edit';
                editButton.textContent = '编辑';
                editButton.setAttribute('aria-label', '编辑该词条');
                editButton.style.marginTop = '6px';
                editButton.style.padding = '3px 10px';
                editButton.style.fontSize = '12px';
                editButton.style.borderRadius = '4px';
                editButton.style.border = '1px solid var(--background-modifier-border)';
                editButton.style.background = 'var(--interactive-normal)';
                editButton.style.color = 'var(--text-normal)';
                editButton.style.cursor = 'pointer';

                editButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openEditModal(detailDef);
                });

                tooltip.appendChild(editButton);
            }
        }

        document.body.appendChild(tooltip);

        requestAnimationFrame(() => {
            const rect = target.getBoundingClientRect();
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
            const viewportWidth = window.innerWidth;

            const left = rect.left + scrollLeft;
            const top = rect.bottom + scrollTop + 5;
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';

            const tooltipRect = tooltip.getBoundingClientRect();

            if (tooltipRect.right > viewportWidth - 10) {
                const overflow = tooltipRect.right - viewportWidth + 10;
                tooltip.style.left = (left - overflow) + 'px';
            }
        });

        tooltip.addEventListener('mouseleave', (e) => {
            this.removeTooltip();
        });

        this.activeTooltip = tooltip;
    }

    /**
     * 弹窗显示时触发：
     * 1) 记录一次悬停相遇（hover 记 hoverCount + encounterCount，冷却 60 秒去重）；
     * 2) hover 回流：若开启且词条未掌握、到期日远于 today + N 天，则把 dueDate 提前到今天。
     *    红线：只修改 dueDate，绝不改动 s/d/lapses/reps，也不写入复习日志。
     */
    private trackHoverEncounter(wordDef: WordDefinition | null | undefined, word: string) {
        const studyKey = wordDef?.studyKey || word.toLowerCase();
        getEncounterTracker()?.record(studyKey, 'hover');

        const feedback = this.plugin.hiwordsSettings.hoverFeedback;
        if (!feedback?.enabled || !wordDef?.studyKey) return;
        const progress = this.plugin.hiwordsSettings.studyProgress?.[wordDef.studyKey];
        if (!progress) return;
        if (progress.status === 'mastered' || !progress.dueDate) return;

        const days = feedback.days ?? 3;
        const thresholdDate = new Date();
        thresholdDate.setDate(thresholdDate.getDate() + days);
        const threshold = formatYYYYMMDD(thresholdDate);
        // dueDate 可能是完整 ISO 或 YYYY-MM-DD，统一截取前 10 位做字符串比较
        if (progress.dueDate.slice(0, 10) > threshold) {
            progress.dueDate = formatYYYYMMDD(new Date());
            void this.plugin.saveHiWordsSettings().catch((error) => {
                console.error('Note Bar: 保存 hover 回流后的复习进度失败:', error);
            });
        }
    }

    private removeTooltip() {
        activeWindow.clearTimeout(this.tooltipHideTimeout);
        if (this.activeTooltip && this.activeTooltip.parentNode) {
            this.activeTooltip.parentNode.removeChild(this.activeTooltip);
            this.activeTooltip = null;
        }
        if (this.currentTooltipComponent) {
            this.removeChild(this.currentTooltipComponent);
            this.currentTooltipComponent = null;
        }
        this.currentTargetEl = null;
    }

    /**
     * 从原文高亮词的弹窗直接进入编辑：打开 AddWordModal 编辑模式。
     * 保存后复用既有刷新路径（重载词库缓存 + 刷新高亮与侧边栏），保证 Canvas 节点、词库缓存与高亮一致。
     */
    private openEditModal(wordDef: WordDefinition) {
        const vocabularyManager = this.vocabularyManager;
        if (!vocabularyManager) return;

        this.removeTooltip();

        new AddWordModal(
            this.app,
            this.plugin.hiwordsSettings,
            vocabularyManager,
            wordDef.word,
            '',
            true,
            '',
            wordDef,
            () => {
                void vocabularyManager.loadAllVocabularyBooks()
                    .then(() => this.plugin.refreshHighlighter())
                    .catch(error => console.error('Note Bar: 编辑保存后刷新词库失败:', error));
            }
        ).open();
    }

    private async navigateToSource(wordDef: WordDefinition) {
        try {
            const file = this.app.vault.getAbstractFileByPath(wordDef.source);
            if (!(file instanceof TFile)) return;

            await this.app.workspace.openLinkText(file.path, '');

            if (file.extension === 'canvas' && wordDef.nodeId) {
                activeWindow.setTimeout(() => {
                    this.focusCanvasNode(file.path, wordDef.nodeId!);
                }, 300);
            } else if (file.extension === 'md') {
                activeWindow.setTimeout(() => {
                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (activeView && activeView.file?.path === file.path) {
                        const editor = activeView.editor;
                        const content = editor.getValue();
                        const wordIndex = content.toLowerCase().indexOf(wordDef.word.toLowerCase());
                        if (wordIndex !== -1) {
                            const pos = editor.offsetToPos(wordIndex);
                            editor.setCursor(pos);
                            editor.scrollIntoView({ from: pos, to: pos }, true);
                        }
                    }
                }, 100);
            }
        } catch (error) {
            console.error('导航到源文件失败:', error);
        }
    }

    private findCanvasView(filePath: string): any {
        const leaves = this.app.workspace.getLeavesOfType('canvas');
        for (const leaf of leaves) {
            const view = (leaf as any).view;
            if (view?.file?.path === filePath) return view;
        }
        return null;
    }

    private focusCanvasNode(filePath: string, nodeId: string) {
        const canvasView = this.findCanvasView(filePath);
        if (!canvasView) return;
        const canvas = canvasView.canvas;
        if (!canvas || typeof canvas.nodes !== 'object') return;
        const node = canvas.nodes.get?.(nodeId) ?? canvas.nodes[nodeId];
        if (!node) return;
        if (typeof canvas.deselectAll === 'function') canvas.deselectAll();
        if (typeof canvas.selectNodes === 'function') canvas.selectNodes([node]);
        if (typeof canvas.scrollToNodes === 'function') canvas.scrollToNodes([node]);
        activeWindow.setTimeout(() => {
            if (typeof node.startEditing === 'function') node.startEditing();
        }, 200);
    }

    onunload() {
        this.removeTooltip();
    }
}

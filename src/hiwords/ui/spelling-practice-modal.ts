import { App, Component, Modal, Notice, setIcon } from 'obsidian';
import type NoteBarPlugin from '../../main';
import type { WordDefinition } from '../utils';
import { playWordTTS } from '../utils/tts';

/**
 * 拼写/听写练习弹窗
 * 从选定生词本随机抽取单词，展示中文释义与发音，用户输入拼写并实时反馈
 * - 提交后展开该单词完整释义，输入框可继续重复输入（判定以第一次输入为准）
 */
export class SpellingPracticeModal extends Modal {
    private plugin: NoteBarPlugin;
    private bookName: string;
    private queue: WordDefinition[];
    private maxCount: number;
    private currentIndex = 0;
    private correctCount = 0;
    private wrongCount = 0;
    private wrongWords: WordDefinition[] = [];
    private checked = false; // 当前题是否已提交（判定以第一次输入为准）
    private userModifiedAfterCheck = false; // 判定后用户是否重新修改过输入框

    private domEventComponent: Component;
    private headerEl!: HTMLElement;
    private progressEl!: HTMLElement;
    private accuracyEl!: HTMLElement;
    private cardEl!: HTMLElement;
    private definitionEl!: HTMLElement;
    private phoneticEl!: HTMLElement;
    private spellInput!: HTMLInputElement;
    private feedbackEl!: HTMLElement;
    private nextBtnEl!: HTMLElement;
    private definitionDetailEl!: HTMLElement;
    private progressBarEl!: HTMLElement;

    constructor(app: App, plugin: NoteBarPlugin, bookName: string, words: WordDefinition[], maxCount?: number) {
        super(app);
        this.plugin = plugin;
        this.bookName = bookName;
        this.maxCount = maxCount && maxCount > 0 ? maxCount : 0;
        let queue = this.shuffle([...words]);
        if (this.maxCount > 0) queue = queue.slice(0, this.maxCount);
        this.queue = queue;
        this.domEventComponent = new Component();
        this.domEventComponent.load();
    }

    private shuffle<T>(arr: T[]): T[] {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('spelling-modal-content');
        this.modalEl.addClass('spelling-modal');

        // 头部
        this.headerEl = contentEl.createDiv({ cls: 'spelling-header' });
        const title = this.headerEl.createDiv({ cls: 'spelling-title', text: `拼写练习 · ${this.bookName}` });
        void title;
        const closeBtn = this.headerEl.createDiv({ cls: 'spelling-close-btn' });
        setIcon(closeBtn, 'x');
        this.registerDomEvent(closeBtn, 'click', () => this.close());

        // 进度信息
        const statsRow = contentEl.createDiv({ cls: 'spelling-stats' });
        this.progressEl = statsRow.createDiv({ cls: 'spelling-progress-text' });
        this.accuracyEl = statsRow.createDiv({ cls: 'spelling-accuracy' });

        // 进度条
        const barWrap = contentEl.createDiv({ cls: 'spelling-progress-bar-wrap' });
        this.progressBarEl = barWrap.createDiv({ cls: 'spelling-progress-bar' });

        // 卡片
        this.cardEl = contentEl.createDiv({ cls: 'spelling-card' });
        const defWrap = this.cardEl.createDiv({ cls: 'spelling-definition-wrap' });
        this.definitionEl = defWrap.createDiv({ cls: 'spelling-definition' });
        this.phoneticEl = defWrap.createDiv({ cls: 'spelling-phonetic' });

        // 发音按钮
        const speakBtn = this.cardEl.createDiv({ cls: 'spelling-speak-btn' });
        const speakIcon = speakBtn.createDiv({ cls: 'spelling-speak-icon' });
        setIcon(speakIcon, 'volume-2');
        this.registerDomEvent(speakBtn, 'click', () => this.playAudio());

        // 拼写输入
        const inputSection = this.cardEl.createDiv({ cls: 'spelling-input-section' });
        this.spellInput = inputSection.createEl('input', {
            type: 'text',
            cls: 'spelling-input',
            placeholder: '输入单词拼写，按回车提交',
        });
        this.spellInput.setAttribute('autocomplete', 'off');
        this.spellInput.setAttribute('autocapitalize', 'off');
        this.spellInput.setAttribute('spellcheck', 'false');
        this.feedbackEl = inputSection.createDiv({ cls: 'spelling-feedback' });
        this.nextBtnEl = inputSection.createEl('button', {
            cls: 'spelling-next-btn',
            text: '下一题'
        });
        this.nextBtnEl.style.display = 'none';

        // 提交后展开的完整释义区
        this.definitionDetailEl = this.cardEl.createDiv({ cls: 'spelling-definition-detail' });
        this.definitionDetailEl.style.display = 'none';

        this.registerDomEvent(this.spellInput, 'keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Enter' && !evt.isComposing) {
                evt.preventDefault();
                if (this.checked) {
                    // 判定后：只有用户没有再修改输入框才跳转；重新输入则回车重新判定反馈（统计仍以第一次为准）
                    if (!this.userModifiedAfterCheck) {
                        this.next();
                    } else {
                        this.recheckSpell();
                    }
                } else {
                    this.checkSpell();
                }
            }
        });
        this.registerDomEvent(this.spellInput, 'input', () => {
            this.spellInput.removeClass('correct', 'wrong');
            if (this.checked) {
                this.userModifiedAfterCheck = true;
            }
            this.feedbackEl.textContent = '';
        });
        this.registerDomEvent(this.nextBtnEl, 'click', () => this.next());

        // 渲染第一题
        this.renderCurrent();
    }

    private get currentWord(): WordDefinition {
        return this.queue[this.currentIndex];
    }

    private renderCurrent() {
        const word = this.currentWord;
        this.checked = false;
        this.userModifiedAfterCheck = false;
        this.cardEl.removeClass('reveal');

        // 释义：优先中文，其次英文
        const zh = this.extractChineseMeaning(word.definition)
            || this.extractChineseMeaning(word.rawDefinition || '');
        this.definitionEl.textContent = zh || (word.definition || '').trim() || '暂无释义';

        // 音标
        const phonetic = word.card?.phonetic || '';
        this.phoneticEl.textContent = phonetic;
        this.phoneticEl.style.display = phonetic ? '' : 'none';

        // 重置输入
        this.spellInput.value = '';
        this.spellInput.removeClass('correct', 'wrong');
        this.spellInput.disabled = false;
        this.feedbackEl.textContent = '';
        this.feedbackEl.removeClass('correct', 'wrong');
        this.nextBtnEl.style.display = 'none';
        this.definitionDetailEl.textContent = '';
        this.definitionDetailEl.style.display = 'none';

        this.updateStats();
        this.spellInput.focus();

        // 自动播放发音
        this.playAudio();
    }

    private updateStats() {
        const total = this.correctCount + this.wrongCount;
        const accuracy = total > 0 ? Math.round((this.correctCount / total) * 100) : 0;
        this.progressEl.textContent = `${Math.min(this.currentIndex + 1, this.queue.length)} / ${this.queue.length}`;
        this.accuracyEl.textContent = `正确率 ${accuracy}% · 已练 ${total}`;
        const pct = this.queue.length > 0
            ? ((this.currentIndex + (this.checked ? 1 : 0)) / this.queue.length) * 100
            : 0;
        this.progressBarEl.style.width = `${Math.min(100, pct)}%`;
    }

    private checkSpell() {
        if (this.checked) return;
        const word = this.currentWord;
        const input = this.spellInput.value.trim().toLowerCase();
        const target = word.word.toLowerCase();
        const aliases = (word.aliases || []).map(a => a.toLowerCase());
        const correct = input === target || aliases.includes(input);

        // 判定以第一次输入为准，锁定结果
        this.checked = true;
        this.userModifiedAfterCheck = false;
        this.cardEl.addClass('reveal');

        if (correct) {
            this.correctCount++;
            this.spellInput.addClass('correct');
            this.feedbackEl.textContent = '✓ 拼写正确';
            this.feedbackEl.addClass('correct');
        } else {
            this.wrongCount++;
            this.wrongWords.push(word);
            this.spellInput.addClass('wrong');
            this.feedbackEl.textContent = `✗ 正确拼写：${word.word}`;
            this.feedbackEl.addClass('wrong');
        }

        // 展开该单词的完整释义
        const detail = word.rawDefinition || word.definition || '';
        if (detail.trim()) {
            this.definitionDetailEl.textContent = detail.trim();
            this.definitionDetailEl.style.display = '';
        }

        // 输入框保持可用（可重复输入练习），显示"下一题"按钮
        this.spellInput.disabled = false;
        this.nextBtnEl.style.display = '';
        this.spellInput.focus();
        this.updateStats();
    }

    /** 判定后用户重新输入时的再次判定：只更新颜色与反馈文字，不影响统计（以第一次判定为准） */
    private recheckSpell() {
        const word = this.currentWord;
        const input = this.spellInput.value.trim().toLowerCase();
        const target = word.word.toLowerCase();
        const aliases = (word.aliases || []).map(a => a.toLowerCase());
        const correct = input === target || aliases.includes(input);
        if (correct) {
            this.spellInput.removeClass('wrong');
            this.spellInput.addClass('correct');
            this.feedbackEl.textContent = '✓ 拼写正确';
            this.feedbackEl.removeClass('wrong');
            this.feedbackEl.addClass('correct');
        } else {
            this.spellInput.removeClass('correct');
            this.spellInput.addClass('wrong');
            this.feedbackEl.textContent = `✗ 正确拼写：${word.word}`;
            this.feedbackEl.removeClass('correct');
            this.feedbackEl.addClass('wrong');
        }
    }

    private next() {
        if (this.currentIndex >= this.queue.length - 1) {
            this.renderEndScreen();
            return;
        }
        this.currentIndex++;
        this.renderCurrent();
    }

    private playAudio() {
        const word = this.currentWord;
        if (!word) return;
        void playWordTTS(this.app, this.plugin.hiwordsSettings, word.word, word);
    }

    private renderEndScreen() {
        const total = this.correctCount + this.wrongCount;
        const accuracy = total > 0 ? Math.round((this.correctCount / total) * 100) : 0;

        this.cardEl.removeClass('reveal');
        this.cardEl.empty();

        const result = this.cardEl.createDiv({ cls: 'spelling-result' });
        result.createDiv({ cls: 'spelling-result-title', text: '练习完成！' });
        result.createDiv({
            cls: 'spelling-result-stats',
            text: `共练习 ${total} 词 · 正确 ${this.correctCount} · 错误 ${this.wrongCount}`
        });
        const accuracyEl = result.createDiv({ cls: 'spelling-result-accuracy' });
        accuracyEl.textContent = `${accuracy}%`;
        result.createDiv({ cls: 'spelling-result-accuracy-label', text: '正确率' });

        // 错误单词列表
        if (this.wrongWords.length > 0) {
            const wrongSection = result.createDiv({ cls: 'spelling-wrong-section' });
            wrongSection.createDiv({ cls: 'spelling-wrong-title', text: `拼写错误单词（${this.wrongWords.length}）` });
            const wrongList = wrongSection.createDiv({ cls: 'spelling-wrong-list' });
            for (const w of this.wrongWords) {
                wrongList.createDiv({ cls: 'spelling-wrong-item', text: w.word });
            }

            // 重练错误单词
            const retryBtn = result.createEl('button', {
                cls: 'mod-cta spelling-retry-btn',
                text: '重练错误单词'
            });
            this.registerDomEvent(retryBtn, 'click', () => {
                let queue = this.shuffle([...this.wrongWords]);
                if (this.maxCount > 0) queue = queue.slice(0, this.maxCount);
                this.queue = queue;
                this.currentIndex = 0;
                this.correctCount = 0;
                this.wrongCount = 0;
                this.wrongWords = [];
                this.cardEl.empty();
                this.rebuildCard();
                this.renderCurrent();
            });
        }

        const closeBtn = result.createEl('button', { cls: 'spelling-close-btn-bottom', text: '关闭' });
        this.registerDomEvent(closeBtn, 'click', () => this.close());

        this.spellInput.disabled = true;
        this.nextBtnEl.style.display = 'none';
        this.updateStats();
    }

    /** 重练时重建卡片 DOM */
    private rebuildCard() {
        const defWrap = this.cardEl.createDiv({ cls: 'spelling-definition-wrap' });
        this.definitionEl = defWrap.createDiv({ cls: 'spelling-definition' });
        this.phoneticEl = defWrap.createDiv({ cls: 'spelling-phonetic' });

        const speakBtn = this.cardEl.createDiv({ cls: 'spelling-speak-btn' });
        const speakIcon = speakBtn.createDiv({ cls: 'spelling-speak-icon' });
        setIcon(speakIcon, 'volume-2');
        this.registerDomEvent(speakBtn, 'click', () => this.playAudio());

        const inputSection = this.cardEl.createDiv({ cls: 'spelling-input-section' });
        this.spellInput = inputSection.createEl('input', {
            type: 'text',
            cls: 'spelling-input',
            placeholder: '输入单词拼写，按回车提交',
        });
        this.spellInput.setAttribute('autocomplete', 'off');
        this.spellInput.setAttribute('autocapitalize', 'off');
        this.spellInput.setAttribute('spellcheck', 'false');
        this.feedbackEl = inputSection.createDiv({ cls: 'spelling-feedback' });
        this.nextBtnEl = inputSection.createEl('button', {
            cls: 'spelling-next-btn',
            text: '下一题'
        });
        this.nextBtnEl.style.display = 'none';

        this.definitionDetailEl = this.cardEl.createDiv({ cls: 'spelling-definition-detail' });
        this.definitionDetailEl.style.display = 'none';

        this.registerDomEvent(this.spellInput, 'keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Enter' && !evt.isComposing) {
                evt.preventDefault();
                if (this.checked) {
                    // 判定后：只有用户没有再修改输入框才跳转；重新输入则回车重新判定反馈（统计仍以第一次为准）
                    if (!this.userModifiedAfterCheck) {
                        this.next();
                    } else {
                        this.recheckSpell();
                    }
                } else {
                    this.checkSpell();
                }
            }
        });
        this.registerDomEvent(this.spellInput, 'input', () => {
            this.spellInput.removeClass('correct', 'wrong');
            if (this.checked) {
                this.userModifiedAfterCheck = true;
            }
            this.feedbackEl.textContent = '';
        });
        this.registerDomEvent(this.nextBtnEl, 'click', () => this.next());
    }

    // 从释义文本中提取中文含义片段
    private extractChineseMeaning(text: string): string {
        if (!text) return '';
        const segments = text.match(/[\u4e00-\u9fff]+(?:[，。、；：""''（）·…\s][\u4e00-\u9fff]+)*/g) || [];
        let best = '';
        for (const seg of segments) {
            const cleaned = seg.replace(/\s+/g, ' ').trim();
            if (cleaned.length > best.length) best = cleaned;
        }
        return best;
    }

    registerDomEvent<K extends keyof WindowEventMap>(el: Window, type: K, callback: (this: HTMLElement, ev: WindowEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    registerDomEvent<K extends keyof DocumentEventMap>(el: Document, type: K, callback: (this: HTMLElement, ev: DocumentEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    registerDomEvent<K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, callback: (this: HTMLElement, ev: HTMLElementEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    registerDomEvent(el: any, type: any, callback: any, options?: any): void {
        this.domEventComponent.registerDomEvent(el, type, callback, options);
    }

    onClose() {
        this.domEventComponent.unload();
        this.contentEl.empty();
        this.modalEl.removeClass('spelling-modal');
    }
}

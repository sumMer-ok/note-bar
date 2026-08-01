import { App, Modal, MarkdownRenderer, MarkdownView, setIcon } from 'obsidian';
import type NoteBarPlugin from '../../main';
import type { StudyProgressItem, FlashcardSettings, WordDefinition } from '../utils';
import { playWordTTS } from '../utils';
import { buildFlashcardQueue, type FlashcardQueueItem, type FlashcardSessionMode } from '../core/flashcard-queue';
import { applyReviewRating, type FlashcardRating } from '../core/flashcard-algorithm';

export type FlashcardMode = 'word-to-definition' | 'definition-to-word';

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_FLASHCARD_SETTINGS: FlashcardSettings = {
    defaultMode: 'word-to-definition',
    newWordSteps: 2,
    masteredThreshold: { reps: 3, minEf: 2.5 },
    dailyNewWordLimit: 20,
    dailyReviewLimit: 50,
    studyOrder: 'review-first',
    syncMasteredToCanvas: true,
    enableAnimation: true,
};

export class FlashcardReviewModal extends Modal {
    private plugin: NoteBarPlugin;
    private settings: FlashcardSettings;
    private mode: FlashcardMode;
    private queue: FlashcardQueueItem[];
    private selectedBookPaths: string[];
    private sessionMode: FlashcardSessionMode;
    private currentIndex = 0;
    private flipped = false;
    private animating = false;
    private stats = { total: 0, new: 0, mastered: 0 };

    private headerEl: HTMLElement;
    private bodyEl: HTMLElement;
    private footerEl: HTMLElement;
    private cardEl: HTMLElement;
    private frontWordEl: HTMLElement;
    private frontPhoneticEl: HTMLElement;
    private backWordEl: HTMLElement;
    private backPhoneticEl: HTMLElement;
    private backNotesEl: HTMLElement;
    private spellInput: HTMLInputElement;
    private spellFeedback: HTMLElement;
    private progressEl: HTMLElement;
    private endScreenEl: HTMLElement;
    private toastEl: HTMLElement;
    private boundKeyDown: (evt: KeyboardEvent) => void;
    private slideTimeout: number | null = null;
    private toastTimeout: number | null = null;

    constructor(app: App, plugin: NoteBarPlugin, selectedBookPaths: string[], sessionMode: FlashcardSessionMode = 'all') {
        super(app);
        this.plugin = plugin;
        this.settings = { ...DEFAULT_FLASHCARD_SETTINGS, ...plugin.hiwordsSettings.flashcard };
        this.mode = this.settings.defaultMode;

        this.selectedBookPaths = selectedBookPaths;
        this.sessionMode = sessionMode;

        const vocabularyManager = plugin.vocabularyManager;
        const studyItems = vocabularyManager?.getStudyItems() || [];
        const progress = plugin.hiwordsSettings.studyProgress || {};
        this.queue = buildFlashcardQueue(studyItems, selectedBookPaths, progress, this.settings, sessionMode);
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass('mod-note-bar-flashcard');
        if (!this.settings.enableAnimation) {
            modalEl.addClass('no-animation');
        }
        contentEl.empty();
        contentEl.addClass('flashcard-modal-content');

        if (this.queue.length === 0) {
            this.renderEmptyState(contentEl);
            return;
        }

        this.headerEl = contentEl.createDiv({ cls: 'flashcard-header' });
        this.bodyEl = contentEl.createDiv({ cls: 'flashcard-body' });
        this.footerEl = contentEl.createDiv({ cls: 'flashcard-footer' });

        this.toastEl = this.bodyEl.createDiv({ cls: 'flashcard-toast' });
        this.renderHeader();
        this.renderCardScene();
        this.renderEndScreen();
        this.renderFooter();

        this.renderCard();

        this.boundKeyDown = (evt: KeyboardEvent) => this.onKeyDown(evt);
        document.addEventListener('keydown', this.boundKeyDown);
    }

    onClose() {
        if (this.slideTimeout !== null) {
            activeWindow.clearTimeout(this.slideTimeout);
            this.slideTimeout = null;
        }
        if (this.toastTimeout !== null) {
            activeWindow.clearTimeout(this.toastTimeout);
            this.toastTimeout = null;
        }
        if (this.boundKeyDown) {
            document.removeEventListener('keydown', this.boundKeyDown);
        }
        this.contentEl.empty();
    }

    private renderEmptyState(container: HTMLElement) {
        container.createEl('h3', { text: '暂无复习内容', cls: 'flashcard-empty-title' });
        container.createEl('p', {
            text: '所选单词本没有今日到期或新词。',
            cls: 'flashcard-empty-text'
        });
        const closeBtn = container.createEl('button', {
            text: '关闭',
            cls: 'flashcard-primary-btn'
        });
        closeBtn.onclick = () => this.close();
    }

    private renderHeader() {
        this.headerEl.empty();

        const modeToggle = this.headerEl.createDiv({ cls: 'flashcard-mode-toggle' });

        const wordModeBtn = modeToggle.createEl('button', {
            cls: `flashcard-mode-btn ${this.mode === 'word-to-definition' ? 'active' : ''}`,
            text: '英→中'
        });
        wordModeBtn.onclick = () => this.setMode('word-to-definition');

        const defModeBtn = modeToggle.createEl('button', {
            cls: `flashcard-mode-btn ${this.mode === 'definition-to-word' ? 'active' : ''}`,
            text: '中→英'
        });
        defModeBtn.onclick = () => this.setMode('definition-to-word');

        this.progressEl = this.headerEl.createDiv({ cls: 'flashcard-progress' });

        const closeBtn = this.headerEl.createEl('button', {
            cls: 'flashcard-close-btn',
            text: '×'
        });
        closeBtn.onclick = () => this.close();
    }

    private renderCardScene() {
        const scene = this.bodyEl.createDiv({ cls: 'flashcard-card-scene' });
        this.cardEl = scene.createDiv({ cls: 'flashcard-card' });

        const front = this.cardEl.createDiv({ cls: 'flashcard-card-face flashcard-card-face-front' });
        this.frontWordEl = front.createDiv({ cls: 'flashcard-word' });
        this.frontPhoneticEl = front.createDiv({ cls: 'flashcard-phonetic' });

        const speakBtn = front.createEl('button', {
            cls: 'flashcard-speak-btn',
            attr: { 'aria-label': '播放发音' }
        });
        setIcon(speakBtn, 'volume-2');
        speakBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.playAudio();
        });

        const spellSection = front.createDiv({ cls: 'flashcard-spell-section' });
        this.spellInput = spellSection.createEl('input', {
            type: 'text',
            cls: 'flashcard-spell-input',
            placeholder: '输入单词后按回车检查拼写',
            attr: { autocomplete: 'off' }
        });
        this.spellInput.addEventListener('click', (e) => e.stopPropagation());
        this.spellInput.addEventListener('input', () => {
            this.spellInput.removeClass('correct', 'wrong');
            this.spellFeedback.textContent = '';
        });
        this.spellFeedback = spellSection.createDiv({ cls: 'flashcard-spell-feedback' });

        front.createDiv({
            cls: 'flashcard-flip-hint',
            text: '按 空格 或点击卡片翻转'
        });

        const back = this.cardEl.createDiv({ cls: 'flashcard-card-face flashcard-card-face-back' });
        const backHeader = back.createDiv({ cls: 'flashcard-back-header' });
        const backTitle = backHeader.createDiv();
        this.backWordEl = backTitle.createDiv({ cls: 'flashcard-back-word' });
        this.backPhoneticEl = backTitle.createDiv({ cls: 'flashcard-back-phonetic' });
        this.backNotesEl = back.createDiv({ cls: 'flashcard-notes' });

        this.cardEl.addEventListener('click', () => this.flip());
    }

    private renderEndScreen() {
        this.endScreenEl = this.bodyEl.createDiv({ cls: 'flashcard-end-screen' });
        this.endScreenEl.createDiv({ cls: 'flashcard-end-title', text: '本轮复习完成' });

        const stats = this.endScreenEl.createDiv({ cls: 'flashcard-end-stats' });
        stats.innerHTML = `
            <div class="flashcard-end-stat"><strong class="flashcard-stat-total">0</strong>复习单词</div>
            <div class="flashcard-end-stat"><strong class="flashcard-stat-new">0</strong>新词</div>
            <div class="flashcard-end-stat"><strong class="flashcard-stat-mastered">0</strong>已掌握</div>
        `;

        const actions = this.endScreenEl.createDiv({ cls: 'flashcard-end-actions' });
        const restartBtn = actions.createEl('button', {
            cls: 'flashcard-primary-btn',
            text: '再复习一组'
        });
        restartBtn.onclick = () => this.restart();

        const finishBtn = actions.createEl('button', {
            cls: 'flashcard-secondary-btn',
            text: '完成'
        });
        finishBtn.onclick = () => this.close();
    }

    private renderFooter() {
        this.footerEl.empty();

        const ratingRow = this.footerEl.createDiv({ cls: 'flashcard-rating-row' });

        const againBtn = ratingRow.createEl('button', {
            cls: 'flashcard-rating-btn flashcard-rating-btn-again',
            text: '不认识',
            attr: { 'data-key': 's' }
        });
        againBtn.onclick = () => this.rate('again');

        const hardBtn = ratingRow.createEl('button', {
            cls: 'flashcard-rating-btn flashcard-rating-btn-hard',
            text: '模糊',
            attr: { 'data-key': 'd' }
        });
        hardBtn.onclick = () => this.rate('hard');

        const goodBtn = ratingRow.createEl('button', {
            cls: 'flashcard-rating-btn flashcard-rating-btn-good',
            text: '认识',
            attr: { 'data-key': 'f' }
        });
        goodBtn.onclick = () => this.rate('good');

        const easyBtn = this.footerEl.createEl('button', {
            cls: 'flashcard-super-easy-btn',
            text: '太简单'
        });
        easyBtn.onclick = () => this.rate('easy');

        const hint = this.footerEl.createDiv({ cls: 'flashcard-hint' });
        hint.innerHTML = `
            <span><kbd>空格</kbd> 翻转</span>
            <span><kbd>s</kbd> 不认识</span>
            <span><kbd>d</kbd> 模糊</span>
            <span><kbd>f</kbd> 认识</span>
        `;
    }

    private async renderCard() {
        if (this.currentIndex >= this.queue.length) return;

        const item = this.queue[this.currentIndex];
        const wordDef = item.primary;

        this.spellInput.value = '';
        this.spellInput.removeClass('correct', 'wrong');
        this.spellFeedback.textContent = '';

        const phonetic = wordDef.card?.phonetic || '';

        if (this.mode === 'word-to-definition') {
            this.frontWordEl.textContent = wordDef.word;
            this.frontWordEl.removeClass('flashcard-definition-front');
            this.frontPhoneticEl.style.display = 'block';
            this.frontPhoneticEl.textContent = phonetic;
        } else {
            const raw = this.extractDefinition(wordDef.definition);
            this.frontWordEl.textContent = this.maskWordInDefinition(raw, wordDef.word, wordDef.aliases);
            this.frontWordEl.addClass('flashcard-definition-front');
            this.frontPhoneticEl.style.display = 'none';
        }

        this.backWordEl.textContent = wordDef.word;
        this.backPhoneticEl.textContent = phonetic;

        this.backNotesEl.empty();
        const content = wordDef.rawDefinition || wordDef.definition || '暂无释义';
        const leaf = this.app.workspace.getMostRecentLeaf();
        const activeView = leaf?.view instanceof MarkdownView ? leaf.view : null;
        const sourcePath = (activeView && activeView.file?.path) || this.app.workspace.getActiveFile()?.path || '';

        try {
            await MarkdownRenderer.render(this.app, content, this.backNotesEl, sourcePath, this.plugin);
        } catch (e) {
            this.backNotesEl.textContent = content;
        }

        this.updateProgress();
    }

    private updateProgress() {
        this.progressEl.textContent = `${this.currentIndex + 1} / ${this.queue.length}`;
    }

    private extractDefinition(definition: string): string {
        const match = definition.match(/\*\*[^*]+\*\*\s*[^\n]+/);
        if (match) return match[0].replace(/\*\*/g, '');
        const firstLine = definition.split('\n')[0];
        return firstLine || definition;
    }

    private maskWordInDefinition(definition: string, word: string, aliases: string[] = []): string {
        const targets = [word, ...aliases].filter(Boolean);
        if (targets.length === 0) return definition;
        const pattern = new RegExp('\\b(' + targets.map(escapeRegExp).join('|') + ')\\b', 'gi');
        return definition.replace(pattern, '___');
    }

    private setMode(mode: FlashcardMode) {
        if (this.mode === mode) return;
        this.mode = mode;
        this.flipped = false;
        this.cardEl.removeClass('flipped');
        this.renderHeader();
        void this.renderCard();
    }

    private flip() {
        if (this.animating) return;
        this.flipped = !this.flipped;
        this.cardEl.toggleClass('flipped', this.flipped);
    }

    private playAudio() {
        const item = this.queue[this.currentIndex];
        if (!item) return;
        void playWordTTS(this.app, this.plugin.hiwordsSettings, item.primary.word, item.primary);
    }

    private checkSpell() {
        const item = this.queue[this.currentIndex];
        const input = this.spellInput.value.trim().toLowerCase();
        const target = item.primary.word.toLowerCase();
        const aliases = item.primary.aliases?.map(a => a.toLowerCase()) || [];
        const correct = input === target || aliases.includes(input);

        this.spellInput.removeClass('correct', 'wrong');
        if (correct) {
            this.spellInput.addClass('correct');
            this.spellFeedback.textContent = '✓ 拼写正确';
        } else {
            this.spellInput.addClass('wrong');
            this.spellFeedback.textContent = `✗ 正确拼写：${item.primary.word}`;
        }
    }

    private async rate(rating: FlashcardRating) {
        if (this.animating || this.currentIndex >= this.queue.length) return;
        this.animating = true;

        const item = this.queue[this.currentIndex];
        const { progress, mastered } = applyReviewRating(item.progress, rating, this.settings);
        item.progress = progress;

        await this.saveProgress(item, rating);

        if (mastered && this.settings.syncMasteredToCanvas) {
            await this.syncMastered(item);
        }

        this.stats.total++;
        if (item.isNew) this.stats.new++;
        if (mastered) this.stats.mastered++;

        const direction = (rating === 'good' || rating === 'easy') ? 'right' : 'left';
        this.showToast(`${this.ratingLabel(rating)} · 已记录`);
        this.cardEl.addClass(direction === 'right' ? 'slide-out-right' : 'slide-out-left');

        this.slideTimeout = activeWindow.setTimeout(() => {
            this.currentIndex++;
            if (this.currentIndex >= this.queue.length) {
                this.showEnd();
                return;
            }

            this.flipped = false;
            this.cardEl.removeClass('flipped', 'slide-out-right', 'slide-out-left');
            this.cardEl.addClass('slide-in');

            void this.renderCard().then(() => {
                this.slideTimeout = activeWindow.setTimeout(() => {
                    this.cardEl.removeClass('slide-in');
                    this.animating = false;
                }, 550);
            });
        }, 450);
    }

    private async saveProgress(item: FlashcardQueueItem, rating: FlashcardRating) {
        const settings = this.plugin.hiwordsSettings;
        if (!settings.studyProgress) settings.studyProgress = {};

        const history = item.progress.history || [];
        const record: import('../utils').ReviewRecord = {
            date: new Date().toISOString(),
            quality: rating
        };

        settings.studyProgress[item.studyKey] = {
            ...item.progress,
            history: [...history, record].slice(-50)
        };

        await this.plugin.saveHiWordsSettings();
    }

    private async syncMastered(item: FlashcardQueueItem) {
        const masteredService = this.plugin.masteredService;
        if (!masteredService || !this.plugin.hiwordsSettings.enableMasteredFeature) return;

        for (const source of item.studyItem.sources) {
            // .hiwords 文件只读，无法同步掌握状态
            if (source.source.endsWith('.hiwords')) continue;
            await masteredService.markWordAsMastered(source.source, source.nodeId, source.word);
        }
    }

    private showEnd() {
        const scene = this.bodyEl.querySelector('.flashcard-card-scene');
        if (scene) (scene as HTMLElement).addClass('hide');
        this.footerEl.addClass('hide');

        this.endScreenEl.addClass('show');
        const totalEl = this.endScreenEl.querySelector('.flashcard-stat-total');
        const newEl = this.endScreenEl.querySelector('.flashcard-stat-new');
        const masteredEl = this.endScreenEl.querySelector('.flashcard-stat-mastered');
        if (totalEl) totalEl.setText(String(this.stats.total));
        if (newEl) newEl.setText(String(this.stats.new));
        if (masteredEl) masteredEl.setText(String(this.stats.mastered));

        this.animating = false;
    }

    private restart() {
        const vocabularyManager = this.plugin.vocabularyManager;
        const studyItems = vocabularyManager?.getStudyItems() || [];
        const progress = this.plugin.hiwordsSettings.studyProgress || {};
        this.queue = buildFlashcardQueue(studyItems, this.selectedBookPaths, progress, this.settings, this.sessionMode);

        this.currentIndex = 0;
        this.flipped = false;
        this.stats = { total: 0, new: 0, mastered: 0 };

        this.endScreenEl.removeClass('show');
        this.cardEl.removeClass('flipped');

        const scene = this.bodyEl.querySelector('.flashcard-card-scene');
        if (scene) (scene as HTMLElement).removeClass('hide');
        this.footerEl.removeClass('hide');

        if (this.queue.length === 0) {
            this.showEnd();
            return;
        }

        void this.renderCard();
    }

    private showToast(message: string) {
        this.toastEl.textContent = message;
        this.toastEl.addClass('show');
        this.toastTimeout = activeWindow.setTimeout(() => {
            this.toastEl.removeClass('show');
        }, 1600);
    }

    private ratingLabel(rating: FlashcardRating): string {
        switch (rating) {
            case 'again': return '不认识';
            case 'hard': return '模糊';
            case 'good': return '认识';
            case 'easy': return '太简单';
        }
    }

    private onKeyDown(evt: KeyboardEvent) {
        if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
        if (this.animating) return;

        if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLTextAreaElement) {
            if (evt.key === 'Enter' && evt.target === this.spellInput) {
                evt.preventDefault();
                this.checkSpell();
            }
            return;
        }

        switch (evt.key) {
            case ' ':
            case 'Spacebar':
                evt.preventDefault();
                this.flip();
                break;
            case 'f':
            case 'F':
                evt.preventDefault();
                this.rate('good');
                break;
            case 'd':
            case 'D':
                evt.preventDefault();
                this.rate('hard');
                break;
            case 's':
            case 'S':
                evt.preventDefault();
                this.rate('again');
                break;
        }
    }
}

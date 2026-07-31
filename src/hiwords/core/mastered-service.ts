import { Notice } from 'obsidian';
import type NoteBarPlugin from '../../main';
import { VocabularyManager } from './vocabulary-manager';
import { MasteredGroupManager } from '../canvas/mastered-group-manager';
import type { WordDefinition } from '../utils';

export class MasteredService {
    private plugin: NoteBarPlugin;
    private vocabularyManager: VocabularyManager;
    private masteredGroupManager: MasteredGroupManager;

    constructor(plugin: NoteBarPlugin, vocabularyManager: VocabularyManager) {
        this.plugin = plugin;
        this.vocabularyManager = vocabularyManager;
        this.masteredGroupManager = new MasteredGroupManager(plugin.app, plugin.hiwordsSettings);
    }

    updateSettings() {
        this.masteredGroupManager.updateSettings(this.plugin.hiwordsSettings);
    }

    get isEnabled(): boolean {
        return this.plugin.hiwordsSettings.enableMasteredFeature;
    }

    async markWordAsMastered(bookPath: string, nodeId: string, word: string): Promise<boolean> {
        if (!this.isEnabled) {
            new Notice('已掌握功能未启用');
            return false;
        }

        try {
            const mode = this.plugin.hiwordsSettings.masteredDetection ?? 'group';
            const isHiWordsPack = bookPath.endsWith('.hiwords');

            const success = await this.updateWordMasteredStatus(bookPath, nodeId, true);
            if (!success) {
                new Notice('更新单词状态失败');
                return false;
            }

            if (isHiWordsPack) {
                const wordDef = await this.vocabularyManager.getWordDefinitionByNodeId(bookPath, nodeId);
                await this.saveStudyProgress(wordDef, true);
                if (wordDef?.studyKey) {
                    this.vocabularyManager.updateStudyKeyMasteredStatus(wordDef.studyKey, true);
                }
                this.plugin.refreshHighlighter();
                this.plugin.app.workspace.trigger('hi-words:mastered-changed');
                new Notice(`"${word}" 已标记为已掌握`);
                return true;
            }

            if (mode === 'group') {
                const moveSuccess = await this.masteredGroupManager.moveToMasteredGroup(bookPath, nodeId);
                if (!moveSuccess) {
                    await this.updateWordMasteredStatus(bookPath, nodeId, false);
                    new Notice('移动到已掌握分组失败');
                    return false;
                }
            } else {
                const colorSuccess = await this.vocabularyManager.setNodeColor(bookPath, nodeId, 4);
                if (!colorSuccess) {
                    await this.updateWordMasteredStatus(bookPath, nodeId, false);
                    new Notice('更新单词状态失败');
                    return false;
                }
            }

            this.plugin.refreshHighlighter();
            this.plugin.app.workspace.trigger('hi-words:mastered-changed');
            new Notice(`"${word}" 已标记为已掌握`);

            return true;
        } catch (error) {
            console.error('标记已掌握失败:', error);
            new Notice('标记已掌握失败');
            return false;
        }
    }

    async unmarkWordAsMastered(bookPath: string, nodeId: string, word: string): Promise<boolean> {
        if (!this.isEnabled) {
            new Notice('已掌握功能未启用');
            return false;
        }

        try {
            const mode = this.plugin.hiwordsSettings.masteredDetection ?? 'group';
            const isHiWordsPack = bookPath.endsWith('.hiwords');

            const success = await this.updateWordMasteredStatus(bookPath, nodeId, false);
            if (!success) {
                new Notice('更新单词状态失败');
                return false;
            }

            if (isHiWordsPack) {
                const wordDef = await this.vocabularyManager.getWordDefinitionByNodeId(bookPath, nodeId);
                await this.saveStudyProgress(wordDef, false);
                if (wordDef?.studyKey) {
                    this.vocabularyManager.updateStudyKeyMasteredStatus(wordDef.studyKey, false);
                }
                this.plugin.refreshHighlighter();
                this.plugin.app.workspace.trigger('hi-words:mastered-changed');
                new Notice(`"${word}" 已取消已掌握标记`);
                return true;
            }

            if (mode === 'group') {
                const removeSuccess = await this.masteredGroupManager.removeFromMasteredGroup(bookPath, nodeId);
                if (!removeSuccess) {
                    await this.updateWordMasteredStatus(bookPath, nodeId, true);
                    new Notice('从已掌握分组移除失败');
                    return false;
                }
            } else {
                const colorSuccess = await this.vocabularyManager.setNodeColor(bookPath, nodeId, undefined);
                if (!colorSuccess) {
                    await this.updateWordMasteredStatus(bookPath, nodeId, true);
                    new Notice('更新单词状态失败');
                    return false;
                }
            }

            this.plugin.refreshHighlighter();
            this.plugin.app.workspace.trigger('hi-words:mastered-changed');
            new Notice(`"${word}" 已取消已掌握标记`);

            return true;
        } catch (error) {
            console.error('取消已掌握标记失败:', error);
            new Notice('取消已掌握标记失败');
            return false;
        }
    }

    async isWordMastered(bookPath: string, nodeId: string): Promise<boolean> {
        if (!this.isEnabled) return false;

        try {
            const wordDef = await this.vocabularyManager.getWordDefinitionByNodeId(bookPath, nodeId);
            return wordDef?.mastered === true;
        } catch (error) {
            console.error('检查单词掌握状态失败:', error);
            return false;
        }
    }

    async getMasteredWords(bookPath?: string) {
        if (!this.isEnabled) return [];

        try {
            const allWords = await this.vocabularyManager.getAllWordDefinitions();

            return allWords.filter(wordDef => {
                if (!wordDef.mastered) return false;
                if (bookPath && wordDef.source !== bookPath) return false;
                return true;
            });
        } catch (error) {
            console.error('获取已掌握单词列表失败:', error);
            return [];
        }
    }

    async getMasteredStats() {
        if (!this.isEnabled) {
            return {
                totalMastered: 0,
                totalWords: 0,
                masteredPercentage: 0,
                byBook: {}
            };
        }

        try {
            const allWords = await this.vocabularyManager.getAllWordDefinitions();
            const masteredWords = allWords.filter(w => w.mastered);

            const byBook: { [bookPath: string]: { mastered: number, total: number } } = {};

            allWords.forEach(word => {
                if (!byBook[word.source]) {
                    byBook[word.source] = { mastered: 0, total: 0 };
                }
                byBook[word.source].total++;
                if (word.mastered) {
                    byBook[word.source].mastered++;
                }
            });

            return {
                totalMastered: masteredWords.length,
                totalWords: allWords.length,
                masteredPercentage: allWords.length > 0 ? (masteredWords.length / allWords.length) * 100 : 0,
                byBook
            };
        } catch (error) {
            console.error('获取已掌握统计信息失败:', error);
            return {
                totalMastered: 0,
                totalWords: 0,
                masteredPercentage: 0,
                byBook: {}
            };
        }
    }

    async batchMarkAsMastered(operations: Array<{ bookPath: string, nodeId: string, word: string }>): Promise<number> {
        if (!this.isEnabled) return 0;

        let successCount = 0;

        for (const op of operations) {
            const success = await this.markWordAsMastered(op.bookPath, op.nodeId, op.word);
            if (success) successCount++;
        }

        if (successCount > 0) {
            new Notice(`成功批量标记 ${successCount} 个单词为已掌握`);
        }

        return successCount;
    }

    private async updateWordMasteredStatus(bookPath: string, nodeId: string, mastered: boolean): Promise<boolean> {
        try {
            const wordDef = await this.vocabularyManager.getWordDefinitionByNodeId(bookPath, nodeId);
            if (!wordDef) {
                console.error(`未找到单词定义: ${nodeId}`);
                return false;
            }

            wordDef.mastered = mastered;
            await this.vocabularyManager.updateWordDefinition(bookPath, nodeId, wordDef);

            return true;
        } catch (error) {
            console.error('更新单词掌握状态失败:', error);
            return false;
        }
    }

    private async saveStudyProgress(wordDef: WordDefinition | null, mastered: boolean): Promise<void> {
        if (!wordDef?.studyKey) return;

        if (!this.plugin.hiwordsSettings.studyProgress) {
            this.plugin.hiwordsSettings.studyProgress = {};
        }

        const existing = this.plugin.hiwordsSettings.studyProgress[wordDef.studyKey];
        const now = new Date().toISOString();

        if (!mastered) {
            if (existing) {
                this.plugin.hiwordsSettings.studyProgress[wordDef.studyKey] = {
                    ...existing,
                    status: 'review',
                    updatedAt: now,
                };
            } else {
                delete this.plugin.hiwordsSettings.studyProgress[wordDef.studyKey];
            }
            await this.plugin.saveHiWordsSettings();
            return;
        }

        this.plugin.hiwordsSettings.studyProgress[wordDef.studyKey] = {
            ...(existing || {}),
            status: 'mastered',
            masteredAt: existing?.masteredAt || now,
            updatedAt: now,
        };
        await this.plugin.saveHiWordsSettings();
    }

    async syncMasteredStatus(bookPath: string): Promise<void> {
        if (!this.isEnabled) return;
        if (bookPath.endsWith('.hiwords')) return;

        try {
            const allWords = await this.vocabularyManager.getWordDefinitionsByBook(bookPath);
            const mode = this.plugin.hiwordsSettings.masteredDetection ?? 'group';

            for (const wordDef of allWords) {
                if (mode === 'group') {
                    const inMasteredGroup = await this.masteredGroupManager.isNodeInMasteredGroup(bookPath, wordDef.nodeId);
                    if (wordDef.mastered && !inMasteredGroup) {
                        await this.masteredGroupManager.moveToMasteredGroup(bookPath, wordDef.nodeId);
                    } else if (!wordDef.mastered && inMasteredGroup) {
                        await this.masteredGroupManager.removeFromMasteredGroup(bookPath, wordDef.nodeId);
                    }
                } else {
                    if (wordDef.mastered) {
                        await this.vocabularyManager.setNodeColor(bookPath, wordDef.nodeId, 4);
                    } else {
                        await this.vocabularyManager.setNodeColor(bookPath, wordDef.nodeId, undefined);
                    }
                }
            }
        } catch (error) {
            console.error('同步已掌握状态失败:', error);
        }
    }
}

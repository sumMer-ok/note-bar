import { App, TFile } from 'obsidian';
import type { CanvasData, CanvasNode, WordDefinition, WordSection, HiWordsSettings } from '../utils';
import { parsePhrase } from '../utils/pattern-matcher';

export class CanvasParser {
    private app: App;
    private settings?: HiWordsSettings;

    constructor(app: App, settings?: HiWordsSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: HiWordsSettings) {
        this.settings = settings;
    }

    private removeMarkdownFormatting(text: string): string {
        if (!text) return text;
        text = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1');
        text = text.replace(/\*(.*?)\*/g, '$1').replace(/_(.*?)_/g, '$1');
        text = text.replace(/`(.*?)`/g, '$1');
        text = text.replace(/~~(.*?)~~/g, '$1');
        text = text.replace(/==(.*?)==/g, '$1');
        text = text.replace(/\[(.*?)\]\(.*?\)/g, '$1');
        return text.trim();
    }

    private removeFrontmatter(text: string): string {
        if (!text) return text;
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        if (text.startsWith('---')) {
            const fmEnd = text.indexOf('\n---');
            if (fmEnd !== -1) {
                const after = text.slice(fmEnd + 4);
                return after.replace(/^\r?\n/, '');
            }
        }
        return text;
    }

    private parseSections(content: string): WordSection[] {
        if (!content) return [];
        const sectionTexts = content.split(/\n\s*---\s*\n/);
        const sections: WordSection[] = [];
        for (const sectionText of sectionTexts) {
            const trimmed = sectionText.trim();
            if (!trimmed) continue;
            const lines = trimmed.split('\n');
            const firstLine = lines[0].trim();
            const boldMatch = firstLine.match(/^\*\*(.+?)\*\*$/);
            if (boldMatch) {
                sections.push({ title: boldMatch[1].trim(), content: lines.slice(1).join('\n').trim() });
                continue;
            }
            sections.push({ title: sections.length === 0 ? '释义' : `内容 ${sections.length + 1}`, content: trimmed });
        }
        return sections;
    }

    async parseCanvasFile(file: TFile): Promise<WordDefinition[]> {
        try {
            const content = await this.app.vault.cachedRead(file);
            const canvasData: CanvasData = JSON.parse(content);
            const detectionMode = this.settings?.masteredDetection ?? 'group';
            const masteredGroup = detectionMode === 'group'
                ? canvasData.nodes.find(node => node.type === 'group' && (node.label === 'Mastered' || node.label === '已掌握'))
                : undefined;
            // 按添加日期分组（label 为 YYYY-MM-DD 的 group）
            const dateGroups = canvasData.nodes.filter(
                node => node.type === 'group' && /^\d{4}-\d{2}-\d{2}$/.test(node.label || '')
            );
            const definitions: WordDefinition[] = [];
            for (const node of canvasData.nodes) {
                if (node.type === 'text' && node.text) {
                    const wordDef = this.parseTextNode(node, file.path);
                    if (wordDef) {
                        if (detectionMode === 'group' && masteredGroup && this.isNodeInGroup(node, masteredGroup)) {
                            wordDef.mastered = true;
                        } else if (detectionMode === 'color' && node.color === '4') {
                            wordDef.mastered = true;
                        }
                        // 提取添加日期
                        for (const g of dateGroups) {
                            if (this.isNodeInGroup(node, g)) {
                                wordDef.addedDate = g.label;
                                break;
                            }
                        }
                        definitions.push(wordDef);
                    }
                } else if (node.type === 'file' && node.file) {
                    const wordDef = await this.parseFileNode(node, file.path);
                    if (wordDef) {
                        if (detectionMode === 'group' && masteredGroup && this.isNodeInGroup(node, masteredGroup)) {
                            wordDef.mastered = true;
                        } else if (detectionMode === 'color' && node.color === '4') {
                            wordDef.mastered = true;
                        }
                        // 提取添加日期
                        for (const g of dateGroups) {
                            if (this.isNodeInGroup(node, g)) {
                                wordDef.addedDate = g.label;
                                break;
                            }
                        }
                        definitions.push(wordDef);
                    }
                }
            }
            return definitions;
        } catch (error) {
            console.error(`Failed to parse canvas file ${file.path}:`, error);
            return [];
        }
    }

    private parseFromText(text: string, node: CanvasNode, sourcePath: string): WordDefinition | null {
        if (!text) return null;
        text = this.removeFrontmatter(text).trim();
        let word = '';
        const aliases: string[] = [];
        let definition = '';
        try {
            const lines = text.split('\n');
            if (lines.length === 0) return null;
            word = lines[0].replace(/^#+\s*/, '').trim();
            word = this.removeMarkdownFormatting(word);
            if (!word) return null;
            if (lines.length > 1) {
                let aliasLineIndex = -1;
                let definitionStartIndex = -1;
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith('*') && line.endsWith('*') && line.length > 2 && !line.startsWith('**') && !line.endsWith('**')) {
                        const aliasText = line.slice(1, -1);
                        const aliasArray = aliasText.split(',').map(a => a.trim()).filter(a => a);
                        aliases.push(...aliasArray);
                        aliasLineIndex = i;
                    } else if (line !== '') {
                        definitionStartIndex = i;
                        break;
                    }
                }
                if (definitionStartIndex > 0 && definitionStartIndex < lines.length) {
                    while (definitionStartIndex < lines.length && lines[definitionStartIndex].trim() === '') {
                        definitionStartIndex++;
                    }
                    if (definitionStartIndex < lines.length) {
                        definition = lines.slice(definitionStartIndex).join('\n').trim();
                    }
                } else if (aliasLineIndex === -1) {
                    definition = lines.slice(1).join('\n').trim();
                }
            }
            if (!word) return null;
            const phraseInfo = parsePhrase(word);
            const rawDefinition = definition;
            let sections: WordSection[] | undefined;
            if (definition && definition.includes('\n---\n')) {
                sections = this.parseSections(definition);
                if (sections.length > 0) definition = sections[0].content;
            }
            return {
                word: phraseInfo.isPattern ? phraseInfo.original : word.toLowerCase(),
                aliases: aliases.length > 0 ? aliases : undefined,
                definition,
                rawDefinition: rawDefinition || definition,
                sections,
                source: sourcePath,
                nodeId: node.id,
                color: node.color,
                isPattern: phraseInfo.isPattern,
                patternParts: phraseInfo.isPattern ? phraseInfo.parts : undefined
            };
        } catch (error) {
            console.error(`解析节点文本时出错: ${error}`);
            return null;
        }
    }

    private parseTextNode(node: CanvasNode, sourcePath: string): WordDefinition | null {
        if (!node.text) return null;
        return this.parseFromText(node.text, node, sourcePath);
    }

    private async parseFileNode(node: CanvasNode, sourcePath: string): Promise<WordDefinition | null> {
        try {
            const filePath = node.type === 'file' ? node.file : undefined;
            if (!filePath) return null;
            const abs = this.app.vault.getAbstractFileByPath(filePath);
            if (!(abs instanceof TFile)) return null;
            if (abs.extension !== 'md') return null;
            const mode = this.settings?.fileNodeParseMode || 'filename-with-alias';
            const fileName = abs.basename;
            if (mode === 'filename') {
                return { word: fileName, aliases: [], definition: '', source: sourcePath, nodeId: node.id, color: node.color, mastered: false };
            }
            const md = await this.app.vault.cachedRead(abs);
            if (mode === 'content') {
                return this.parseFromText(md, node, sourcePath);
            }
            if (mode === 'filename-with-alias') {
                const parsed = this.parseFromText(md, node, sourcePath);
                if (parsed && parsed.word) {
                    const originalWord = parsed.word;
                    const existingAliases = parsed.aliases || [];
                    const newAliases = originalWord !== fileName ? [originalWord, ...existingAliases] : existingAliases;
                    return { ...parsed, word: fileName, aliases: newAliases };
                }
                return { word: fileName, aliases: [], definition: '', source: sourcePath, nodeId: node.id, color: node.color, mastered: false };
            }
            return null;
        } catch (error) {
            console.error('解析文件节点失败:', error);
            return null;
        }
    }

    static isCanvasFile(file: TFile): boolean {
        return file.extension === 'canvas';
    }

    public isNodeInGroup(node: CanvasNode, group: CanvasNode): boolean {
        const nodeX = typeof node.x === 'number' ? node.x : 0;
        const nodeY = typeof node.y === 'number' ? node.y : 0;
        const nodeW = typeof node.width === 'number' ? node.width : 200;
        const nodeH = typeof node.height === 'number' ? node.height : 60;
        const groupX = typeof group.x === 'number' ? group.x : 0;
        const groupY = typeof group.y === 'number' ? group.y : 0;
        const groupW = typeof group.width === 'number' ? group.width : 300;
        const groupH = typeof group.height === 'number' ? group.height : 150;
        const nodeLeft = nodeX;
        const nodeRight = nodeX + nodeW;
        const nodeTop = nodeY;
        const nodeBottom = nodeY + nodeH;
        const groupLeft = groupX;
        const groupRight = groupX + groupW;
        const groupTop = groupY;
        const groupBottom = groupY + groupH;
        const isInside = nodeLeft >= groupLeft && nodeRight <= groupRight && nodeTop >= groupTop && nodeBottom <= groupBottom;
        if (!isInside) {
            const hasOverlap = nodeLeft < groupRight && nodeRight > groupLeft && nodeTop < groupBottom && nodeBottom > groupTop;
            if (hasOverlap) {
                const overlapLeft = Math.max(nodeLeft, groupLeft);
                const overlapRight = Math.min(nodeRight, groupRight);
                const overlapTop = Math.max(nodeTop, groupTop);
                const overlapBottom = Math.min(nodeBottom, groupBottom);
                const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
                const nodeArea = nodeW * nodeH;
                return overlapArea >= nodeArea * 0.5;
            }
            return false;
        }
        return true;
    }
}

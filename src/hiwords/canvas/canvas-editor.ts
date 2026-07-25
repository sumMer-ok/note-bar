import { App, TFile } from 'obsidian';
import type { CanvasData, CanvasNode, HiWordsSettings } from '../utils';
import { CanvasParser } from './canvas-parser';
import { layoutGroupInner, normalizeLayout } from './layout';

export class CanvasEditor {
    private app: App;
    private settings: HiWordsSettings;

    constructor(app: App, settings: HiWordsSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: HiWordsSettings) {
        this.settings = settings;
    }

    private genHex16(): string {
        const bytes = new Uint8Array(8);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    private getTodayGroupLabel(): string {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    private findOrCreateDateGroup(canvasData: CanvasData, cardWidth: number, cardHeight: number): CanvasNode {
        const groupPadding = 24;
        const groupGap = 40;
        const label = this.getTodayGroupLabel();
        let group = canvasData.nodes.find((n) => n.type === 'group' && n.label === label);

        if (!group) {
            let maxX = 0;
            for (const n of canvasData.nodes) {
                if (n.type === 'group') {
                    const right = (n.x ?? 0) + (n.width ?? 0);
                    if (right > maxX) maxX = right;
                }
            }
            const x = canvasData.nodes.length === 0 ? 0 : maxX + groupGap;
            group = {
                id: this.genHex16(),
                type: 'group',
                x,
                y: 0,
                width: groupPadding * 2 + cardWidth,
                height: groupPadding * 2 + cardHeight,
                label,
            };
            canvasData.nodes.push(group);
        }
        return group;
    }

    async addWordToCanvas(bookPath: string, word: string, definition: string, color?: number, aliases?: string[]): Promise<string | null> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!file || !(file instanceof TFile) || !CanvasParser.isCanvasFile(file)) {
                console.error(`无效的 Canvas 文件: ${bookPath}`);
                return null;
            }
            if (aliases) {
                aliases = aliases.filter((alias) => alias && alias.trim().length > 0);
                if (aliases.length === 0) aliases = undefined;
            }
            const parser = new CanvasParser(this.app, this.settings);
            let generatedNodeId = '';
            await this.app.vault.process(file, (current) => {
                const canvasData: CanvasData = JSON.parse(current || '{"nodes":[],"edges":[]}');
                if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];
                const nodeId = this.genHex16();
                generatedNodeId = nodeId;
                const newW = this.settings.cardWidth ?? 260;
                const newH = this.settings.cardHeight ?? 120;
                const groupPadding = 24;
                // 按添加日期分组
                const dateGroup = this.findOrCreateDateGroup(canvasData, newW, newH);

                let nodeText = word;
                if (aliases && aliases.length > 0) nodeText = `${word}\n*${aliases.join(', ')}*`;
                if (definition) nodeText = `${nodeText}\n\n${definition}`;
                const newNode: CanvasNode = {
                    id: nodeId,
                    type: 'text',
                    x: (dateGroup.x ?? 0) + groupPadding,
                    y: (dateGroup.y ?? 0) + groupPadding,
                    width: newW,
                    height: newH,
                    text: nodeText,
                    color: color !== undefined ? color.toString() : undefined,
                };
                canvasData.nodes.push(newNode);
                layoutGroupInner(canvasData, dateGroup, this.settings, parser);
                normalizeLayout(canvasData, this.settings, parser);
                return JSON.stringify(canvasData);
            });
            return generatedNodeId;
        } catch (error) {
            console.error(`添加词汇到 Canvas 失败: ${error}`);
            return null;
        }
    }

    async updateWordInCanvas(bookPath: string, nodeId: string, word: string, definition: string, color?: number, aliases?: string[]): Promise<boolean> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!file || !(file instanceof TFile) || !CanvasParser.isCanvasFile(file)) {
                console.error(`无效的 Canvas 文件: ${bookPath}`);
                return false;
            }
            if (aliases) {
                aliases = aliases.filter((alias) => alias && alias.trim().length > 0);
                if (aliases.length === 0) aliases = undefined;
            }
            let updated = false;
            const parser = new CanvasParser(this.app, this.settings);
            await this.app.vault.process(file, (current) => {
                const canvasData: CanvasData = JSON.parse(current || '{"nodes":[],"edges":[]}');
                if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];
                const index = canvasData.nodes.findIndex((n) => n.id === nodeId);
                if (index === -1) {
                    console.error(`未找到节点: ${nodeId}`);
                    return JSON.stringify(canvasData);
                }
                let nodeText = word;
                if (aliases && aliases.length > 0) nodeText = `${word}\n*${aliases.join(', ')}*`;
                if (definition) nodeText = `${nodeText}\n\n${definition}`;
                canvasData.nodes[index].text = nodeText;
                if (color !== undefined) canvasData.nodes[index].color = color.toString();
                normalizeLayout(canvasData, this.settings, parser);
                updated = true;
                return JSON.stringify(canvasData);
            });
            return updated;
        } catch (error) {
            console.error(`更新 Canvas 中的词汇失败: ${error}`);
            return false;
        }
    }

    async deleteWordFromCanvas(bookPath: string, nodeId: string): Promise<boolean> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!file || !(file instanceof TFile) || !CanvasParser.isCanvasFile(file)) {
                console.error(`无效的 Canvas 文件: ${bookPath}`);
                return false;
            }
            let removed = false;
            const parser = new CanvasParser(this.app, this.settings);
            await this.app.vault.process(file, (current) => {
                const canvasData: CanvasData = JSON.parse(current || '{"nodes":[],"edges":[]}');
                if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];
                const index = canvasData.nodes.findIndex((n) => n.id === nodeId);
                if (index === -1) {
                    console.warn(`未找到要删除的节点: ${nodeId}`);
                    return JSON.stringify(canvasData);
                }
                canvasData.nodes.splice(index, 1);
                normalizeLayout(canvasData, this.settings, parser);
                removed = true;
                return JSON.stringify(canvasData);
            });
            return removed;
        } catch (error) {
            console.error(`从 Canvas 中删除词汇失败: ${error}`);
            return false;
        }
    }

    async setNodeColor(bookPath: string, nodeId: string, color?: number): Promise<boolean> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!file || !(file instanceof TFile) || !CanvasParser.isCanvasFile(file)) {
                console.error(`无效的 Canvas 文件: ${bookPath}`);
                return false;
            }
            let updated = false;
            const parser = new CanvasParser(this.app, this.settings);
            await this.app.vault.process(file, (current) => {
                const canvasData: CanvasData = JSON.parse(current || '{"nodes":[],"edges":[]}');
                if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];
                const index = canvasData.nodes.findIndex((n) => n.id === nodeId);
                if (index === -1) {
                    console.error(`未找到节点: ${nodeId}`);
                    return JSON.stringify(canvasData);
                }
                if (color !== undefined) {
                    canvasData.nodes[index].color = color.toString();
                } else {
                    delete canvasData.nodes[index].color;
                }
                normalizeLayout(canvasData, this.settings, parser);
                updated = true;
                return JSON.stringify(canvasData);
            });
            return updated;
        } catch (error) {
            console.error(`设置节点颜色失败: ${error}`);
            return false;
        }
    }
}

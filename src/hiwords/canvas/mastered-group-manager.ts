import { App, TFile } from 'obsidian';
import { CanvasData, CanvasNode, HiWordsSettings } from '../utils';
import { CanvasParser } from './canvas-parser';
import { normalizeLayout, layoutGroupInner } from './layout';

export class MasteredGroupManager {
    private app: App;
    private canvasParser: CanvasParser;
    private settings: HiWordsSettings | undefined;
    private readonly MASTERED_GROUP_LABEL = 'Mastered';
    private readonly MASTERED_GROUP_COLOR = '4';

    constructor(app: App, settings?: HiWordsSettings) {
        this.app = app;
        this.canvasParser = new CanvasParser(app);
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

    async ensureMasteredGroup(bookPath: string): Promise<string | null> {
        try {
            const canvasData = await this.loadCanvas(bookPath);
            if (!canvasData) return null;

            const masteredGroup = canvasData.nodes.find(
                node => node.type === 'group' && node.label === this.MASTERED_GROUP_LABEL
            );

            if (!masteredGroup) {
                const newGroupId = this.genHex16();

                await this.modifyCanvas(bookPath, (data) => {
                    const group = this.createMasteredGroup(data);
                    group.id = newGroupId;
                    data.nodes.push(group);
                });

                return newGroupId;
            }

            return masteredGroup.id;
        } catch (error) {
            return null;
        }
    }

    async moveToMasteredGroup(bookPath: string, nodeId: string): Promise<boolean> {
        try {
            const masteredGroupId = await this.ensureMasteredGroup(bookPath);
            if (!masteredGroupId) return false;

            return await this.modifyCanvas(bookPath, (data) => {
                const targetNode = data.nodes.find(node => node.id === nodeId);
                const masteredGroup = data.nodes.find(node => node.id === masteredGroupId);

                if (!targetNode || !masteredGroup) {
                    return;
                }

                const success = this.moveNodeToGroupOptimizedSync(targetNode, masteredGroup, data);
                if (!success) {
                    return;
                }

                try {
                    if (this.settings) {
                        layoutGroupInner(data, masteredGroup, this.settings, this.canvasParser);
                        normalizeLayout(data, this.settings, this.canvasParser);
                    }
                } catch {
                    // Layout normalization is best-effort.
                }
            });
        } catch (error) {
            return false;
        }
    }

    async removeFromMasteredGroup(bookPath: string, nodeId: string): Promise<boolean> {
        try {
            return await this.modifyCanvas(bookPath, (data) => {
                const targetNode = data.nodes.find(node => node.id === nodeId);
                if (!targetNode) return;

                const masteredGroup = data.nodes.find(
                    node => node.type === 'group' && node.label === this.MASTERED_GROUP_LABEL
                );
                if (!masteredGroup) return;

                this.moveNodeOutOfGroupSync(targetNode, data);

                try {
                    if (this.settings) {
                        normalizeLayout(data, this.settings, this.canvasParser);
                    }
                } catch {
                    // Layout normalization is best-effort.
                }
            });
        } catch (error) {
            return false;
        }
    }

    async isNodeInMasteredGroup(bookPath: string, nodeId: string): Promise<boolean> {
        try {
            const canvasData = await this.loadCanvas(bookPath);
            if (!canvasData) return false;

            const targetNode = canvasData.nodes.find(node => node.id === nodeId);
            if (!targetNode) return false;

            const masteredGroup = canvasData.nodes.find(
                node => node.type === 'group' && node.label === this.MASTERED_GROUP_LABEL
            );
            if (!masteredGroup) return false;

            return this.canvasParser.isNodeInGroup(targetNode, masteredGroup);
        } catch (error) {
            return false;
        }
    }

    private createMasteredGroup(canvasData: CanvasData): CanvasNode {
        const groupId = this.genHex16();
        const { x, y } = this.calculateMasteredGroupPosition(canvasData);
        const initialWidth = 400;
        const initialHeight = 200;

        return {
            id: groupId,
            type: 'group',
            x: x,
            y: y,
            width: initialWidth,
            height: initialHeight,
            color: this.MASTERED_GROUP_COLOR,
            label: this.MASTERED_GROUP_LABEL
        };
    }

    private calculateMasteredGroupPosition(canvasData: CanvasData): { x: number, y: number } {
        const allNodes = canvasData.nodes.filter(node => node.type === 'text' || node.type === 'group');

        if (allNodes.length === 0) {
            return { x: 50, y: 50 };
        }

        const minX = Math.min(...allNodes.map(node => node.x));
        const maxX = Math.max(...allNodes.map(node => node.x + (node.width || 200)));
        const minY = Math.min(...allNodes.map(node => node.y));
        const maxY = Math.max(...allNodes.map(node => node.y + (node.height || 100)));

        const groupWidth = 800;
        const padding = 50;

        let x = maxX + padding;
        let y = minY;

        if (x + groupWidth > 3000) {
            x = minX;
            y = maxY + padding;
        }

        return { x, y };
    }

    private moveNodeToGroupOptimizedSync(
        node: CanvasNode,
        group: CanvasNode,
        canvasData: CanvasData
    ): boolean {
        try {
            const padding = 24;
            const cardW = 260;
            const cardH = 120;
            node.width = node.width || cardW;
            node.height = node.height || cardH;
            node.x = Math.max(group.x + padding, group.x);
            node.y = Math.max(group.y + padding, group.y);
            return true;
        } catch {
            return false;
        }
    }

    private moveNodeOutOfGroupSync(node: CanvasNode, canvasData: CanvasData): void {
        const masteredGroup = canvasData.nodes.find(
            n => n.type === 'group' && n.label === this.MASTERED_GROUP_LABEL
        );

        const freeTextNodes = canvasData.nodes.filter(n => {
            if (n.type !== 'text' || n.id === node.id) return false;
            if (!masteredGroup) return true;
            return !this.canvasParser.isNodeInGroup(n, masteredGroup);
        });

        const paddingX = 50;
        const paddingY = 20;
        const nodeHeight = node.height || 120;

        if (freeTextNodes.length === 0) {
            node.x = paddingX;
            node.y = paddingY;
            return;
        }

        const minX = Math.min(...freeTextNodes.map(n => n.x), paddingX);
        const maxY = Math.max(...freeTextNodes.map(n => n.y + (n.height || nodeHeight)), 0);
        node.x = minX;
        node.y = maxY + paddingY;

        if (masteredGroup) {
            const groupBottom = masteredGroup.y + masteredGroup.height;
            if (node.y < groupBottom + paddingY) {
                node.y = groupBottom + paddingY;
            }
        }
    }

    private getGroupMembers(group: CanvasNode, canvasData: CanvasData, excludeNodeId?: string): CanvasNode[] {
        return canvasData.nodes.filter(n =>
            n.id !== group.id &&
            n.id !== excludeNodeId &&
            n.type !== 'group' &&
            this.canvasParser.isNodeInGroup(n, group)
        );
    }

    private async loadCanvas(bookPath: string): Promise<CanvasData | null> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!(file instanceof TFile)) {
                return null;
            }

            const content = await this.app.vault.cachedRead(file);
            return JSON.parse(content) as CanvasData;
        } catch (error) {
            return null;
        }
    }

    private async modifyCanvas(
        bookPath: string,
        modifier: (data: CanvasData) => void
    ): Promise<boolean> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!(file instanceof TFile)) {
                return false;
            }

            await this.app.vault.process(file, (current) => {
                const data = JSON.parse(current) as CanvasData;
                modifier(data);
                return JSON.stringify(data);
            });
            return true;
        } catch (error) {
            return false;
        }
    }
}

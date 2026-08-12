import { App, TFile } from 'obsidian';
import { CanvasData, CanvasNode, HiWordsSettings } from '../utils';
import { CanvasParser } from './canvas-parser';
import { normalizeLayout, layoutGroupInner } from './layout';

/**
 * 分组管理器：负责把词条节点在 Canvas 的「分组」之间几何移动。
 * 支持两类分组（几何移动模式沿用同一套坐标计算与排版逻辑）：
 * - Mastered（已掌握 / Mastered）：由已掌握服务调用；
 * - Archived（已归档 / Archived）：由淘汰候选流程调用（淘汰/归档词移入）。
 * 对外保持原有 Mastered 相关 API 不变（mastered-service 依赖），
 * 内部统一走通用的分组操作，避免重复实现。
 */
export class MasteredGroupManager {
    private app: App;
    private canvasParser: CanvasParser;
    private settings: HiWordsSettings | undefined;
    private readonly MASTERED_GROUP_LABEL = 'Mastered';
    private readonly MASTERED_GROUP_ALT_LABEL = '已掌握';
    private readonly MASTERED_GROUP_COLOR = '4';
    private readonly ARCHIVED_GROUP_LABEL = 'Archived';
    private readonly ARCHIVED_GROUP_ALT_LABEL = '已归档';
    private readonly ARCHIVED_GROUP_COLOR = '5';

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

    // ===== 通用分组操作 =====

    /** 在 Canvas 数据中查找分组（兼容英文/中文 label） */
    private findGroup(canvasData: CanvasData, label: string, altLabel?: string): CanvasNode | undefined {
        return canvasData.nodes.find(
            node => node.type === 'group' && (node.label === label || (altLabel && node.label === altLabel))
        );
    }

    /**
     * 确保分组存在（不存在则先创建），返回分组 id。
     * 创建位置沿用原有 Mastered 分组的坐标计算逻辑（画布右侧/下方空白处）。
     */
    async ensureGroup(bookPath: string, label: string, altLabel: string | undefined, color: string): Promise<string | null> {
        try {
            const canvasData = await this.loadCanvas(bookPath);
            if (!canvasData) return null;

            const existing = this.findGroup(canvasData, label, altLabel);
            if (existing) return existing.id;

            const newGroupId = this.genHex16();
            await this.modifyCanvas(bookPath, (data) => {
                const group = this.createGroup(data, label, color);
                group.id = newGroupId;
                data.nodes.push(group);
            });

            return newGroupId;
        } catch (error) {
            return null;
        }
    }

    /** 创建新分组节点（几何位置沿用原有计算逻辑） */
    private createGroup(canvasData: CanvasData, label: string, color: string): CanvasNode {
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
            color: color,
            label: label
        };
    }

    /**
     * 把指定 nodeId 的节点几何移入指定分组（分组不存在则先创建）。
     * 沿用 moveToMasteredGroup 的坐标计算与 layoutGroupInner/normalizeLayout 排版逻辑。
     */
    async moveNodeToGroup(bookPath: string, nodeId: string, label: string, altLabel: string | undefined, color: string): Promise<boolean> {
        try {
            const groupId = await this.ensureGroup(bookPath, label, altLabel, color);
            if (!groupId) return false;

            return await this.modifyCanvas(bookPath, (data) => {
                const targetNode = data.nodes.find(node => node.id === nodeId);
                const group = data.nodes.find(node => node.id === groupId);

                if (!targetNode || !group) {
                    return;
                }

                const success = this.moveNodeToGroupOptimizedSync(targetNode, group, data);
                if (!success) {
                    return;
                }

                try {
                    if (this.settings) {
                        layoutGroupInner(data, group, this.settings, this.canvasParser);
                        normalizeLayout(data, this.settings, this.canvasParser);
                    }
                } catch {
                    // 布局规范化尽力而为
                }
            });
        } catch (error) {
            return false;
        }
    }

    /** 判断节点是否几何位于指定分组内 */
    async isNodeInGroup(bookPath: string, nodeId: string, label: string, altLabel?: string): Promise<boolean> {
        try {
            const canvasData = await this.loadCanvas(bookPath);
            if (!canvasData) return false;

            const targetNode = canvasData.nodes.find(node => node.id === nodeId);
            if (!targetNode) return false;

            const group = this.findGroup(canvasData, label, altLabel);
            if (!group) return false;

            return this.canvasParser.isNodeInGroup(targetNode, group);
        } catch (error) {
            return false;
        }
    }

    // ===== Mastered（已掌握）分组：保持原有 API 不变 =====

    async ensureMasteredGroup(bookPath: string): Promise<string | null> {
        return this.ensureGroup(bookPath, this.MASTERED_GROUP_LABEL, this.MASTERED_GROUP_ALT_LABEL, this.MASTERED_GROUP_COLOR);
    }

    async moveToMasteredGroup(bookPath: string, nodeId: string): Promise<boolean> {
        return this.moveNodeToGroup(bookPath, nodeId, this.MASTERED_GROUP_LABEL, this.MASTERED_GROUP_ALT_LABEL, this.MASTERED_GROUP_COLOR);
    }

    async removeFromMasteredGroup(bookPath: string, nodeId: string): Promise<boolean> {
        try {
            return await this.modifyCanvas(bookPath, (data) => {
                const targetNode = data.nodes.find(node => node.id === nodeId);
                if (!targetNode) return;

                const masteredGroup = this.findGroup(data, this.MASTERED_GROUP_LABEL, this.MASTERED_GROUP_ALT_LABEL);
                if (!masteredGroup) return;

                this.moveNodeOutOfGroupSync(targetNode, data, this.MASTERED_GROUP_LABEL, this.MASTERED_GROUP_ALT_LABEL);

                try {
                    if (this.settings) {
                        normalizeLayout(data, this.settings, this.canvasParser);
                    }
                } catch {
                    // 布局规范化尽力而为
                }
            });
        } catch (error) {
            return false;
        }
    }

    async isNodeInMasteredGroup(bookPath: string, nodeId: string): Promise<boolean> {
        return this.isNodeInGroup(bookPath, nodeId, this.MASTERED_GROUP_LABEL, this.MASTERED_GROUP_ALT_LABEL);
    }

    // ===== Archived（已归档）分组：淘汰候选流程使用 =====

    /** 确保「已归档」分组存在（不存在则创建），返回分组 id */
    async ensureArchivedGroup(bookPath: string): Promise<string | null> {
        return this.ensureGroup(bookPath, this.ARCHIVED_GROUP_LABEL, this.ARCHIVED_GROUP_ALT_LABEL, this.ARCHIVED_GROUP_COLOR);
    }

    /** 把指定 nodeId 的节点几何移入「已归档」分组（沿用 Mastered 分组的坐标计算与排版逻辑） */
    async moveNodeToArchivedGroup(bookPath: string, nodeId: string): Promise<boolean> {
        return this.moveNodeToGroup(bookPath, nodeId, this.ARCHIVED_GROUP_LABEL, this.ARCHIVED_GROUP_ALT_LABEL, this.ARCHIVED_GROUP_COLOR);
    }

    /** 判断节点是否已位于「已归档」分组内 */
    async isNodeInArchivedGroup(bookPath: string, nodeId: string): Promise<boolean> {
        return this.isNodeInGroup(bookPath, nodeId, this.ARCHIVED_GROUP_LABEL, this.ARCHIVED_GROUP_ALT_LABEL);
    }

    // ===== 私有几何/排版逻辑（沿用原有实现） =====

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

    /** 把节点从指定分组移出（放到分组下方空白区），沿用原 removeFromMasteredGroup 的实现 */
    private moveNodeOutOfGroupSync(node: CanvasNode, canvasData: CanvasData, label: string, altLabel?: string): void {
        const group = this.findGroup(canvasData, label, altLabel);

        const freeTextNodes = canvasData.nodes.filter(n => {
            if (n.type !== 'text' || n.id === node.id) return false;
            if (!group) return true;
            return !this.canvasParser.isNodeInGroup(n, group);
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

        if (group) {
            const groupBottom = group.y + group.height;
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

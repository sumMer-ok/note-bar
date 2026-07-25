import type { CanvasData, CanvasNode, HiWordsSettings } from '../utils';
import type { CanvasParser } from './canvas-parser';

const BASE_X = 50;
const BASE_Y = 50;
const DEFAULT_CARD_WIDTH = 260;
const DEFAULT_CARD_HEIGHT = 120;
const GAP = 20;
const COLUMNS = 3;
const GROUP_PADDING = 24;
const GROUP_GAP = 12;
const GROUP_COLUMNS = 2;

export function normalizeLayout(canvasData: CanvasData, settings: HiWordsSettings, parser: CanvasParser) {
    if (!settings.autoLayoutEnabled) return;
    const CARD_WIDTH = settings.cardWidth ?? DEFAULT_CARD_WIDTH;
    const CARD_HEIGHT = settings.cardHeight ?? DEFAULT_CARD_HEIGHT;

    const masteredGroup = canvasData.nodes.find(
        (n) => n.type === 'group' && (n.label === 'Mastered' || n.label === '已掌握')
    );

    const groups = canvasData.nodes.filter((n) => n.type === 'group');

    const movableNodes = canvasData.nodes.filter((n) => {
        if (n.type === 'group') return false;
        if (masteredGroup && parser.isNodeInGroup(n, masteredGroup)) return false;
        // 保留已分组节点（日期分组等）
        if (groups.some((g) => g !== masteredGroup && parser.isNodeInGroup(n, g))) return false;
        return true;
    });

    if (movableNodes.length === 0) return;

    for (let i = 0; i < movableNodes.length; i++) {
        const node = movableNodes[i];
        const col = i % COLUMNS;
        const row = Math.floor(i / COLUMNS);
        node.x = BASE_X + col * (CARD_WIDTH + GAP);
        node.y = BASE_Y + row * (CARD_HEIGHT + GAP);
        node.width = CARD_WIDTH;
        node.height = CARD_HEIGHT;
    }
}

export function layoutGroupInner(
    canvasData: CanvasData,
    group: CanvasNode,
    settings: HiWordsSettings,
    parser: CanvasParser
) {
    const CARD_WIDTH = settings.cardWidth ?? DEFAULT_CARD_WIDTH;
    const CARD_HEIGHT = settings.cardHeight ?? DEFAULT_CARD_HEIGHT;

    const members = canvasData.nodes.filter(
        (n) => n.type !== 'group' && parser.isNodeInGroup(n, group)
    );

    if (members.length === 0) return;

    for (let i = 0; i < members.length; i++) {
        const node = members[i];
        const col = i % GROUP_COLUMNS;
        const row = Math.floor(i / GROUP_COLUMNS);
        node.x = group.x + GROUP_PADDING + col * (CARD_WIDTH + GROUP_GAP);
        node.y = group.y + GROUP_PADDING + row * (CARD_HEIGHT + GROUP_GAP);
        node.width = CARD_WIDTH;
        node.height = CARD_HEIGHT;
    }

    const rows = Math.ceil(members.length / GROUP_COLUMNS);
    const minWidth = GROUP_PADDING * 2 + GROUP_COLUMNS * CARD_WIDTH + (GROUP_COLUMNS - 1) * GROUP_GAP;
    const minHeight = GROUP_PADDING * 2 + rows * CARD_HEIGHT + (rows - 1) * GROUP_GAP;

    group.width = Math.max(group.width, minWidth);
    group.height = Math.max(group.height, minHeight);
}

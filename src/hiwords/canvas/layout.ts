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

    const movableNodes = canvasData.nodes.filter((n) => {
        if (n.type === 'group') return false;
        if (masteredGroup && parser.isNodeInGroup(n, masteredGroup)) return false;
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

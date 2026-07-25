import { App, TFile } from 'obsidian';
import type { CanvasData, CanvasNode, WordDefinition } from '../utils';
import { CanvasParser } from './canvas-parser';

export interface WordWithDate extends WordDefinition {
    date: string;
}

export class CanvasExporter {
    private app: App;
    private parser: CanvasParser;

    constructor(app: App, parser: CanvasParser) {
        this.app = app;
        this.parser = parser;
    }

    private isDateLabel(label: string | undefined): boolean {
        if (!label) return false;
        return /^\d{4}-\d{2}-\d{2}$/.test(label);
    }

    private findDateGroupLabel(node: CanvasNode, canvasData: CanvasData): string | null {
        for (const n of canvasData.nodes) {
            if (n.type === 'group' && this.isDateLabel(n.label)) {
                if (this.parser.isNodeInGroup(node, n)) {
                    return n.label || null;
                }
            }
        }
        return null;
    }

    async getWordsWithDates(file: TFile): Promise<WordWithDate[]> {
        const content = await this.app.vault.cachedRead(file);
        const canvasData: CanvasData = JSON.parse(content);
        const definitions = await this.parser.parseCanvasFile(file);
        const result: WordWithDate[] = [];
        for (const def of definitions) {
            const node = canvasData.nodes.find((n) => n.id === def.nodeId);
            const date = node ? this.findDateGroupLabel(node, canvasData) : null;
            result.push({ ...def, date: date || '无日期' });
        }
        return result;
    }

    getUniqueDates(words: WordWithDate[]): string[] {
        const dateSet = new Set<string>();
        for (const word of words) {
            dateSet.add(word.date);
        }
        const dates = Array.from(dateSet).sort();
        // 将“无日期”排在最后
        return dates.sort((a, b) => {
            if (a === '无日期') return 1;
            if (b === '无日期') return -1;
            return a.localeCompare(b);
        });
    }

    filterWordsByDate(words: WordWithDate[], date: string): WordWithDate[] {
        return words.filter((w) => w.date === date);
    }
}

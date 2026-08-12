import { App } from 'obsidian';
import type { EncounterData, EncounterType } from '../utils';

/** 相遇记录文件路径（vault 相对路径，位于插件目录下） */
const ENCOUNTER_FILE_PATH = '.obsidian/plugins/note-bar/encounters.json';
/** (词 + 类型) 去重冷却时间：60 秒 */
const RECORD_COOLDOWN_MS = 60 * 1000;
/** 落盘防抖时间：1.5 秒 */
const SAVE_DEBOUNCE_MS = 1500;

/** 将 Date 格式化为 YYYY-MM-DD（本地时区） */
export function formatYYYYMMDD(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 相遇记账模块：统计单词在插件内的相遇次数（悬停 / 添加 / 打开）。
 * 数据以 sidecar 文件 encounters.json 持久化在插件目录下，
 * 采用「内存记账 + 防抖落盘 + 卸载时 flush」的模式。
 */
export class EncounterTracker {
    private app: App;
    private data: Record<string, EncounterData> = {};
    private cooldowns: Map<string, number> = new Map();
    private saveTimer: number | null = null;
    private loaded = false;

    constructor(app: App) {
        this.app = app;
    }

    /** 从磁盘加载相遇记录（文件不存在则视为空对象） */
    async load(): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            if (await adapter.exists(ENCOUNTER_FILE_PATH)) {
                const content = await adapter.read(ENCOUNTER_FILE_PATH);
                const parsed = JSON.parse(content) as Record<string, EncounterData>;
                if (parsed && typeof parsed === 'object') {
                    // 加载完成前若已发生相遇（内存有数据），以内存为准合并，避免覆盖
                    this.data = { ...parsed, ...this.data };
                }
            }
        } catch (error) {
            console.error('Note Bar: 加载相遇记录失败:', error);
        }
        this.loaded = true;
    }

    /**
     * 记录一次相遇。
     * - hover：hoverCount + 1 且 encounterCount + 1；add/open 仅 encounterCount + 1
     * - lastEncounter 更新为今天（YYYY-MM-DD）
     * - 同一 (词 + 类型) 在 60 秒冷却内只记一次，避免高频事件重复计数
     */
    record(wordKey: string, type: EncounterType): void {
        const key = wordKey.trim().toLowerCase();
        if (!key) return;

        const cooldownKey = `${key}|${type}`;
        const now = Date.now();
        const lastTs = this.cooldowns.get(cooldownKey);
        if (lastTs !== undefined && now - lastTs < RECORD_COOLDOWN_MS) {
            return;
        }
        this.cooldowns.set(cooldownKey, now);

        const today = formatYYYYMMDD(new Date());
        const entry: EncounterData = this.data[key] || { hoverCount: 0, encounterCount: 0 };
        if (type === 'hover') {
            entry.hoverCount = (entry.hoverCount || 0) + 1;
        }
        entry.encounterCount = (entry.encounterCount || 0) + 1;
        entry.lastEncounter = today;
        this.data[key] = entry;

        this.scheduleSave();
    }

    /** 读取内存中的相遇数据 */
    get(wordKey: string): EncounterData | undefined {
        return this.data[wordKey.trim().toLowerCase()];
    }

    /** 读取所有相遇数据（供淘汰候选计算使用） */
    getAll(): Record<string, EncounterData> {
        return this.data;
    }

    /** 立即将内存数据写盘（同时取消未执行的防抖落盘） */
    async save(): Promise<void> {
        if (this.saveTimer !== null) {
            activeWindow.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        // 加载尚未完成时不落盘，避免用空数据覆盖磁盘上已有的记录
        if (!this.loaded) {
            return;
        }
        try {
            const adapter = this.app.vault.adapter;
            const dir = ENCOUNTER_FILE_PATH.split('/').slice(0, -1).join('/');
            if (dir && !(await adapter.exists(dir))) {
                await adapter.mkdir(dir);
            }
            await adapter.write(ENCOUNTER_FILE_PATH, JSON.stringify(this.data, null, 2));
        } catch (error) {
            console.error('Note Bar: 保存相遇记录失败:', error);
        }
    }

    /** 插件卸载时调用，确保数据立即落盘 */
    async flush(): Promise<void> {
        await this.save();
    }

    private scheduleSave(): void {
        if (this.saveTimer !== null) {
            activeWindow.clearTimeout(this.saveTimer);
        }
        this.saveTimer = activeWindow.setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, SAVE_DEBOUNCE_MS);
    }
}

/** 全局单例：供各 UI 模块（释义弹窗 / 加词弹窗 / 侧边栏）共享同一个记账实例 */
let trackerInstance: EncounterTracker | null = null;

export function getEncounterTracker(): EncounterTracker | null {
    return trackerInstance;
}

export function setEncounterTracker(tracker: EncounterTracker | null): void {
    trackerInstance = tracker;
}

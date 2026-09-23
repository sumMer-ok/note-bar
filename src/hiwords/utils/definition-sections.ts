export type DefinitionSectionKind = 'dictionary' | 'legal' | 'ai' | 'notes';

/** 分节内容映射：key 为分节类型，value 为该分节的正文（不含 `--- 标题 ---` 行） */
export type DefinitionSectionMap = Record<DefinitionSectionKind, string>;

/** 默认分节顺序：词典释义 → 法律词典释义 → AI 释义 → 自定义笔记 */
export const DEFAULT_DEFINITION_SECTION_ORDER: readonly DefinitionSectionKind[] = [
    'dictionary',
    'legal',
    'ai',
    'notes',
];

/** 分节的中文显示名（弹窗输入框标题、设置面板顺序列表共用） */
export const DEFINITION_SECTION_LABELS: Record<DefinitionSectionKind, string> = {
    dictionary: '词典释义',
    legal: '法律英语释义',
    ai: 'AI 释义',
    notes: '自定义笔记',
};

/**
 * 分节标题约定（写回 Canvas 时使用）：
 * dictionary 沿用历史写法（排在首位时不写标题，直接是正文），其余三种保留既有标题写法，
 * 保证与既有 Canvas 数据兼容。
 */
const CANONICAL_TITLES: Record<DefinitionSectionKind, string> = {
    dictionary: '词典释义',
    legal: "Black's Law Dictionary",
    ai: 'AI 释义',
    notes: '自定义笔记',
};

interface DefinitionSection {
    kind: DefinitionSectionKind;
    header: string | null;
    content: string;
}

function headerAndTrailing(line: string): { header: string; trailing: string } | null {
    const match = /^\s*---\s*(.+?)\s*---(.*)$/.exec(line);
    if (!match) return null;
    return { header: match[1].trim(), trailing: match[2].trim() };
}

function kindForHeader(header: string | null): DefinitionSectionKind {
    if (!header) return 'dictionary';
    const lower = header.toLowerCase();
    if (lower.includes('black') || lower.includes('法律')) return 'legal';
    if (lower.includes('ai')) return 'ai';
    if (lower.includes('笔记')) return 'notes';
    if (lower.includes('词典') || lower.includes('已有释义')) return 'dictionary';
    return 'notes';
}

/**
 * 把设置里可能残缺、重复、含非法值的分节顺序整理成一份完整合法的顺序：
 * 先按用户顺序保留合法且不重复的项，再按默认顺序补齐缺失项。
 */
export function resolveDefinitionSectionOrder(
    order?: readonly DefinitionSectionKind[] | null
): DefinitionSectionKind[] {
    const resolved: DefinitionSectionKind[] = [];
    const isKnown = (kind: unknown): kind is DefinitionSectionKind =>
        typeof kind === 'string' && (DEFAULT_DEFINITION_SECTION_ORDER as readonly string[]).includes(kind);

    for (const kind of order ?? []) {
        if (isKnown(kind) && !resolved.includes(kind)) {
            resolved.push(kind);
        }
    }
    for (const kind of DEFAULT_DEFINITION_SECTION_ORDER) {
        if (!resolved.includes(kind)) {
            resolved.push(kind);
        }
    }
    return resolved;
}

/** 按 `--- 标题 ---` 把 definition 切成有序分节（含标题与正文） */
function collectSections(definition: string): DefinitionSection[] {
    const lines = definition.split('\n');
    const sections: DefinitionSection[] = [];
    let currentHeader: string | null = null;
    let buffer: string[] = [];

    const flush = () => {
        const content = buffer.join('\n').trim();
        if (content || currentHeader !== null) {
            sections.push({ kind: kindForHeader(currentHeader), header: currentHeader, content });
        }
        buffer = [];
    };

    for (const line of lines) {
        const parsed = headerAndTrailing(line);
        if (parsed) {
            flush();
            currentHeader = parsed.header;
            if (parsed.trailing) buffer.push(parsed.trailing);
        } else {
            buffer.push(line);
        }
    }
    flush();

    return sections;
}

function emptySectionMap(): DefinitionSectionMap {
    return { dictionary: '', legal: '', ai: '', notes: '' };
}

function appendContent(current: string, next: string): string {
    if (!next) return current;
    return current ? `${current}\n\n${next}` : next;
}

function emptySectionBuckets(): Record<DefinitionSectionKind, { content: string; header: string | null }> {
    return {
        dictionary: { content: '', header: null },
        legal: { content: '', header: null },
        ai: { content: '', header: null },
        notes: { content: '', header: null },
    };
}

/**
 * 按给定顺序拼出 definition 字符串。
 *
 * 词典释义沿用历史写法：排在首位时不写标题（与既有 Canvas 数据完全一致），否则必须补上
 * `--- 词典释义 ---` 标题——无标题正文紧跟在上一个带标题分节后面会被解析归属到那个分节，
 * 补标题才能保证「保存 → 再次打开回填」不串节。
 */
function buildDefinition(
    byKind: Record<DefinitionSectionKind, { content: string; header: string | null }>,
    order?: readonly DefinitionSectionKind[] | null
): string {
    const parts: string[] = [];
    for (const kind of resolveDefinitionSectionOrder(order)) {
        const item = byKind[kind];
        const content = item.content.trim();
        if (!content) continue;

        if (kind === 'dictionary' && parts.length === 0) {
            parts.push(content);
            continue;
        }
        parts.push(`--- ${item.header ?? CANONICAL_TITLES[kind]} ---\n${content}`);
    }
    return parts.join('\n\n');
}

/**
 * 把 definition 拆成 4 段独立正文（不含分节标题），用于「加入词库」弹窗分别回填 4 个输入框。
 * 无标题内容归入 dictionary，同类分节合并，空分节为空字符串。
 */
export function parseDefinitionSections(definition: string): DefinitionSectionMap {
    const result = emptySectionMap();
    for (const section of collectSections(definition ?? '')) {
        result[section.kind] = appendContent(result[section.kind], section.content);
    }
    return result;
}

/**
 * 按给定顺序把 4 段正文拼回 definition 字符串（保留既有分节标题写法）。
 * 空分节省略；顺序缺省时用默认顺序（词典 → 法律 → AI → 笔记）。
 */
export function joinDefinitionSections(
    sections: Partial<DefinitionSectionMap>,
    order?: readonly DefinitionSectionKind[] | null
): string {
    const byKind = emptySectionBuckets();
    for (const kind of DEFAULT_DEFINITION_SECTION_ORDER) {
        byKind[kind].content = sections?.[kind] ?? '';
    }
    return buildDefinition(byKind, order);
}

/**
 * 把释义规范化成给定顺序（缺省为 词典释义 → 法律词典释义 → AI 释义 → 自定义笔记）。
 * 解析 `--- 标题 ---` 分节（与桌面端历史写法兼容），同类内容合并，空模块省略，
 * 已存在的自定义分节标题会被保留。
 */
export function normalizeDefinitionSections(
    definition: string,
    order?: readonly DefinitionSectionKind[] | null
): string {
    const byKind = emptySectionBuckets();
    for (const section of collectSections(definition ?? '')) {
        const target = byKind[section.kind];
        target.content = appendContent(target.content, section.content);
        if (!target.header && section.header) {
            target.header = section.header;
        }
    }
    return buildDefinition(byKind, order);
}

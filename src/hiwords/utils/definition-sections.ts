export type DefinitionSectionKind = 'dictionary' | 'legal' | 'ai' | 'notes';

interface DefinitionSection {
    kind: DefinitionSectionKind;
    header: string | null;
    content: string;
}

const SECTION_ORDER: DefinitionSectionKind[] = ['dictionary', 'legal', 'ai', 'notes'];

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
 * 把释义规范化成固定顺序：词典释义 → 法律词典释义 → AI 释义 → 自定义笔记。
 * 解析 `--- 标题 ---` 分节（与桌面端历史写法兼容），同类内容合并，空模块省略。
 */
export function normalizeDefinitionSections(definition: string): string {
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

    const byKind: Record<DefinitionSectionKind, { content: string; header: string | null }> = {
        dictionary: { content: '', header: null },
        legal: { content: '', header: null },
        ai: { content: '', header: null },
        notes: { content: '', header: null },
    };
    for (const section of sections) {
        const target = byKind[section.kind];
        if (section.content) {
            target.content = target.content ? `${target.content}\n\n${section.content}` : section.content;
        }
        if (!target.header && section.header) {
            target.header = section.header;
        }
    }

    const canonicalTitles: Record<DefinitionSectionKind, string> = {
        dictionary: '',
        legal: "Black's Law Dictionary",
        ai: 'AI 释义',
        notes: '自定义笔记',
    };

    const parts: string[] = [];
    for (const kind of SECTION_ORDER) {
        const item = byKind[kind];
        if (!item.content) continue;
        if (kind === 'dictionary') {
            parts.push(item.content);
        } else {
            const title = item.header ?? canonicalTitles[kind];
            parts.push(`--- ${title} ---\n${item.content}`);
        }
    }
    return parts.join('\n\n');
}

/** 跨应用加词收件箱：外部助手追加写的协议文件，由插件消费后调用 Canvas 落库 */

export const INBOX_VERSION = 1;
export const INBOX_FILE_NAME = "note-bar-inbox.jsonl";
export const INBOX_FAILED_FILE_NAME = "note-bar-inbox.failed.jsonl";
export const INBOX_STATE_FILE_NAME = "note-bar-inbox.state.json";
export const ALIAS_LIMIT = 10;

export interface InboxOrigin {
  app?: string;
  file?: string;
}

/** 一条加词意图；除 v/id/word 外全部可缺省 */
export interface InboxEntry {
  v: number;
  id: string;
  word: string;
  createdAt?: string;
  source?: string;
  sentence?: string;
  definition?: string;
  aliases?: string[];
  color?: string;
  books?: string[];
  origin?: InboxOrigin;
}

export type InboxParseResult =
  | { ok: true; entry: InboxEntry }
  | { ok: false; reason: string };

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => item !== undefined);
  return items.length > 0 ? items : undefined;
}

/** 别名规范化（插件侧唯一入口）：小写、去重、顺序保留、上限 10 条 */
export function normalizeAliases(value: unknown): string[] | undefined {
  const items = asStringArray(value);
  if (!items) return undefined;
  const unique: string[] = [];
  for (const item of items) {
    const normalized = item.toLowerCase();
    if (!unique.includes(normalized)) unique.push(normalized);
  }
  return unique.slice(0, ALIAS_LIMIT);
}

/** 解析一行 JSONL；失败返回原因，调用方保留原行不做改动 */
export function parseInboxLine(line: string): InboxParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, reason: "blank" };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "not-an-object" };
  }

  const data = raw as Record<string, unknown>;
  if (data.v !== INBOX_VERSION) return { ok: false, reason: "unsupported-version" };

  const id = asNonEmptyString(data.id);
  if (!id) return { ok: false, reason: "missing-id" };

  const word = asNonEmptyString(data.word);
  if (!word) return { ok: false, reason: "missing-word" };

  const rawOrigin =
    data.origin && typeof data.origin === "object" && !Array.isArray(data.origin)
      ? (data.origin as Record<string, unknown>)
      : undefined;

  return {
    ok: true,
    entry: {
      v: INBOX_VERSION,
      id,
      word,
      createdAt: asNonEmptyString(data.createdAt),
      source: asNonEmptyString(data.source),
      sentence: asNonEmptyString(data.sentence),
      definition: typeof data.definition === "string" ? data.definition : undefined,
      aliases: normalizeAliases(data.aliases),
      color: asNonEmptyString(data.color),
      books: asStringArray(data.books),
      origin: rawOrigin
        ? { app: asNonEmptyString(rawOrigin.app), file: asNonEmptyString(rawOrigin.file) }
        : undefined,
    },
  };
}

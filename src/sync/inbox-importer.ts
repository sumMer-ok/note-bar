import type { InboxEntry } from "./inbox-types";
import { normalizeAliases, parseInboxLine } from "./inbox-types";
import {
  appendLines,
  inboxFailedPathFor,
  inboxPathFor,
  inboxStatePathFor,
  readInboxState,
  readInboxText,
  writeInboxAtomic,
  writeInboxState,
} from "./inbox-store";

/** 落库端口：生产由 inbox-vocabulary-adapter 实现，测试注入假实现 */
export interface InboxVocabularyPort {
  /** 该词库内是否已有同词或同别名（忽略 retired 词），有则返回节点 id */
  findExisting(bookPath: string, word: string): Promise<{ nodeId: string } | null>;
  addWord(bookPath: string, entry: InboxEntry): Promise<boolean>;
  updateWord(bookPath: string, nodeId: string, entry: InboxEntry): Promise<boolean>;
  /** 条目未带释义时用本地词典补全；查不到返回 undefined */
  lookupDefinition(word: string): Promise<{ definition?: string; aliases?: string[] } | undefined>;
}

export interface InboxImportOptions {
  syncDir: string;
  /** 已启用的 .canvas 词库相对路径（含 .canvas 后缀） */
  books: string[];
  /** 条目未指定词库时的回落目标 */
  defaultBooks: string[];
  duplicatePolicy: "skip" | "update";
  port: InboxVocabularyPort;
  now?: () => Date;
}

export interface InboxImportResult {
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  badLines: number;
  duplicatesDropped: number;
}

/** processedIds 环形窗口上限，防止状态文件无限增长 */
export const PROCESSED_ID_LIMIT = 500;

/** 目标词库 = 条目指定 ∩ 已启用；为空则回落到默认词库 ∩ 已启用 */
function resolveTargets(entry: InboxEntry, options: InboxImportOptions): string[] {
  const enabled = new Set(options.books);
  const requested = (entry.books ?? []).filter((book) => enabled.has(book));
  if (requested.length > 0) return requested;
  return options.defaultBooks.filter((book) => enabled.has(book));
}

/** 释义与别名的规范化只在这里发生：自带释义优先，否则查本地词典 */
async function buildEffectiveEntry(
  entry: InboxEntry,
  port: InboxVocabularyPort
): Promise<InboxEntry> {
  let aliases = normalizeAliases(entry.aliases);
  let definition = entry.definition && entry.definition.trim().length > 0 ? entry.definition : undefined;

  if (!definition) {
    const filled = await port.lookupDefinition(entry.word).catch(() => undefined);
    definition = filled?.definition;
    if (!aliases) aliases = normalizeAliases(filled?.aliases);
  }
  return { ...entry, definition, aliases };
}

type ApplyOutcome =
  | { kind: "done" }
  | { kind: "archive"; reason: string };

/** 处理单条：任一目标词库成功即视为已处理（部分失败计入 failed 但不阻塞） */
async function applyEntry(
  entry: InboxEntry,
  options: InboxImportOptions,
  result: InboxImportResult
): Promise<ApplyOutcome> {
  const targets = resolveTargets(entry, options);
  if (targets.length === 0) {
    result.failed++;
    return { kind: "archive", reason: "no-target-book" };
  }

  const effective = await buildEffectiveEntry(entry, options.port);
  let touched = 0;

  for (const bookPath of targets) {
    try {
      const existing = await options.port.findExisting(bookPath, effective.word);
      if (existing) {
        if (options.duplicatePolicy === "update") {
          const ok = await options.port.updateWord(bookPath, existing.nodeId, effective);
          if (!ok) {
            result.failed++;
            continue;
          }
          result.updated++;
        } else {
          result.skipped++;
        }
        touched++;
        continue;
      }
      const ok = await options.port.addWord(bookPath, effective);
      if (!ok) {
        result.failed++;
        continue;
      }
      result.added++;
      touched++;
    } catch {
      result.failed++;
    }
  }

  if (touched > 0) return { kind: "done" };
  return { kind: "archive", reason: "apply-failed" };
}

/**
 * 同一收件箱文件同时只允许一次消费。
 * 启动立即消费、fs.watch 事件与手动命令可能并发触发；两次并发消费会各自读到同一批行，
 * 导致同一单词被写入两次（Canvas 出现重复词条），故按收件箱路径做在途去重。
 */
const inFlightImports = new Map<string, Promise<InboxImportResult>>();

/**
 * 消费收件箱：逐行解析 → 落库 → 成功行移除、坏行保留。
 * 失败条目归档到 .failed.jsonl 并从收件箱移除，避免下一轮无限重试同一条失败条目。
 * 并发的重复调用共享同一次消费结果，不会重复落库。
 */
export function importInbox(options: InboxImportOptions): Promise<InboxImportResult> {
  const key = inboxPathFor(options.syncDir);
  const running = inFlightImports.get(key);
  if (running) return running;

  const run = runImportInbox(options);
  inFlightImports.set(key, run);
  void run
    .finally(() => {
      if (inFlightImports.get(key) === run) inFlightImports.delete(key);
    })
    .catch(() => undefined);
  return run;
}

async function runImportInbox(options: InboxImportOptions): Promise<InboxImportResult> {
  const result: InboxImportResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    badLines: 0,
    duplicatesDropped: 0,
  };

  const filePath = inboxPathFor(options.syncDir);
  const statePath = inboxStatePathFor(options.syncDir);
  const text = await readInboxText(filePath);
  if (text.length === 0) return result;

  const state = await readInboxState(statePath);
  const processed = new Set(state.processedIds);

  const endsWithNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (endsWithNewline) rawLines.pop();

  const remaining: string[] = [];
  const archived: string[] = [];
  const now = options.now ? options.now() : new Date();

  for (const rawLine of rawLines) {
    const parsed = parseInboxLine(rawLine);
    if (!parsed.ok) {
      result.badLines++;
      remaining.push(rawLine);
      continue;
    }

    // 助手写入成功但自身崩溃后重试时，靠 id 幂等丢弃重复投递
    if (processed.has(parsed.entry.id)) {
      result.duplicatesDropped++;
      continue;
    }

    const outcome = await applyEntry(parsed.entry, options, result);
    if (outcome.kind === "archive") {
      archived.push(
        JSON.stringify({
          ...parsed.entry,
          reason: outcome.reason,
          archivedAt: now.toISOString(),
        })
      );
      continue;
    }
    processed.add(parsed.entry.id);
  }

  await appendLines(inboxFailedPathFor(options.syncDir), archived);
  if (remaining.length !== rawLines.length) {
    await writeInboxAtomic(filePath, remaining.length > 0 ? `${remaining.join("\n")}\n` : "");
  }

  const processedIds = [...processed].slice(-PROCESSED_ID_LIMIT);
  await writeInboxState(statePath, { processedIds, lastRunAt: now.toISOString() });

  return result;
}

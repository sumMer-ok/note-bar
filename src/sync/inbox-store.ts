import { promises as fs } from "fs";
import * as path from "path";
import {
  INBOX_FAILED_FILE_NAME,
  INBOX_FILE_NAME,
  INBOX_STATE_FILE_NAME,
} from "./inbox-types";

/** 收件箱消费状态：processedIds 为最近成功处理的条目 id 环形窗口 */
export interface InboxState {
  processedIds: string[];
  lastRunAt?: string;
}

export function inboxPathFor(syncDir: string): string {
  return path.join(syncDir, INBOX_FILE_NAME);
}

export function inboxFailedPathFor(syncDir: string): string {
  return path.join(syncDir, INBOX_FAILED_FILE_NAME);
}

export function inboxStatePathFor(syncDir: string): string {
  return path.join(syncDir, INBOX_STATE_FILE_NAME);
}

export async function readInboxText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/** tmp + rename 原子替换：避免助手与插件同时读到半截文件 */
export async function writeInboxAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 追加写失败归档；空数组时不产生文件 */
export async function appendLines(filePath: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

export async function readInboxState(filePath: string): Promise<InboxState> {
  try {
    const data = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<InboxState>;
    const processedIds = Array.isArray(data?.processedIds)
      ? data.processedIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return {
      processedIds,
      lastRunAt: typeof data?.lastRunAt === "string" ? data.lastRunAt : undefined,
    };
  } catch {
    return { processedIds: [], lastRunAt: undefined };
  }
}

export async function writeInboxState(filePath: string, state: InboxState): Promise<void> {
  await writeInboxAtomic(filePath, JSON.stringify(state, null, 2));
}

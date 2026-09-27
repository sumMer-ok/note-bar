/**
 * Canvas 审计日志与写入失败日志（纯逻辑模块，仅依赖 Node 内置模块）。
 *
 * 事故背景：57344 字节这种「整 KB 截断」来源不明（iCloud 未物化 / 多端写入 / 复制中断），
 * 需要留痕才能定位「是谁写的、写前写后多大、写完是否结构合法」。
 *
 * - 审计日志：`<vault>/.obsidian/plugins/note-bar/canvas-audit.log`
 *   每行形如 `timestamp | actor(plugin|mirror) | book | bytesBefore | bytesAfter | sha1_12_before | sha1_12_after | validated(yes|no)`；
 *   超过 512KB 轮转为 `canvas-audit.log.1`（只保留一代，避免无限增长）。
 * - 写入失败日志：`<vault>/.obsidian/plugins/note-bar/canvas-write-failures.log`（同样轮转）。
 *
 * 本文件不 import obsidian：日志绝不参与业务判断，任何失败都只返回 false。
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";

/** 插件 ID（与 manifest.json 一致）：插件数据目录相对 vault 的位置 */
export const PLUGIN_ID = "note-bar";

/** 审计日志轮转阈值 */
export const AUDIT_LOG_ROTATE_BYTES = 512 * 1024;

export type AuditActor = "plugin" | "mirror";

export interface AuditLogEntry {
  timestamp: Date;
  actor: AuditActor;
  /** 词库相对路径（vault 内） */
  book: string;
  bytesBefore: number;
  bytesAfter: number;
  /** 写前内容的 sha1 前 12 位；文件不存在时用 "-" */
  sha1Before: string;
  sha1After: string;
  validated: boolean;
}

/** 从 Obsidian App 取 vault 绝对路径（桌面端才有；移动端返回 null） */
export function resolveVaultBasePath(app: unknown): string | null {
  const adapter = (app as { vault?: { adapter?: unknown } } | null | undefined)?.vault?.adapter;
  const base = (adapter as { getBasePath?: () => unknown } | undefined)?.getBasePath;
  if (typeof base !== "function" || !adapter) return null;
  const value = base.call(adapter);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `<vault>/.obsidian/plugins/note-bar` */
export function pluginDataDir(vaultBasePath: string): string {
  return path.join(vaultBasePath, ".obsidian", "plugins", PLUGIN_ID);
}

/** 审计日志路径 */
export function canvasAuditLogPath(vaultBasePath: string): string {
  return path.join(pluginDataDir(vaultBasePath), "canvas-audit.log");
}

/** 写入失败日志路径 */
export function canvasWriteFailureLogPath(vaultBasePath: string): string {
  return path.join(pluginDataDir(vaultBasePath), "canvas-write-failures.log");
}

/** 内容 sha1 的前 12 位（日志里用它比对「写前/写后」是不是同一份） */
export function sha1Short12(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

/** UTF-8 字节数（与文件 size 口径一致） */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 一行审计：字段顺序与分隔符是排查时的对照口径，改动等于让历史日志不可比 */
export function formatAuditLine(entry: AuditLogEntry): string {
  return [
    entry.timestamp.toISOString(),
    entry.actor,
    entry.book,
    String(entry.bytesBefore),
    String(entry.bytesAfter),
    entry.sha1Before,
    entry.sha1After,
    entry.validated ? "yes" : "no",
  ].join(" | ");
}

export interface AppendLogOptions {
  /** 超过该字节数就轮转为 `<logPath>.1`；默认 512KB */
  maxBytes?: number;
}

/**
 * 追加一行日志，必要时先轮转。返回是否写入成功。
 * 绝不上抛：日志失败不能影响词条写入本身。
 */
export async function appendLogLine(
  logPath: string,
  line: string,
  options: AppendLogOptions = {}
): Promise<boolean> {
  const maxBytes = options.maxBytes ?? AUDIT_LOG_ROTATE_BYTES;
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const size = await fs
      .stat(logPath)
      .then((stat) => stat.size)
      .catch(() => 0);
    if (maxBytes > 0 && size >= maxBytes) {
      await fs.rm(`${logPath}.1`, { force: true }).catch(() => undefined);
      await fs.rename(logPath, `${logPath}.1`).catch(() => undefined);
    }
    await fs.appendFile(logPath, `${line}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 追加一条审计记录 */
export async function appendAuditLine(
  logPath: string,
  entry: AuditLogEntry,
  options: AppendLogOptions = {}
): Promise<boolean> {
  return appendLogLine(logPath, formatAuditLine(entry), options);
}

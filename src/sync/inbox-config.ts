/**
 * 跨应用加词收件箱的配置解析（纯函数）。
 *
 * 只允许 `import type`：本模块必须能在 node:test 环境下直接运行，
 * 任何运行时的 obsidian 依赖（含间接）都会让 require("obsidian") 失败。
 */
import type { HiWordsSettings } from "../hiwords/utils/types";

/** 收件箱只由 crossAppInbox.enabled 显式开关控制；缺省/未配置一律视为关闭 */
export function isInboxEnabled(settings: HiWordsSettings): boolean {
  return settings.crossAppInbox?.enabled === true;
}

/**
 * 收件箱目录：crossAppInbox.syncDir 优先，为空则回落到 mobileSync.syncDir。
 * 纯空白视为空；两者都为空时返回 null（此时不应启动监听与消费）。
 */
export function resolveInboxDir(settings: HiWordsSettings): string | null {
  const own = settings.crossAppInbox?.syncDir?.trim();
  if (own) return own;
  const fallback = settings.mobileSync?.syncDir?.trim();
  if (fallback) return fallback;
  return null;
}

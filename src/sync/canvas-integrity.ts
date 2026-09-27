/**
 * Canvas 完整性校验（纯逻辑模块）。
 *
 * 事故背景：2026-09-26 词库 `.canvas` 被外部截断成整 KB 字节，JSON 断在字符串中间，
 * 而镜像是「mtime 胜出」且不校验内容，于是坏副本把好副本顶掉，三份一起坏。
 * 本模块只做判断题：一段文本到底是不是一个结构完整的 JSON Canvas。
 *
 * 规则对齐 JSON Canvas 规范（https://github.com/obsidianmd/jsoncanvas）：
 * - JSON 可解析；顶层是对象且 `nodes` 为数组；
 * - 每个节点含 `id / type / x / y / width / height`，`id` 唯一；
 * - `type` ∈ {text, file, link, group}；text 节点含字符串 `text`；
 * - `edges`（如有）为数组，且 `fromNode` / `toNode` 必须指向已存在的节点。
 *
 * 约束（见 CLAUDE.md「纯逻辑模块不得 import obsidian」）：
 * 本文件不 import obsidian、不读磁盘、不依赖 Node 内置模块，可直接 `node --test`。
 * `reason` 是**稳定短串**：会出现在日志、审计与归档记录里，改动等于破坏历史可读性。
 */

/** 校验失败原因（稳定短串，勿随意重命名） */
export type CanvasInvalidReason =
  | "not-json"
  | "not-object"
  | "nodes-not-array"
  | "node-not-object"
  | "node-missing-id"
  | "duplicate-id"
  | "node-missing-type"
  | "node-unknown-type"
  | "node-missing-geometry"
  | "text-node-missing-text"
  | "edges-not-array"
  | "edge-not-object"
  | "edge-missing-endpoint"
  | "edge-dangling";

export type CanvasValidationResult =
  | { ok: true; nodeCount: number }
  | { ok: false; reason: CanvasInvalidReason };

/** JSON Canvas 规范允许的节点类型 */
export const CANVAS_NODE_TYPES: readonly string[] = ["text", "file", "link", "group"];

/** 节点数骤降判定的默认阈值：少于参照的 60% 视为可疑 */
export const SUSPICIOUS_SHRINK_RATIO = 0.6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 校验一段 Canvas 文本。
 * @param raw 文件原文（未经解析）
 */
export function validateCanvasText(raw: string): CanvasValidationResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // 截断/未转义换行/尾随逗号都会落到这里——这是本次事故的形态
    return { ok: false, reason: "not-json" };
  }

  if (!isPlainObject(data)) return { ok: false, reason: "not-object" };
  const nodesRaw = data.nodes;
  if (!Array.isArray(nodesRaw)) return { ok: false, reason: "nodes-not-array" };

  const ids = new Set<string>();
  for (const nodeRaw of nodesRaw) {
    if (!isPlainObject(nodeRaw)) return { ok: false, reason: "node-not-object" };

    const id = nodeRaw.id;
    if (typeof id !== "string" || id.length === 0) return { ok: false, reason: "node-missing-id" };
    if (ids.has(id)) return { ok: false, reason: "duplicate-id" };
    ids.add(id);

    const type = nodeRaw.type;
    if (typeof type !== "string" || type.length === 0) {
      return { ok: false, reason: "node-missing-type" };
    }
    if (!CANVAS_NODE_TYPES.includes(type)) return { ok: false, reason: "node-unknown-type" };

    if (
      !isFiniteNumber(nodeRaw.x) ||
      !isFiniteNumber(nodeRaw.y) ||
      !isFiniteNumber(nodeRaw.width) ||
      !isFiniteNumber(nodeRaw.height)
    ) {
      return { ok: false, reason: "node-missing-geometry" };
    }

    if (type === "text" && typeof nodeRaw.text !== "string") {
      return { ok: false, reason: "text-node-missing-text" };
    }
  }

  const edgesRaw = data.edges;
  if (edgesRaw !== undefined) {
    if (!Array.isArray(edgesRaw)) return { ok: false, reason: "edges-not-array" };
    for (const edgeRaw of edgesRaw) {
      if (!isPlainObject(edgeRaw)) return { ok: false, reason: "edge-not-object" };
      const from = edgeRaw.fromNode;
      const to = edgeRaw.toNode;
      if (typeof from !== "string" || typeof to !== "string" || from.length === 0 || to.length === 0) {
        return { ok: false, reason: "edge-missing-endpoint" };
      }
      if (!ids.has(from) || !ids.has(to)) return { ok: false, reason: "edge-dangling" };
    }
  }

  return { ok: true, nodeCount: nodesRaw.length };
}

/**
 * 「节点数骤降」启发式：候选文件的节点数远少于参照文件时，多半是被截断而不是真删词。
 *
 * - 参照为 0（无历史可比）→ 不判定可疑；
 * - 候选 ≥ 参照 → 不判定可疑；
 * - 候选 < 参照 × minRatio（默认 60%）→ 可疑。
 */
export function isSuspiciousShrink(
  candidateCount: number,
  referenceCount: number,
  minRatio: number = SUSPICIOUS_SHRINK_RATIO
): boolean {
  if (!isFiniteNumber(candidateCount) || !isFiniteNumber(referenceCount)) return false;
  if (referenceCount <= 0) return false;
  if (candidateCount >= referenceCount) return false;
  return candidateCount < referenceCount * minRatio;
}

/** 读节点数；文本非法时返回 null（用于体检/镜像里比较两侧规模） */
export function canvasNodeCount(raw: string): number | null {
  const verdict = validateCanvasText(raw);
  return verdict.ok ? verdict.nodeCount : null;
}

/** 文本里是否存在指定节点 id（写入回执用：确认节点真的落盘了） */
export function containsNodeId(raw: string, nodeId: string): boolean {
  if (!nodeId) return false;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isPlainObject(data) || !Array.isArray(data.nodes)) return false;
  return data.nodes.some((node) => isPlainObject(node) && node.id === nodeId);
}

/** 文件时间戳：YYYYMMDD-HHmmss（本地时区） */
export function formatCanvasStamp(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 去掉文件名末尾的 .canvas 后缀（保留其余部分，含空格与中文） */
export function canvasFileBaseName(fileName: string): string {
  const plain = plainFileName(fileName);
  return plain.endsWith(".canvas") ? plain.slice(0, -".canvas".length) : plain;
}

/** 只取最后一段文件名：调用方可能传相对路径（如 Words/AI.canvas），这些辅助函数一律返回文件名 */
function plainFileName(value: string): string {
  const segments = value.split("/");
  return segments[segments.length - 1] || value;
}

/** 可疑（校验失败的镜像候选）另存名：`<book>.suspect-<YYYYMMDD-HHmmss>.canvas` */
export function suspectCanvasName(fileName: string, date: Date): string {
  return `${plainFileName(canvasFileBaseName(fileName))}.suspect-${formatCanvasStamp(date)}.canvas`;
}

/** 冲突副本名（Syncthing 风格）：`<book>.conflict-<YYYYMMDD-HHmmss>.canvas` */
export function conflictCanvasName(fileName: string, date: Date): string {
  return `${plainFileName(canvasFileBaseName(fileName))}.conflict-${formatCanvasStamp(date)}.canvas`;
}

/**
 * 是否为本词库的冲突副本。
 * 兼容两种命名：
 * - 新（Syncthing 风格）：`<book>.conflict-YYYYMMDD-HHmmss.canvas`
 * - 旧（iCloud/Obsidian 旧行为）：`<book> 1.canvas`（空格 + 数字）
 * `suspect-*` 属于另一类（校验失败另存），不计入冲突副本。
 */
export function isConflictCopyName(baseName: string, fileName: string): boolean {
  const base = plainFileName(canvasFileBaseName(baseName));
  const name = plainFileName(fileName);
  if (new RegExp(`^${escapeRegExp(base)}\\.conflict-\\d{8}-\\d{6}\\.canvas$`).test(name)) return true;
  return new RegExp(`^${escapeRegExp(base)} \\d+\\.canvas$`).test(name);
}

/** `suspect-*` 副本的识别，供体检/清理提示使用 */
export function isSuspectCopyName(baseName: string, fileName: string): boolean {
  const base = plainFileName(canvasFileBaseName(baseName));
  return new RegExp(`^${escapeRegExp(base)}\\.suspect-\\d{8}-\\d{6}\\.canvas$`).test(plainFileName(fileName));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

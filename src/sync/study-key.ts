import type { WordDefinition } from "../hiwords/utils";

/**
 * studyKey 双规则（与 vocabulary-manager.buildStudyItemCache 完全一致）：
 * - .hiwords 卡片词条：definition.studyKey 原样使用；
 * - Canvas 普通节点：`${source}:${nodeId}`。
 */
export function deriveStudyKey(definition: WordDefinition): string {
  return definition.studyKey || `${definition.source}:${definition.nodeId}`;
}

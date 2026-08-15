# Note Bar 手机同步（插件端）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Note Bar 插件内新增 `src/sync/` 模块，把 `data.json` 中的 FSRS 进度导出为 iCloud 同步目录里的边车文件（`.nb-sync.json`），并把手机写回的边车合并回 `data.json`，同时把 vault 内的 Canvas 词库与 iCloud 同步目录做双向镜像。

**Architecture:** 六个纯函数/类模块：`study-key`（双规则键推导）、`sidecar-store`（边车读写）、`merge`（进度合并仲裁）、`sync-exporter`（导出）、`sync-importer`（导入）、`mirrorer`（Canvas 镜像）；`SyncManager` 负责编排与接线，设置存于 `HiWordsSettings.mobileSync`，`main.ts` 只做初始化、事件挂钩和设置页。

**Tech Stack:** TypeScript 4.7、Obsidian API、Node `fs`/`path`（Electron 主进程可用）、esbuild + Node 22 `node:test`（经 esbuild 编译后运行，不引入 ts-node/tsx）。

**设计依据:** [2026-08-14-note-bar-ios-sync-design.md](./docs/superpowers/specs/2026-08-14-note-bar-ios-sync-design.md)（第 2 版，已两轮源码审查）。

---

## 文件映射

| 文件 | 职责 |
|---|---|
| `scripts/build-tests.mjs` | esbuild 编译 `tests/**/*.test.ts` 到 `.tests-dist/`，再跑 `node --test` |
| `src/sync/types.ts` | `SidecarFile`、`MobileSyncSettings`、导出/导入结果类型、版本常量 |
| `src/sync/study-key.ts` | `deriveStudyKey`：普通节点 `source:nodeId`，卡片 `studyKey` 原样 |
| `src/sync/sidecar-store.ts` | 边车路径计算、读取（版本校验）、原子写入 |
| `src/sync/merge.ts` | `mergeProgress`（lastReview 仲裁）、`mergeHistory`（去重截断 50）、冲突副本识别 |
| `src/sync/sync-exporter.ts` | `studyProgress` → 按词库写边车 |
| `src/sync/sync-importer.ts` | 边车 → 合并回 `studyProgress`，处理冲突副本 |
| `src/sync/mirrorer.ts` | vault Canvas ⇄ iCloud 目录双向复制（防抖 + 轮询 + 冲突检测） |
| `src/sync/folder-picker.ts` | `pickDirectory()`：Electron 对话框选择目录 |
| `src/sync/sync-manager.ts` | 编排导出/导入/镜像、冲突日志、防抖 |
| `src/hiwords/utils/types.ts` | 新增 `MobileSyncSettings` 与 `HiWordsSettings.mobileSync` |
| `src/main.ts` | 默认设置、初始化/停止 SyncManager、评分保存后导出、vault 事件挂钩镜像、设置页分区 |
| `package.json` / `.gitignore` | 新增 `test` 脚本；忽略 `.tests-dist/` |
| `tests/**/*.test.ts` | 单元测试 |

## 全局约定

- 边车文件名：`<词库相对路径去 .canvas>.nb-sync.json`，只存在于 iCloud 同步目录，**不写进 vault**。
- `studyKey` 双规则与 [vocabulary-manager.ts](./src/hiwords/core/vocabulary-manager.ts) 第 706 行回退逻辑完全一致：`definition.studyKey || `${definition.source}:${definition.nodeId}``。
- 进度合并：同 key 以 `lastReview` 较新者胜；`history` 按 `(date, quality)` 去重、按时间升序、`slice(-50)`。
- 原子写：临时文件 + `rename`；解析失败返回 null、退避重试由调用方决定。
- 所有文件路径用 `/`（`path.join` 已跨平台；设置里保存绝对路径时统一 `replace(/\\/g, '/')`）。

---

## Task 1：测试基建

**Files:**
- Create: `scripts/build-tests.mjs`
- Create: `tests/smoke.test.ts`
- Modify: `package.json`、`.gitignore`

- [ ] **Step 1: 写冒烟测试**

创建 `tests/smoke.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("smoke", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: 写测试构建脚本**

创建 `scripts/build-tests.mjs`：

```js
import esbuild from "esbuild";
import builtins from "builtin-modules";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

const outdir = ".tests-dist";
rmSync(outdir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: ["tests/**/*.test.ts"],
  outdir,
  format: "cjs",
  platform: "node",
  target: "es2018",
  bundle: true,
  external: [...builtins, "obsidian", "electron"],
  logLevel: "info",
});

execSync(`node --test ${outdir}`, { stdio: "inherit" });
```

- [ ] **Step 3: 接线 npm script 与忽略规则**

`package.json` 的 `scripts` 增加：

```json
"test": "node scripts/build-tests.mjs"
```

`.gitignore` 末尾追加一行：

```text
.tests-dist/
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: PASS，输出 `tests 1 ... pass 1`

- [ ] **Step 5: 让 tsc 不检查测试目录**

`tsconfig.json` 的 `exclude` 改为：

```json
"exclude": ["node_modules", "references", "src/annotation", "tests", ".tests-dist"]
```

（原因：`@types/node@16` 没有 `node:test` 类型，测试由 esbuild 编译、不经 `tsc` 类型检查。）

- [ ] **Step 6: 提交**

```bash
git add scripts/build-tests.mjs tests/smoke.test.ts package.json .gitignore tsconfig.json
git commit -m "test: add esbuild + node:test runner for sync module"
```

---

## Task 2：同步设置类型与默认值

**Files:**
- Modify: `src/hiwords/utils/types.ts`（`HiWordsSettings` 接口附近）
- Modify: `src/main.ts`（`DEFAULT_HIWORDS_SETTINGS`）

- [ ] **Step 1: 新增类型**

在 `types.ts` 的 `HiWordsSettings` 之前插入：

```ts
/** 手机同步设置（iOS App 经 iCloud Drive 目录同步） */
export interface MobileSyncSettings {
    enabled: boolean;
    /** iCloud 同步目录绝对路径 */
    syncDir: string;
    /** 轮询间隔（秒），默认 15 */
    pollIntervalSec: number;
}
```

并在 `HiWordsSettings` 接口中追加字段：

```ts
/** 手机同步（iOS App） */
mobileSync?: MobileSyncSettings;
```

- [ ] **Step 2: 默认值**

在 `main.ts` 的 `DEFAULT_HIWORDS_SETTINGS` 对象末尾（`retireCandidateDays: 90,` 之后）追加：

```ts
mobileSync: {
  enabled: false,
  syncDir: '',
  pollIntervalSec: 15,
},
```

- [ ] **Step 3: 类型检查**

Run: `npm run build`
Expected: esbuild 成功输出 `main.js`（`tsc -noEmit` 无错误）

- [ ] **Step 4: 提交**

```bash
git add src/hiwords/utils/types.ts src/main.ts
git commit -m "feat: add mobileSync settings type and defaults"
```

---

## Task 3：studyKey 双规则工具

**Files:**
- Create: `src/sync/study-key.ts`
- Test: `tests/sync/study-key.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/sync/study-key.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveStudyKey } from "../../src/sync/study-key";

test("Canvas 普通节点无 studyKey 时回退为 source:nodeId", () => {
  const def = { source: "English/words.canvas", nodeId: "abcd1234abcd1234" } as any;
  assert.equal(deriveStudyKey(def), "English/words.canvas:abcd1234abcd1234");
});

test("卡片词条已有 studyKey 时原样返回", () => {
  const def = { studyKey: "und:word:hello", source: "x.canvas", nodeId: "y" } as any;
  assert.equal(deriveStudyKey(def), "und:word:hello");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../../src/sync/study-key'`

- [ ] **Step 3: 实现**

创建 `src/sync/study-key.ts`：

```ts
import type { WordDefinition } from "../hiwords/utils";

/**
 * studyKey 双规则（与 vocabulary-manager.buildStudyItemCache 完全一致）：
 * - .hiwords 卡片词条：definition.studyKey 原样使用；
 * - Canvas 普通节点：`${source}:${nodeId}`。
 */
export function deriveStudyKey(definition: WordDefinition): string {
  return definition.studyKey || `${definition.source}:${definition.nodeId}`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS（2 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/sync/study-key.ts tests/sync/study-key.test.ts
git commit -m "feat: add dual-rule studyKey derivation for sync"
```

---

## Task 4：边车类型与存储

**Files:**
- Create: `src/sync/types.ts`、`src/sync/sidecar-store.ts`
- Test: `tests/sync/sidecar-store.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/sync/sidecar-store.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSidecar, sidecarPathForBook, writeSidecarAtomic } from "../../src/sync/sidecar-store";

test("原子写后可读回，版本与字段完整", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-sidecar-"));
  try {
    const p = sidecarPathForBook(dir, "English/words.canvas");
    assert.equal(p, path.join(dir, "English/words.nb-sync.json"));
    await writeSidecarAtomic(p, { version: 1, book: "English/words.canvas", words: {}, updatedAt: "2026-08-14T00:00:00+08:00" });
    const data = await readSidecar(p);
    assert.equal(data?.book, "English/words.canvas");
    assert.equal(data?.version, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("版本不符或 JSON 损坏返回 null", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-sidecar-"));
  try {
    const p = path.join(dir, "bad.nb-sync.json");
    await writeSidecarAtomic(p, { version: 99, book: "x.canvas", words: {}, updatedAt: "" } as any);
    assert.equal(await readSidecar(p), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现类型**

创建 `src/sync/types.ts`：

```ts
import type { StudyProgressItem } from "../hiwords/utils";

export const SIDECAR_VERSION = 1;
export const SIDECAR_SUFFIX = ".nb-sync.json";

/** 一个词库对应的进度边车文件（只存进度，不存单词内容） */
export interface SidecarFile {
  version: number;
  /** 词库 .canvas 在 vault/同步目录中的相对路径 */
  book: string;
  words: Record<string, StudyProgressItem>;
  updatedAt: string;
}

export interface SyncExportResult {
  written: number;
  unchanged: number;
  failed: string[];
}

export interface SyncImportResult {
  mergedKeys: number;
  conflictsArchived: string[];
}
```

- [ ] **Step 4: 实现存储**

创建 `src/sync/sidecar-store.ts`：

```ts
import { promises as fs } from "fs";
import * as path from "path";
import { SIDECAR_SUFFIX, SIDECAR_VERSION, type SidecarFile } from "./types";

/** `<词库>.canvas` → `<词库>.nb-sync.json`（位于同步目录下同一相对路径） */
export function sidecarPathForBook(syncDir: string, bookRelPath: string): string {
  const base = bookRelPath.endsWith(".canvas")
    ? bookRelPath.slice(0, -".canvas".length)
    : bookRelPath;
  return path.join(syncDir, `${base}${SIDECAR_SUFFIX}`);
}

export async function readSidecar(filePath: string): Promise<SidecarFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as Partial<SidecarFile>;
    if (
      data?.version !== SIDECAR_VERSION ||
      typeof data.book !== "string" ||
      !data.words ||
      typeof data.words !== "object" ||
      Array.isArray(data.words)
    ) {
      return null;
    }
    return {
      version: SIDECAR_VERSION,
      book: data.book,
      words: data.words as SidecarFile["words"],
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeSidecarAtomic(filePath: string, data: SidecarFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/sync/types.ts src/sync/sidecar-store.ts tests/sync/sidecar-store.test.ts
git commit -m "feat: add sidecar file types and atomic store"
```

---

## Task 5：进度合并仲裁

**Files:**
- Create: `src/sync/merge.ts`
- Test: `tests/sync/merge.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/sync/merge.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictCopyBaseName, isConflictCopyName, mergeHistory, mergeProgress } from "../../src/sync/merge";

test("lastReview 较新者胜，history 按去重后时间序合并", () => {
  const local = {
    s: 10,
    lastReview: "2026-08-12T00:00:00.000Z",
    history: [{ date: "2026-08-12T00:00:00.000Z", quality: "good" as const }],
  };
  const remote = {
    s: 99,
    lastReview: "2026-08-13T00:00:00.000Z",
    history: [{ date: "2026-08-13T00:00:00.000Z", quality: "again" as const }],
  };
  const merged = mergeProgress(local as any, remote as any)!;
  assert.equal(merged.s, 99);
  assert.deepEqual(merged.history, [
    { date: "2026-08-12T00:00:00.000Z", quality: "good" },
    { date: "2026-08-13T00:00:00.000Z", quality: "again" },
  ]);
});

test("重复记录去重，且最多保留最近 50 条", () => {
  const a = Array.from({ length: 50 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    quality: "good" as const,
  }));
  const b = [a[0], { date: "2026-08-14T00:00:00.000Z", quality: "hard" as const }];
  const merged = mergeHistory(a, b)!;
  assert.equal(merged.length, 50);
  assert.equal(merged[0].quality, "good");
  assert.equal(merged[49].quality, "hard");
});

test("单侧存在时直接返回该侧", () => {
  assert.equal(mergeProgress(undefined, undefined), undefined);
  assert.equal(mergeProgress({ s: 5 } as any, undefined)!.s, 5);
});

test("识别 Apple 风格冲突副本命名", () => {
  assert.equal(isConflictCopyName("英语词库 2.nb-sync.json"), true);
  assert.equal(conflictCopyBaseName("英语词库 2.nb-sync.json"), "英语词库.nb-sync.json");
  assert.equal(isConflictCopyName("英语词库.nb-sync.json"), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/sync/merge.ts`：

```ts
import type { ReviewRecord, StudyProgressItem } from "../hiwords/utils";

const HISTORY_LIMIT = 50;

export function timeOf(value: string | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

export function mergeHistory(
  a: ReviewRecord[] | undefined,
  b: ReviewRecord[] | undefined
): ReviewRecord[] | undefined {
  const map = new Map<string, ReviewRecord>();
  for (const record of [...(a || []), ...(b || [])]) {
    const key = `${record.date}|${record.quality}`;
    const existing = map.get(key);
    if (!existing || timeOf(record.date) >= timeOf(existing.date)) {
      map.set(key, record);
    }
  }
  const merged = Array.from(map.values()).sort(
    (x, y) => timeOf(x.date) - timeOf(y.date)
  );
  return merged.length > 0 ? merged.slice(-HISTORY_LIMIT) : undefined;
}

/** 同 key 进度合并：lastReview 较新者胜；history 去重合并（保留 50 条） */
export function mergeProgress(
  local: StudyProgressItem | undefined,
  remote: StudyProgressItem | undefined
): StudyProgressItem | undefined {
  if (!local) return remote;
  if (!remote) return local;
  const winner = timeOf(remote.lastReview) > timeOf(local.lastReview) ? remote : local;
  const loser = winner === remote ? local : remote;
  const merged: StudyProgressItem = { ...loser, ...winner };
  const history = mergeHistory(local.history, remote.history);
  if (history) merged.history = history;
  return merged;
}

/** Apple iCloud 冲突副本：`<name> <n>.nb-sync.json` */
export function isConflictCopyName(fileName: string): boolean {
  return /^.+ \d+\.nb-sync\.json$/.test(fileName);
}

export function conflictCopyBaseName(fileName: string): string | null {
  const match = /^(.+) \d+\.nb-sync\.json$/.exec(fileName);
  return match ? `${match[1]}.nb-sync.json` : null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sync/merge.ts tests/sync/merge.test.ts
git commit -m "feat: add lastReview-wins progress merge with conflict-copy detection"
```

---

## Task 6：导出器

**Files:**
- Create: `src/sync/sync-exporter.ts`
- Test: `tests/sync/sync-exporter.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/sync/sync-exporter.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportProgressToSidecars } from "../../src/sync/sync-exporter";
import { sidecarPathForBook } from "../../src/sync/sidecar-store";

test("只导出已启用 Canvas 词库中、能推导出 studyKey 的进度", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-export-"));
  try {
    const manager = {
      getWordDefinitionsByBook: async (bookPath: string) =>
        bookPath === "English/words.canvas"
          ? [{ source: "English/words.canvas", nodeId: "n1", word: "hello", definition: "你好" }]
          : [],
    };
    const settings: any = {
      vocabularyBooks: [
        { path: "English/words.canvas", name: "英语", enabled: true },
        { path: "Legal/law.canvas", name: "法律", enabled: true },
        { path: "Off/off.canvas", name: "关闭", enabled: false },
      ],
      studyProgress: {
        "English/words.canvas:n1": { s: 30, d: 5, dueDate: "2026-08-20" },
        orphanKey: { s: 1 }, // 无对应词条，不导出
      },
    };
    const result = await exportProgressToSidecars({ settings, vocabularyManager: manager as any, syncDir: dir });
    assert.equal(result.written, 2);
    const raw = JSON.parse(await readFile(sidecarPathForBook(dir, "English/words.canvas"), "utf8"));
    assert.equal(raw.words["English/words.canvas:n1"].s, 30);
    assert.equal(raw.words.orphanKey, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/sync/sync-exporter.ts`：

```ts
import type { VocabularyManager } from "../hiwords/core/vocabulary-manager";
import type { HiWordsSettings, StudyProgressItem } from "../hiwords/utils";
import { readSidecar, sidecarPathForBook, writeSidecarAtomic } from "./sidecar-store";
import { deriveStudyKey } from "./study-key";
import { SIDECAR_VERSION, type SyncExportResult } from "./types";

export interface ExporterDeps {
  settings: HiWordsSettings;
  vocabularyManager: VocabularyManager;
  syncDir: string;
}

/** 把 data.json 的 studyProgress 按词库导出为边车；孤儿进度键留在 data.json，不导出 */
export async function exportProgressToSidecars(deps: ExporterDeps): Promise<SyncExportResult> {
  const result: SyncExportResult = { written: 0, unchanged: 0, failed: [] };
  const progress: Record<string, StudyProgressItem> = deps.settings.studyProgress || {};
  const books = deps.settings.vocabularyBooks.filter(
    (book) => book.enabled && book.path.endsWith(".canvas")
  );
  const updatedAt = new Date().toISOString();

  for (const book of books) {
    try {
      const definitions = await deps.vocabularyManager.getWordDefinitionsByBook(book.path);
      const words: Record<string, StudyProgressItem> = {};
      for (const definition of definitions) {
        const key = deriveStudyKey(definition);
        const item = progress[key];
        if (item) words[key] = item;
      }

      const filePath = sidecarPathForBook(deps.syncDir, book.path);
      const existing = await readSidecar(filePath);
      if (existing && JSON.stringify(existing.words) === JSON.stringify(words)) {
        result.unchanged++;
        continue;
      }

      await writeSidecarAtomic(filePath, {
        version: SIDECAR_VERSION,
        book: book.path,
        words,
        updatedAt,
      });
      result.written++;
    } catch {
      result.failed.push(book.path);
    }
  }
  return result;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sync/sync-exporter.ts tests/sync/sync-exporter.test.ts
git commit -m "feat: export studyProgress to per-book sidecar files"
```

---

## Task 7：导入器

**Files:**
- Create: `src/sync/sync-importer.ts`
- Test: `tests/sync/sync-importer.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/sync/sync-importer.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importSidecars } from "../../src/sync/sync-importer";
import { SIDECAR_VERSION } from "../../src/sync/types";

test("把边车进度合并回 studyProgress，lastReview 较新者胜", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nb-import-"));
  try {
    await writeFile(
      path.join(dir, "English", "words.nb-sync.json"),
      JSON.stringify({
        version: SIDECAR_VERSION,
        book: "English/words.canvas",
        words: {
          "English/words.canvas:n1": {
            s: 99,
            lastReview: "2026-08-13T00:00:00.000Z",
            history: [{ date: "2026-08-13T00:00:00.000Z", quality: "easy" }],
          },
        },
        updatedAt: "2026-08-13T00:00:00.000Z",
      }),
      "utf8"
    );
    const settings: any = {
      vocabularyBooks: [{ path: "English/words.canvas", name: "英语", enabled: true }],
      studyProgress: {
        "English/words.canvas:n1": { s: 10, lastReview: "2026-08-12T00:00:00.000Z" },
      },
    };
    const result = await importSidecars({ settings, syncDir: dir });
    assert.equal(result.mergedKeys, 1);
    assert.equal(settings.studyProgress["English/words.canvas:n1"].s, 99);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/sync/sync-importer.ts`：

```ts
import { promises as fs } from "fs";
import * as path from "path";
import type { HiWordsSettings } from "../hiwords/utils";
import { conflictCopyBaseName, mergeProgress, timeOf } from "./merge";
import { readSidecar } from "./sidecar-store";
import type { SidecarFile, SyncImportResult } from "./types";

export interface ImporterDeps {
  settings: HiWordsSettings;
  syncDir: string;
}

/** 把同步目录里所有已启用词库的边车合并回 data.json */
export async function importSidecars(deps: ImporterDeps): Promise<SyncImportResult> {
  const result: SyncImportResult = { mergedKeys: 0, conflictsArchived: [] };
  if (!deps.settings.studyProgress) deps.settings.studyProgress = {};
  const progress = deps.settings.studyProgress;
  const books = deps.settings.vocabularyBooks.filter(
    (book) => book.enabled && book.path.endsWith(".canvas")
  );

  for (const book of books) {
    const base = book.path.replace(/\.canvas$/, "");
    const mainName = `${base}.nb-sync.json`;
    const mainPath = path.join(deps.syncDir, mainName);
    let selected: SidecarFile | null = await readSidecar(mainPath);
    let selectedName = mainName;

    const entries = await fs.readdir(deps.syncDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (conflictCopyBaseName(entry) !== mainName) continue;
      const conflict = await readSidecar(path.join(deps.syncDir, entry));
      if (conflict && timeOf(conflict.updatedAt) > timeOf(selected?.updatedAt)) {
        selected = conflict;
        selectedName = entry;
      }
    }

    if (selectedName !== mainName && selected) {
      const archive = `${mainPath}.conflict-${Date.now()}.bak`;
      await fs.rename(mainPath, archive).catch(() => undefined);
      await fs.copyFile(path.join(deps.syncDir, selectedName), mainPath);
      await fs.rename(path.join(deps.syncDir, selectedName), `${selectedName}.processed`).catch(() => undefined);
      result.conflictsArchived.push(book.path);
    }

    if (!selected) continue;
    for (const [key, remote] of Object.entries(selected.words)) {
      const merged = mergeProgress(progress[key], remote);
      if (merged) progress[key] = merged;
      result.mergedKeys++;
    }
  }
  return result;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sync/sync-importer.ts tests/sync/sync-importer.test.ts
git commit -m "feat: import and merge phone-side sidecars into data.json"
```

---

## Task 8：Canvas 镜像器

**Files:**
- Create: `src/sync/mirrorer.ts`
- Test: `tests/sync/mirrorer.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/sync/mirrorer.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Mirrorer } from "../../src/sync/mirrorer";

function utimeMs(ms: number) {
  return new Date(ms);
}

test("vault 新增词库复制到同步目录；同步目录更新复制回 vault", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nb-mirror-"));
  const vault = path.join(root, "vault");
  const sync = path.join(root, "sync");
  const bookPath = "English/words.canvas";
  const vaultFile = path.join(vault, bookPath);
  const syncFile = path.join(sync, bookPath);
  await mkdir(path.dirname(vaultFile), { recursive: true });

  const books = [{ path: bookPath, name: "英语", enabled: true }];
  const conflicts: string[] = [];
  const mirrorer = new Mirrorer({
    vaultBasePath: vault,
    syncDir: sync,
    books,
    onConflict: (msg) => conflicts.push(msg),
    onVaultChanged: () => undefined,
  });

  try {
    await writeFile(vaultFile, '{"nodes":[{"id":"n1","type":"text","text":"hello"}]}', "utf8");
    await mirrorer.syncOnce();
    assert.equal(await readFile(syncFile, "utf8"), await readFile(vaultFile, "utf8"));

    await writeFile(syncFile, '{"nodes":[{"id":"n2","type":"text","text":"world"}]}', "utf8");
    await utimes(syncFile, utimeMs(Date.now() + 60000), utimeMs(Date.now() + 60000));
    await mirrorer.syncOnce();
    assert.equal(await readFile(vaultFile, "utf8"), '{"nodes":[{"id":"n2","type":"text","text":"world"}]}');
  } finally {
    mirrorer.stop();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/sync/mirrorer.ts`：

```ts
import { promises as fs } from "fs";
import * as path from "path";
import type { VocabularyBook } from "../hiwords/utils";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MirrorerOptions {
  vaultBasePath: string;
  syncDir: string;
  books: VocabularyBook[];
  onConflict: (message: string) => void;
  onVaultChanged: (bookPath: string) => void;
}

/** vault 内 Canvas ⇄ iCloud 同步目录双向镜像（mtime 比较 + 轮询兜底） */
export class Mirrorer {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly opts: MirrorerOptions) {}

  private get bookPaths(): string[] {
    return this.opts.books
      .filter((book) => book.enabled && book.path.endsWith(".canvas"))
      .map((book) => book.path);
  }

  start(pollIntervalSec: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.syncOnce();
    }, Math.max(1, pollIntervalSec) * 1000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  stop(): void {
    this.stopPolling();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  scheduleSync(bookPath: string, delayMs = 1500): void {
    if (!this.bookPaths.includes(bookPath)) return;
    this.timers.push(
      setTimeout(() => {
        void this.syncBook(bookPath);
      }, delayMs)
    );
  }

  async syncOnce(): Promise<void> {
    for (const bookPath of this.bookPaths) {
      await this.syncBook(bookPath);
    }
  }

  private async syncBook(bookPath: string): Promise<void> {
    const src = path.join(this.opts.vaultBasePath, bookPath);
    const dst = path.join(this.opts.syncDir, bookPath);
    try {
      const [srcStat, dstStat] = await Promise.all([
        fs.stat(src).catch(() => null),
        fs.stat(dst).catch(() => null),
      ]);
      if (!srcStat && !dstStat) return;
      if (srcStat && !dstStat) {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
        return;
      }
      if (!srcStat && dstStat) {
        await fs.mkdir(path.dirname(src), { recursive: true });
        await fs.copyFile(dst, src);
        this.opts.onVaultChanged(bookPath);
        return;
      }
      if (Math.abs(srcStat!.mtimeMs - dstStat!.mtimeMs) < 1000) return;
      if (srcStat!.mtimeMs > dstStat!.mtimeMs) {
        await fs.copyFile(src, dst);
      } else {
        await fs.copyFile(dst, src);
        this.opts.onVaultChanged(bookPath);
      }
    } catch (error) {
      console.warn("Note Bar mirrorer 同步失败:", bookPath, error);
    }
    await this.detectCanvasConflicts(bookPath);
  }

  private async detectCanvasConflicts(bookPath: string): Promise<void> {
    const base = path.basename(bookPath.slice(0, -".canvas".length));
    const dir = path.dirname(path.join(this.opts.syncDir, bookPath));
    try {
      const entries = await fs.readdir(dir);
      const regexp = new RegExp(`^${escapeRegExp(base)} \\d+\\.canvas$`);
      const conflicts = entries.filter((entry) => regexp.test(entry));
      if (conflicts.length > 0) {
        this.opts.onConflict(`检测到 Canvas 冲突副本：${conflicts.join("、")}，请人工选择保留版本`);
      }
    } catch {
      // 目录不存在时忽略
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sync/mirrorer.ts tests/sync/mirrorer.test.ts
git commit -m "feat: add bidirectional canvas mirrorer with polling fallback"
```

---

## Task 9：目录选择器与设置页分区

**Files:**
- Create: `src/sync/folder-picker.ts`
- Modify: `src/main.ts`（`NoteBarSettingTab.display()` 末尾）

- [ ] **Step 1: 抽出目录选择器**

创建 `src/sync/folder-picker.ts`（复用 [export-vocabulary-modal.ts](./src/hiwords/ui/export-vocabulary-modal.ts) 第 303 行起的两通道逻辑）：

```ts
/** 打开系统目录选择对话框；返回绝对路径（统一 / 分隔符），取消返回 null */
export async function pickDirectory(): Promise<string | null> {
  try {
    const win = window as any;
    if (win.require) {
      const electron = win.require("electron");
      const properties = ["openDirectory", "createDirectory"];
      if (electron.remote && electron.remote.dialog) {
        const result = await electron.remote.dialog.showOpenDialog({ properties });
        return result.filePaths?.[0]?.replace(/\\/g, "/") ?? null;
      }
      if (electron.ipcRenderer && electron.ipcRenderer.invoke) {
        const result = await electron.ipcRenderer.invoke("show-open-dialog", { properties });
        return result.filePaths?.[0]?.replace(/\\/g, "/") ?? null;
      }
    }
  } catch (error) {
    console.warn("Note Bar 目录选择失败:", error);
  }
  return null;
}
```

- [ ] **Step 2: 设置页新增「手机同步」分区**

在 `NoteBarSettingTab.display()` 方法末尾（`containerEl.empty()` 之后的最后一个设置项之后）追加：

```ts
containerEl.createEl("h3", { text: "手机同步（iOS App）" });
const mobileSync = this.plugin.hiwordsSettings.mobileSync ?? {
  enabled: false,
  syncDir: "",
  pollIntervalSec: 15,
};
this.plugin.hiwordsSettings.mobileSync = mobileSync;

new Setting(containerEl)
  .setName("启用手机同步")
  .setDesc("把进度导出为边车文件，并与 iPhone App 双向同步")
  .addToggle((toggle) =>
    toggle.setValue(mobileSync.enabled).onChange(async (value) => {
      mobileSync.enabled = value;
      await this.plugin.saveHiWordsSettings();
      if (value) await this.plugin.syncManager?.start();
      else this.plugin.syncManager?.stop();
    })
  );

new Setting(containerEl)
  .setName("iCloud 同步目录")
  .setDesc("选择一个 iCloud Drive 目录，Canvas 镜像与 .nb-sync.json 边车都放这里")
  .addButton((button) =>
    button.setButtonText("选择目录").onClick(async () => {
      const dir = await pickDirectory();
      if (!dir) return;
      mobileSync.syncDir = dir;
      await this.plugin.saveHiWordsSettings();
      await this.plugin.syncManager?.start();
    })
  );

new Setting(containerEl)
  .setName("轮询间隔（秒）")
  .setDesc("检测 iCloud 目录变化的兜底轮询频率，默认 15")
  .addText((text) =>
    text
      .setValue(String(mobileSync.pollIntervalSec))
      .onChange(async (value) => {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 1) {
          mobileSync.pollIntervalSec = n;
          await this.plugin.saveHiWordsSettings();
        }
      })
  );

new Setting(containerEl)
  .setName("手动同步")
  .setDesc("立即执行一次导出或导入")
  .addButton((button) =>
    button.setButtonText("立即导出").onClick(async () => {
      const result = await this.plugin.syncManager?.exportAll(true);
      new Notice(`导出完成：写入 ${result?.written ?? 0}，跳过 ${result?.unchanged ?? 0}`);
    })
  )
  .addButton((button) =>
    button.setButtonText("立即导入").onClick(async () => {
      const result = await this.plugin.syncManager?.importAll();
      new Notice(`导入完成：合并 ${result?.mergedKeys ?? 0} 个进度键`);
    })
  );
```

- [ ] **Step 3: 暂不构建**

本步骤先不运行 `npm run build`：设置页引用了 `this.plugin.syncManager`，该属性在 Task 10 才定义。Task 9 与 Task 10 一起完成后，在 Task 10 Step 6 统一验证构建。

- [ ] **Step 4: 提交**

```bash
git add src/sync/folder-picker.ts src/main.ts
git commit -m "feat: add mobile sync settings section with folder picker"
```

> 说明：Task 9 与 Task 10 都会修改 `main.ts`，且 Task 9 依赖 Task 10 的属性定义，因此两者可连续执行、最后统一构建验证。

---

## Task 10：SyncManager 与 main.ts 接线

**Files:**
- Create: `src/sync/sync-manager.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 实现编排器**

创建 `src/sync/sync-manager.ts`：

```ts
import { Notice } from "obsidian";
import type NoteBarPlugin from "../main";
import { Mirrorer } from "./mirrorer";
import { exportProgressToSidecars } from "./sync-exporter";
import { importSidecars } from "./sync-importer";
import type { SyncExportResult, SyncImportResult } from "./types";

/** 手机同步编排：镜像 + 导出 + 导入 + 冲突日志 */
export class SyncManager {
  private mirrorer: Mirrorer | null = null;
  private exportTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  readonly conflicts: string[] = [];

  constructor(private readonly plugin: NoteBarPlugin) {}

  get isRunning(): boolean {
    return this.running;
  }

  private get config() {
    return this.plugin.hiwordsSettings.mobileSync;
  }

  async start(): Promise<void> {
    const cfg = this.config;
    if (!cfg?.enabled || !cfg.syncDir) return;
    const vaultBase = (this.plugin.app.vault.adapter as any).getBasePath?.() as string | undefined;
    if (!vaultBase) return;
    this.stop();
    this.mirrorer = new Mirrorer({
      vaultBasePath: vaultBase,
      syncDir: cfg.syncDir,
      books: this.plugin.hiwordsSettings.vocabularyBooks,
      onConflict: (message) => {
        this.conflicts.push(message);
        new Notice(message);
      },
      onVaultChanged: (bookPath) => {
        void this.plugin.vocabularyManager?.reloadVocabularyBook(bookPath);
        this.plugin.refreshHighlighter();
      },
    });
    this.mirrorer.start(cfg.pollIntervalSec || 15);
    this.running = true;
    await this.mirrorer.syncOnce();
    await this.exportAll(true);
  }

  stop(): void {
    this.mirrorer?.stop();
    this.mirrorer = null;
    if (this.exportTimer) {
      clearTimeout(this.exportTimer);
      this.exportTimer = null;
    }
    this.running = false;
  }

  scheduleMirror(bookPath: string): void {
    this.mirrorer?.scheduleSync(bookPath);
  }

  async exportAll(immediate = false): Promise<SyncExportResult | null> {
    const cfg = this.config;
    if (!this.running || !cfg?.syncDir || !this.plugin.vocabularyManager) return null;
    if (!immediate) {
      if (this.exportTimer) clearTimeout(this.exportTimer);
      return await new Promise((resolve) => {
        this.exportTimer = setTimeout(async () => {
          this.exportTimer = null;
          resolve(
            await exportProgressToSidecars({
              settings: this.plugin.hiwordsSettings,
              vocabularyManager: this.plugin.vocabularyManager!,
              syncDir: cfg.syncDir,
            })
          );
        }, 500);
      });
    }
    return exportProgressToSidecars({
      settings: this.plugin.hiwordsSettings,
      vocabularyManager: this.plugin.vocabularyManager,
      syncDir: cfg.syncDir,
    });
  }

  async importAll(): Promise<SyncImportResult | null> {
    const cfg = this.config;
    if (!this.running || !cfg?.syncDir) return null;
    const result = await importSidecars({ settings: this.plugin.hiwordsSettings, syncDir: cfg.syncDir });
    await this.plugin.saveHiWordsSettings();
    this.plugin.refreshHighlighter();
    return result;
  }
}
```

- [ ] **Step 2: main.ts 添加字段与初始化**

在 `NoteBarPlugin` 类字段区（`encounterTracker` 附近）新增：

```ts
syncManager: SyncManager | null = null;
```

文件顶部新增导入：

```ts
import { SyncManager } from "./sync/sync-manager";
```

在 `onload()` 中 `this.vocabularyManager = new VocabularyManager(...)` 之后新增：

```ts
this.syncManager = new SyncManager(this);
```

在现有 `onLayoutReady` 回调里、`await this.vocabularyManager!.loadAllVocabularyBooks();` 之后新增：

```ts
if (this.hiwordsSettings.mobileSync?.enabled) {
  await this.syncManager?.start();
}
```

- [ ] **Step 3: 评分保存后自动导出**

`saveHiWordsSettings()` 方法末尾（`trigger('hi-words:settings-changed')` 之后）新增：

```ts
if (this.hiwordsSettings.mobileSync?.enabled && this.syncManager?.isRunning) {
  void this.syncManager.exportAll();
}
```

- [ ] **Step 4: vault 事件挂钩镜像**

在 `registerVaultEvents()` 中：

1. `vault.on('modify')` 回调里、确认 `isVocabBook` 为 true 的分支中新增：`this.syncManager?.scheduleMirror(file.path);`
2. `handleRename` 完成后，对旧路径与重命名后的路径各调用一次：`this.syncManager?.scheduleMirror(oldPath);` 与 `this.syncManager?.scheduleMirror(file.path);`（`file` 为 TFile 时）。

- [ ] **Step 5: onunload 清理**

`onunload()` 中新增：

```ts
this.syncManager?.stop();
```

- [ ] **Step 6: 构建与测试**

Run: `npm test`
Expected: PASS

Run: `npm run build`
Expected: 通过，`main.js` 重新生成

- [ ] **Step 7: 提交**

```bash
git add src/sync/sync-manager.ts src/main.ts
git commit -m "feat: wire SyncManager into plugin lifecycle and rating save path"
```

---

## Task 11：端到端验收清单

**Files:** 无（手动验证）

- [ ] **Step 1: 部署到测试 vault**

```bash
mkdir -p "~/Documents/Obisidian-test-value/.obsidian/plugins/note-bar"
cp main.js styles.css manifest.json "~/Documents/Obisidian-test-value/.obsidian/plugins/note-bar/"
```

注意：**不要**覆盖测试 vault 的 `data.json`（保留用户数据）。

- [ ] **Step 2: 准备数据**

1. 在测试 vault 建一个 `English/words.canvas`，手动放一个词节点（首行 `hello`、空行、释义 `你好`）。
2. 插件设置 → 生词本，启用该词库。
3. 对 `hello` 做一次闪卡复习（写进度）。

- [ ] **Step 3: 验证导出**

1. 设置 → 手机同步 → 选择 iCloud Drive 下某目录（建议 `iCloud Drive/NoteBar`）。
2. 点「立即导出」。
3. 检查同步目录出现 `English/words.canvas`（镜像）与 `English/words.nb-sync.json`（边车，`words` 里有 `English/words.canvas:<nodeId>`，含 `s/d/dueDate/history`）。

- [ ] **Step 4: 验证导入**

1. 手工把边车里该词的 `s` 改成 999、`lastReview` 改成更晚时间，保存。
2. 点「立即导入」，再查看设置/复习界面，确认 999 生效（lastReview 仲裁）。

- [ ] **Step 5: 验证镜像回写**

1. 在 iCloud 目录里直接改 `English/words.canvas`（加一个 `world` 词节点），保存。
2. 等待 15s 轮询，确认 vault 内 `English/words.canvas` 同步出 `world`，侧边栏重载后出现该词。

- [ ] **Step 6: 验证冲突提示**

1. 在同步目录复制一份 `English/words 2.canvas`。
2. 等待轮询，确认 Obsidian 出现「检测到 Canvas 冲突副本」通知。

- [ ] **Step 7: 记录结果并提交任何修正确认**

全部通过后，插件端 M0/M1 完成。

---

## 自检记录

- Spec 覆盖：spec 第 5.2 节（mirrorer/sidecar-store/exporter/importer/设置页）、4.3（studyKey）、4.4（仲裁）、9（测试运行方案）均有对应任务。
- 无占位符：所有代码步骤给出完整实现；Task 9/10 的顺序依赖已显式说明。
- 类型一致：`SidecarFile`、`mergeProgress`、`deriveStudyKey`、`SyncManager` 的方法名在各任务间一致。

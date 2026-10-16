/**
 * 百度网盘 provider 镜像编排单测（假 client，不触网、不依赖 obsidian）。
 *
 * 覆盖（COVERED）
 *   - 推送：vault 词库内容有差异才上传；内容一致则一个请求都不发
 *   - 推送：本地词库结构非法时拒绝上传，并告警（坏数据不向云端扩散）
 *   - 拉取：远端 Canvas 较新 → 校验通过后落盘 + 触发 backup.scheduleBackup + 写审计
 *   - 拉取：远端 Canvas 结构非法 → **绝不覆盖 vault**，另存 `.suspect-*.canvas` 并告警
 *   - 拉取：节点数骤降（结构仍合法）→ 不阻断但必须让用户看见
 *   - 拉取：远端边车 → 用 merge.ts 的 mergeProgress 合并（lastReview 较新者胜）
 *   - 拉取：远端边车内容非法 → 拒绝合并并告警
 *   - 越界/异常：client 抛错时转成 failed + 可见告警，不把异常丢给调用方
 *   - 失败出口：onError 被调用；未启用词库被完全跳过
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BaiduPanProvider, type BaiduPanRemote, type RemoteFileEntry } from "../../src/sync/baidu-pan-provider";
import type { CanvasBackupService } from "../../src/sync/backup-service";
import { canvasAuditLogPath } from "../../src/sync/canvas-audit";
import { SIDECAR_SUFFIX, SIDECAR_VERSION } from "../../src/sync/types";
import type { HiWordsSettings, StudyProgressItem } from "../../src/hiwords/utils/types";

const BOOK = "Words/AI Agent.canvas";
const BOOK_B = "Words/Common Law.canvas";

function goodCanvas(text: string): string {
  return JSON.stringify({
    nodes: [
      { id: "g1", type: "group", x: 0, y: 0, width: 300, height: 200, label: "2026-09-27" },
      { id: "n1", type: "text", x: 24, y: 24, width: 260, height: 120, text },
    ],
    edges: [],
  });
}

function manyNodeCanvas(count: number): string {
  const nodes: unknown[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({ id: `n${i}`, type: "text", x: 0, y: i * 10, width: 260, height: 120, text: `w${i}` });
  }
  return JSON.stringify({ nodes, edges: [] });
}

function sidecarJson(words: Record<string, StudyProgressItem>): string {
  return JSON.stringify({ version: SIDECAR_VERSION, book: BOOK, words, updatedAt: "2026-10-16T00:00:00Z" });
}

function settings(overrides: Partial<HiWordsSettings> = {}): HiWordsSettings {
  return {
    vocabularyBooks: [{ path: BOOK, name: "AI", enabled: true }],
    studyProgress: {},
    showDefinitionOnHover: true,
    enableAutoHighlight: true,
    highlightStyle: "underline",
    enableMasteredFeature: true,
    showMasteredInSidebar: true,
    blurDefinitions: false,
    aiService: { provider: "openai-compatible", apiUrl: "", apiKey: "", model: "", extraParams: "{}" },
    aiDefinition: { enabled: false, prompt: "" },
    selectionTranslate: { enabled: false, targetLang: "zh-CN", prompt: "" },
    ...overrides,
  };
}

interface RemoteFile {
  bytes: Uint8Array;
  mtimeMs: number;
}

/** 内存假网盘：与真实 client 的语义对齐（fileMetas 缺文件返回 null） */
class FakeRemote implements BaiduPanRemote {
  readonly sandboxRoot = "/apps/NoteBar";
  readonly wordsDir = "/apps/NoteBar/Words";
  readonly files = new Map<string, RemoteFile>();
  readonly uploads: string[] = [];
  readonly dirs: string[] = [];
  uploadError: Error | null = null;

  put(remotePath: string, text: string, mtimeMs = Date.now()): void {
    this.files.set(remotePath, { bytes: new TextEncoder().encode(text), mtimeMs });
  }

  putBytes(remotePath: string, bytes: Uint8Array, mtimeMs = Date.now()): void {
    this.files.set(remotePath, { bytes, mtimeMs });
  }

  text(remotePath: string): string | null {
    const file = this.files.get(remotePath);
    return file ? new TextDecoder().decode(file.bytes) : null;
  }

  async fileMetas(
    paths: string[]
  ): Promise<Array<(RemoteFileEntry & { dlink: string | null }) | null>> {
    return paths.map((remotePath) => {
      const file = this.files.get(remotePath);
      if (!file) return null;
      return {
        name: remotePath.split("/").pop() || remotePath,
        path: remotePath,
        size: file.bytes.byteLength,
        serverMtimeMs: file.mtimeMs,
        dlink: `https://d.pcs.baidu.com/fake?p=${encodeURIComponent(remotePath)}`,
      };
    });
  }

  async downloadFile(remotePath: string): Promise<Uint8Array> {
    const file = this.files.get(remotePath);
    if (!file) {
      const error = new Error(`文件或目录不存在：${remotePath}`) as Error & { errno: number };
      error.errno = -9;
      throw error;
    }
    return file.bytes;
  }

  async uploadFile(remotePath: string, bytes: Uint8Array, _options?: { ondup?: string }): Promise<unknown> {
    if (this.uploadError) throw this.uploadError;
    this.uploads.push(remotePath);
    this.files.set(remotePath, { bytes, mtimeMs: Date.now() });
    return { path: remotePath };
  }

  async ensureFolder(dir: string): Promise<void> {
    this.dirs.push(dir);
  }
}

interface Harness {
  root: string;
  vaultDir: string;
  sidecarDir: string;
  remote: FakeRemote;
  settings: HiWordsSettings;
  errors: string[];
  backups: string[];
  cleanup: () => Promise<void>;
}

async function createHarness(options: { books?: HiWordsSettings["vocabularyBooks"] } = {}): Promise<
  Harness & { provider: BaiduPanProvider }
> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nb-baidupan-"));
  const vaultDir = path.join(root, "vault");
  const sidecarDir = path.join(root, "sync");
  await mkdir(path.join(vaultDir, "Words"), { recursive: true });
  await mkdir(path.join(sidecarDir, "Words"), { recursive: true });

  const remote = new FakeRemote();
  const errors: string[] = [];
  const backups: string[] = [];
  const cfg = settings(options.books ? { vocabularyBooks: options.books } : {});

  const provider = new BaiduPanProvider({
    settings: cfg,
    client: remote,
    vaultBasePath: vaultDir,
    localSidecarDir: sidecarDir,
    backup: { scheduleBackup: (bookPath: string) => void backups.push(bookPath) } as unknown as CanvasBackupService,
    auditLogPath: canvasAuditLogPath(vaultDir),
    onError: (message) => void errors.push(message),
    now: () => new Date("2026-10-16T12:00:00Z"),
  });

  return {
    root,
    vaultDir,
    sidecarDir,
    remote,
    settings: cfg,
    errors,
    backups,
    provider,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ 推送

test("推送：vault 词库有变化时上传到 /apps/<dir>/Words，并准备目录", async () => {
  const h = await createHarness();
  try {
    await writeFile(path.join(h.vaultDir, BOOK), goodCanvas("sue"), "utf8");
    const result = await h.provider.syncOnce();
    assert.deepEqual(h.remote.dirs, ["/apps/NoteBar/Words"]);
    assert.ok(h.remote.uploads.includes("/apps/NoteBar/Words/AI Agent.canvas"));
    assert.equal(result.uploaded, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(h.errors.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("推送：内容与远端完全一致时不重复上传（配额友好）", async () => {
  const h = await createHarness();
  try {
    const raw = goodCanvas("sue");
    await writeFile(path.join(h.vaultDir, BOOK), raw, "utf8");
    h.remote.put("/apps/NoteBar/Words/AI Agent.canvas", raw);
    const result = await h.provider.syncOnce();
    assert.deepEqual(h.remote.uploads, []);
    assert.equal(result.uploaded, 0);
  } finally {
    await h.cleanup();
  }
});

test("推送：本地词库结构非法时拒绝上传并告警（坏数据不向云端扩散）", async () => {
  const h = await createHarness();
  try {
    await writeFile(path.join(h.vaultDir, BOOK), '{"nodes": [', "utf8"); // 截断的坏 JSON
    const result = await h.provider.syncOnce();
    assert.deepEqual(h.remote.uploads, []);
    assert.equal(result.uploaded, 0);
    assert.deepEqual(result.failed, [BOOK]);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /本地词库校验失败/);
  } finally {
    await h.cleanup();
  }
});

test("推送：未启用的词库被完全跳过（不读不传）", async () => {
  const h = await createHarness({
    books: [
      { path: BOOK, name: "AI", enabled: false },
      { path: BOOK_B, name: "Law", enabled: true },
    ],
  });
  try {
    await writeFile(path.join(h.vaultDir, BOOK), goodCanvas("sue"), "utf8");
    await writeFile(path.join(h.vaultDir, BOOK_B), goodCanvas("tort"), "utf8");
    await h.provider.syncOnce();
    assert.ok(!h.remote.uploads.some((p) => p.includes("AI Agent")));
    assert.ok(h.remote.uploads.some((p) => p.includes("Common Law")));
  } finally {
    await h.cleanup();
  }
});

// ------------------------------------------------------------------ 拉取

test("拉取：远端词库较新且结构合法 → 落盘 + 快照 + 审计（actor=baidupan）", async () => {
  const h = await createHarness();
  try {
    const local = goodCanvas("old");
    const remote = goodCanvas("new");
    await writeFile(path.join(h.vaultDir, BOOK), local, "utf8");
    // 远端明显更新
    h.remote.put("/apps/NoteBar/Words/AI Agent.canvas", remote, Date.now() + 60_000);

    const result = await h.provider.syncOnce();
    assert.equal(result.downloaded, 1);
    assert.equal(await readFile(path.join(h.vaultDir, BOOK), "utf8"), remote);
    // 写入后快照护栏被触发
    assert.deepEqual(h.backups, [BOOK]);
    // 审计日志有 baidupan 记录
    const audit = await readFile(canvasAuditLogPath(h.vaultDir), "utf8");
    assert.match(audit, /baidupan/);
    assert.match(audit, /AI Agent\.canvas/);
    assert.equal(h.errors.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("拉取：远端词库结构非法 → 绝不覆盖 vault，另存 .suspect-*.canvas 并告警", async () => {
  const h = await createHarness();
  try {
    const local = goodCanvas("keep-me");
    await writeFile(path.join(h.vaultDir, BOOK), local, "utf8");
    const broken = '{"nodes":[{"id":"x"';
    h.remote.put("/apps/NoteBar/Words/AI Agent.canvas", broken, Date.now() + 60_000);

    const result = await h.provider.syncOnce();
    // vault 原样保留：坏候选不许顶替好文件
    assert.equal(await readFile(path.join(h.vaultDir, BOOK), "utf8"), local);
    assert.equal(result.downloaded, 0);
    assert.equal(result.rejected, 1);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /已拒绝覆盖本地/);

    const entries = await readdir(path.join(h.vaultDir, "Words"));
    const suspects = entries.filter((name) => name.includes(".suspect-"));
    assert.equal(suspects.length, 1);
    assert.equal(await readFile(path.join(h.vaultDir, "Words", suspects[0]), "utf8"), broken);
  } finally {
    await h.cleanup();
  }
});

test("拉取：节点数骤降（结构仍合法）不阻断，但必须让用户看见", async () => {
  const h = await createHarness();
  try {
    await writeFile(path.join(h.vaultDir, BOOK), manyNodeCanvas(50), "utf8");
    h.remote.put("/apps/NoteBar/Words/AI Agent.canvas", manyNodeCanvas(2), Date.now() + 60_000);

    const result = await h.provider.syncOnce();
    assert.equal(result.downloaded, 1);
    assert.ok(h.errors.some((message) => /节点数骤降/.test(message)));
  } finally {
    await h.cleanup();
  }
});

test("拉取：远端不比本地新时不下载（秒级 mtime 容差 1 秒）", async () => {
  const h = await createHarness();
  try {
    const local = goodCanvas("local");
    await writeFile(path.join(h.vaultDir, BOOK), local, "utf8");
    const localStat = await stat(path.join(h.vaultDir, BOOK));
    h.remote.put("/apps/NoteBar/Words/AI Agent.canvas", goodCanvas("remote"), localStat.mtimeMs);

    const result = await h.provider.syncOnce();
    assert.equal(result.downloaded, 0);
    assert.equal(await readFile(path.join(h.vaultDir, BOOK), "utf8"), local);
  } finally {
    await h.cleanup();
  }
});

// ----------------------------------------------------------- 进度边车合并

test("拉取边车：用 mergeProgress 合并，远端 lastReview 较新者胜，并写回 data.json", async () => {
  const h = await createHarness();
  let saved = 0;
  const providerWithSave = new BaiduPanProvider({
    settings: h.settings,
    client: h.remote,
    vaultBasePath: h.vaultDir,
    localSidecarDir: h.sidecarDir,
    auditLogPath: null,
    onError: (message) => void h.errors.push(message),
    saveSettings: () => void saved++,
  });
  try {
    h.settings.studyProgress = {
      "word:old": { status: "learning", lastReview: "2026-10-01T00:00:00Z", reps: 3 },
    };
    h.remote.put(
      `/apps/NoteBar/Words/Words/AI Agent${SIDECAR_SUFFIX}`,
      sidecarJson({ "word:old": { status: "review", lastReview: "2026-10-15T00:00:00Z", reps: 5 } })
    );

    const result = await providerWithSave.syncOnce();
    // 远端更新：其 status/reps 胜出
    assert.equal(h.settings.studyProgress["word:old"].status, "review");
    assert.equal(h.settings.studyProgress["word:old"].reps, 5);
    assert.equal(result.mergedKeys, 1);
    assert.equal(saved, 1);
    assert.equal(h.errors.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("拉取边车：本地较新时保留本地进度（不被远端旧值回退）", async () => {
  const h = await createHarness();
  try {
    h.settings.studyProgress = {
      "word:old": { status: "mastered", lastReview: "2026-10-15T00:00:00Z", reps: 9 },
    };
    h.remote.put(
      `/apps/NoteBar/Words/Words/AI Agent${SIDECAR_SUFFIX}`,
      sidecarJson({ "word:old": { status: "learning", lastReview: "2026-10-01T00:00:00Z", reps: 1 } })
    );
    await h.provider.syncOnce();
    assert.equal(h.settings.studyProgress["word:old"].status, "mastered");
    assert.equal(h.settings.studyProgress["word:old"].reps, 9);
  } finally {
    await h.cleanup();
  }
});

test("拉取边车：内容非法（版本不符/words 非对象）时拒绝合并并告警", async () => {
  const h = await createHarness();
  try {
    h.remote.put(
      `/apps/NoteBar/Words/Words/AI Agent${SIDECAR_SUFFIX}`,
      JSON.stringify({ version: 99, book: BOOK, words: [], updatedAt: "" })
    );
    const result = await h.provider.syncOnce();
    assert.equal(result.mergedKeys, 0);
    assert.deepEqual(result.failed, [BOOK]);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /远端边车内容非法/);
  } finally {
    await h.cleanup();
  }
});

test("拉取边车：远端不存在时不报错（首次同步的正常情况）", async () => {
  const h = await createHarness();
  try {
    const result = await h.provider.syncOnce();
    assert.equal(result.mergedKeys, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(h.errors.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("推送边车：本地边车上传到远端；内容一致则跳过", async () => {
  const h = await createHarness();
  try {
    const raw = sidecarJson({ "word:a": { status: "review", lastReview: "2026-10-10T00:00:00Z" } });
    await writeFile(path.join(h.sidecarDir, `Words/AI Agent${SIDECAR_SUFFIX}`), raw, "utf8");
    const first = await h.provider.syncOnce();
    assert.equal(first.sidecarsUploaded, 1);
    assert.equal(h.remote.text(`/apps/NoteBar/Words/Words/AI Agent${SIDECAR_SUFFIX}`), raw);

    // 第二次：远端已是同一份内容 → 不再上传
    h.remote.uploads.length = 0;
    const second = await h.provider.syncOnce();
    assert.equal(second.sidecarsUploaded, 0);
    assert.deepEqual(h.remote.uploads, []);
  } finally {
    await h.cleanup();
  }
});

// ------------------------------------------------------------ 失败可见性

test("失败可见：上传抛错时转成 failed + onError（不把异常抛给调用方）", async () => {
  const h = await createHarness();
  try {
    await writeFile(path.join(h.vaultDir, BOOK), goodCanvas("sue"), "utf8");
    h.remote.uploadError = new Error("网盘接口调用失败：errno=20012（访问超限）");

    const result = await h.provider.syncOnce();
    assert.deepEqual(result.failed, [BOOK]);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /上传词库失败/);
    assert.match(h.errors[0], /20012/);
    assert.equal(h.provider.lastErrorMessage, h.errors[0]);
  } finally {
    await h.cleanup();
  }
});

test("失败可见：准备远端目录失败时立即返回并告警（不继续盲跑）", async () => {
  const h = await createHarness();
  try {
    h.remote.ensureFolder = async () => {
      throw new Error("errno=20013（权限不足）");
    };
    await writeFile(path.join(h.vaultDir, BOOK), goodCanvas("sue"), "utf8");
    const result = await h.provider.syncOnce();
    assert.deepEqual(h.remote.uploads, []);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /无法准备网盘目录/);
  } finally {
    await h.cleanup();
  }
});

test("失败日志：失败被写入失败日志文件（可追溯）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nb-baidupan-log-"));
  try {
    const vaultDir = path.join(root, "vault");
    const sidecarDir = path.join(root, "sync");
    await mkdir(path.join(vaultDir, "Words"), { recursive: true });
    await mkdir(path.join(sidecarDir, "Words"), { recursive: true });
    await writeFile(path.join(vaultDir, BOOK), '{"nodes": [', "utf8");

    const remote = new FakeRemote();
    const failureLog = path.join(root, "write-failures.log");
    const provider = new BaiduPanProvider({
      settings: settings(),
      client: remote,
      vaultBasePath: vaultDir,
      localSidecarDir: sidecarDir,
      auditLogPath: null,
      failureLogPath: failureLog,
      onError: () => undefined,
      now: () => new Date("2026-10-16T12:00:00Z"),
    });
    await provider.syncOnce();
    const logged = await readFile(failureLog, "utf8");
    assert.match(logged, /book=Words\/AI Agent\.canvas/);
    assert.match(logged, /本地词库校验失败/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("无 vaultBasePath（移动端）时只同步进度，不碰 Canvas 文件", async () => {
  const h = await createHarness();
  try {
    const remoteOnly = new BaiduPanProvider({
      settings: h.settings,
      client: h.remote,
      vaultBasePath: null,
      localSidecarDir: h.sidecarDir,
      auditLogPath: null,
      onError: (message) => void h.errors.push(message),
    });
    await writeFile(path.join(h.vaultDir, BOOK), goodCanvas("sue"), "utf8");
    const result = await remoteOnly.syncOnce();
    assert.equal(result.uploaded, 0);
    assert.equal(result.downloaded, 0);
    assert.deepEqual(h.remote.uploads, []);
  } finally {
    await h.cleanup();
  }
});

test("本地边车目录为空时不做任何边车落盘（绝不相对 cwd 写文件）", async () => {
  const h = await createHarness();
  try {
    h.settings.studyProgress = {};
    h.remote.put(
      "/apps/NoteBar/Words/Words/AI Agent" + SIDECAR_SUFFIX,
      sidecarJson({ "word:new": { status: "review", lastReview: "2026-10-15T00:00:00Z" } })
    );
    const noDir = new BaiduPanProvider({
      settings: h.settings,
      client: h.remote,
      vaultBasePath: h.vaultDir,
      localSidecarDir: "   ",
      auditLogPath: null,
      onError: (message) => void h.errors.push(message),
    });
    const result = await noDir.syncOnce();
    // 进度照样合并进 data.json
    assert.equal(h.settings.studyProgress["word:new"].status, "review");
    assert.equal(result.mergedKeys, 1);
    // 但本地边车一个字节都不写
    assert.deepEqual(await readdir(path.join(h.sidecarDir, "Words")), []);
    assert.deepEqual(h.remote.uploads, []);
  } finally {
    await h.cleanup();
  }
});

test("远端文件超过体积上限时跳过并告警（不把内存打爆）", async () => {
  const h = await createHarness();
  try {
    const local = goodCanvas("local");
    await writeFile(path.join(h.vaultDir, BOOK), local, "utf8");
    h.remote.putBytes(
      "/apps/NoteBar/Words/AI Agent.canvas",
      new TextEncoder().encode(goodCanvas("remote")),
      Date.now() + 60_000
    );
    const tight = new BaiduPanProvider({
      settings: h.settings,
      client: h.remote,
      vaultBasePath: h.vaultDir,
      localSidecarDir: h.sidecarDir,
      auditLogPath: null,
      maxDownloadBytes: 10,
      onError: (message) => void h.errors.push(message),
    });
    const result = await tight.syncOnce();
    assert.equal(result.downloaded, 0);
    assert.equal(await readFile(path.join(h.vaultDir, BOOK), "utf8"), local);
    assert.ok(h.errors.some((message) => /过大/.test(message)));
  } finally {
    await h.cleanup();
  }
});

/**
 * 镜像采纳前校验（P0-2）单测：坏数据不许顶替好数据。
 *
 * 覆盖（COVERED）
 *   - 坏副本 + 好 vault → vault 不被覆盖、候选另存 `.suspect-*.canvas`、触发告警回调
 *   - 好副本 + 坏 vault → vault 被好副本修回（我们希望的方向）
 *   - 两侧都坏 → 谁都不动
 *   - `.icloud` 占位 / iCloud xattr 未物化 → 本轮不复制
 *   - 冲突副本识别：新命名 `.conflict-*` 与旧命名 `<book> <n>.canvas` 都要报
 *   - 镜像复制写审计日志（actor=mirror）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Mirrorer } from "../../src/sync/mirrorer";
import { canvasAuditLogPath } from "../../src/sync/canvas-audit";

const BOOK = "Words/AI Agent.canvas";
// 真实事故截断样本在 <repo>/tests/fixtures/
const FIXTURE = path.resolve(__dirname, "..", "..", "tests", "fixtures", "canvas-truncated.canvas");

function goodCanvas(nodeId: string, text = "sue"): string {
  return JSON.stringify({
    nodes: [
      { id: "g1", type: "group", x: 0, y: 0, width: 300, height: 200, label: "2026-09-27" },
      { id: nodeId, type: "text", x: 24, y: 24, width: 260, height: 120, text },
    ],
    edges: [],
  });
}

interface Harness {
  root: string;
  vaultDir: string;
  syncDir: string;
  vaultFile: string;
  syncFile: string;
  conflicts: string[];
  changed: string[];
  cleanup: () => Promise<void>;
}

async function createHarness(options: { getXattr?: Mirrorer["constructor"] extends never ? never : any } = {}): Promise<Harness & { mirrorer: Mirrorer }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nb-mirror-guard-"));
  const vaultDir = path.join(root, "vault");
  const syncDir = path.join(root, "sync");
  const vaultFile = path.join(vaultDir, BOOK);
  const syncFile = path.join(syncDir, BOOK);
  await mkdir(path.dirname(vaultFile), { recursive: true });
  await mkdir(path.dirname(syncFile), { recursive: true });

  const conflicts: string[] = [];
  const changed: string[] = [];
  const mirrorer = new Mirrorer({
    vaultBasePath: vaultDir,
    syncDir,
    books: [{ path: BOOK, name: "AI", enabled: true }],
    onConflict: (message) => conflicts.push(message),
    onVaultChanged: (bookPath) => changed.push(bookPath),
    now: () => new Date(2026, 8, 27, 17, 13, 33),
    ...(options.getXattr ? { getXattr: options.getXattr } : {}),
  });

  return {
    root,
    vaultDir,
    syncDir,
    vaultFile,
    syncFile,
    conflicts,
    changed,
    mirrorer,
    cleanup: async () => {
      mirrorer.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function listDir(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

test("坏副本不许覆盖好 vault：拒绝复制、另存 .suspect-*、告警", async () => {
  const h = await createHarness();
  try {
    const good = goodCanvas("n1");
    const truncated = await readFile(FIXTURE, "utf8");
    await writeFile(h.vaultFile, good, "utf8");
    await writeFile(h.syncFile, truncated, "utf8");
    // 让同步侧「更新」，走 mtime 胜出 ⇒ 副本 → vault 方向
    await utimes(h.syncFile, new Date(Date.now() + 60000), new Date(Date.now() + 60000));

    await h.mirrorer.syncOnce();

    assert.equal(await readFile(h.vaultFile, "utf8"), good, "好 vault 必须原样保留");
    const files = await listDir(path.dirname(h.syncFile));
    assert.ok(
      files.includes("AI Agent.suspect-20260927-171333.canvas"),
      `候选应另存为 suspect 文件，实际：${files.join("、")}`
    );
    assert.equal(
      await readFile(path.join(path.dirname(h.syncFile), "AI Agent.suspect-20260927-171333.canvas"), "utf8"),
      truncated,
      "另存的候选必须逐字节保留"
    );
    assert.ok(
      h.conflicts.some((message) => message.includes("not-json") && message.includes("拒绝覆盖")),
      `应触发告警回调，实际：${h.conflicts.join(" / ")}`
    );
    assert.deepEqual(h.changed, [], "vault 没变就不该通知重载");
    // 坏候选没有被删掉，原件仍在
    assert.equal(await readFile(h.syncFile, "utf8"), truncated);
  } finally {
    await h.cleanup();
  }
});

test("好副本修回坏 vault：vault 被校验通过的副本覆盖", async () => {
  const h = await createHarness();
  try {
    const good = goodCanvas("n2");
    const truncated = await readFile(FIXTURE, "utf8");
    await writeFile(h.vaultFile, truncated, "utf8");
    await writeFile(h.syncFile, good, "utf8");
    // 坏 vault 的 mtime 更新，确保「vault → 副本」方向会被拒绝
    await utimes(h.vaultFile, new Date(Date.now() + 60000), new Date(Date.now() + 60000));

    await h.mirrorer.syncOnce();

    assert.equal(await readFile(h.vaultFile, "utf8"), good, "坏 vault 应被好副本修复");
    assert.equal(await readFile(h.syncFile, "utf8"), good, "副本保持不变");
    assert.deepEqual(h.changed, [BOOK], "vault 被改写后要通知重载");
  } finally {
    await h.cleanup();
  }
});

test("两侧都坏：谁都不动，也不产生 suspect 文件", async () => {
  const h = await createHarness();
  try {
    const truncated = await readFile(FIXTURE, "utf8");
    await writeFile(h.vaultFile, truncated, "utf8");
    await writeFile(h.syncFile, truncated, "utf8");

    await h.mirrorer.syncOnce();

    assert.equal(await readFile(h.vaultFile, "utf8"), truncated);
    assert.equal(await readFile(h.syncFile, "utf8"), truncated);
    assert.ok(h.conflicts.some((message) => message.includes("词库文件校验失败")));
  } finally {
    await h.cleanup();
  }
});

test("好 vault 不许被推到同步侧：vault 坏且无可用副本时拒绝复制", async () => {
  const h = await createHarness();
  try {
    const truncated = await readFile(FIXTURE, "utf8");
    await writeFile(h.vaultFile, truncated, "utf8");
    // 同步侧不存在该词库 ⇒ 若无校验，会把坏 vault 复制出去
    await h.mirrorer.syncOnce();
    assert.deepEqual(await listDir(path.dirname(h.syncFile)), [], "坏 vault 不许复制到同步目录");
    assert.ok(h.conflicts.some((message) => message.includes("已拒绝写入同步目录")));
  } finally {
    await h.cleanup();
  }
});

test("iCloud 占位（同名 .icloud 或 xattr）→ 本轮不复制", async () => {
  const h = await createHarness();
  try {
    const good = goodCanvas("n3");
    await writeFile(h.vaultFile, good, "utf8");
    // 同步侧文件被 iCloud 驱逐，只剩占位
    await writeFile(`${h.syncFile}.icloud`, "placeholder", "utf8");

    await h.mirrorer.syncOnce();
    assert.equal(await readFile(h.syncFile, "utf8").catch(() => null), null, "占位期间不该新建实体文件");
    assert.deepEqual(await listDir(path.dirname(h.syncFile)), ["AI Agent.canvas.icloud"]);
  } finally {
    await h.cleanup();
  }
});

test("xattr 探测命中 com.apple.icloud.itemName → 本轮不复制", async () => {
  const probed: string[] = [];
  const h = await createHarness({
    getXattr: async (filePath: string, name: string) => {
      probed.push(`${path.basename(filePath)}:${name}`);
      return filePath.endsWith("AI Agent.canvas") ? "AI Agent.canvas" : null;
    },
  });
  try {
    await writeFile(h.vaultFile, goodCanvas("n4"), "utf8");
    await h.mirrorer.syncOnce();
    assert.deepEqual(await listDir(path.dirname(h.syncFile)), [], "未物化的文件不许复制出去");
    assert.ok(probed.some((entry) => entry.includes("com.apple.icloud.itemName")), "应查询 iCloud xattr");
  } finally {
    await h.cleanup();
  }
});

test("冲突副本识别：新命名 .conflict-* 与旧命名 <book> <n>.canvas 都要报", async () => {
  const h = await createHarness();
  try {
    await writeFile(h.vaultFile, goodCanvas("n5"), "utf8");
    await writeFile(path.join(path.dirname(h.syncFile), "AI Agent.conflict-20260927-171333.canvas"), goodCanvas("c1"), "utf8");
    await writeFile(path.join(path.dirname(h.syncFile), "AI Agent 2.canvas"), goodCanvas("c2"), "utf8");

    await h.mirrorer.syncOnce();
    const conflictMessage = h.conflicts.find((message) => message.includes("冲突副本"));
    assert.ok(conflictMessage, `应报告冲突副本，实际：${h.conflicts.join(" / ")}`);
    assert.ok(conflictMessage!.includes("AI Agent.conflict-20260927-171333.canvas"));
    assert.ok(conflictMessage!.includes("AI Agent 2.canvas"));
    // 冲突副本只提示、不删除
    assert.ok((await listDir(path.dirname(h.syncFile))).includes("AI Agent.conflict-20260927-171333.canvas"));
  } finally {
    await h.cleanup();
  }
});

test("节点数骤降告警：结构合法但骤减的副本仍会提示（不阻断，用户可能真在批量删词）", async () => {
  const h = await createHarness();
  try {
    const bigNodes = Array.from({ length: 10 }, (_, index) => ({
      id: `n${index}`,
      type: "text",
      x: 0,
      y: index * 140,
      width: 260,
      height: 120,
      text: `word-${index}`,
    }));
    const smallNodes = bigNodes.slice(0, 3);
    await writeFile(h.vaultFile, JSON.stringify({ nodes: bigNodes, edges: [] }), "utf8");
    await writeFile(h.syncFile, JSON.stringify({ nodes: smallNodes, edges: [] }), "utf8");
    await utimes(h.syncFile, new Date(Date.now() + 60000), new Date(Date.now() + 60000));

    await h.mirrorer.syncOnce();

    assert.deepEqual(JSON.parse(await readFile(h.vaultFile, "utf8")).nodes.length, 3, "结构合法 ⇒ 仍按 mtime 采纳");
    assert.ok(
      h.conflicts.some((message) => message.includes("节点数骤降") && message.includes("10") && message.includes("3")),
      `应提示节点数骤降，实际：${h.conflicts.join(" / ")}`
    );
  } finally {
    await h.cleanup();
  }
});

test("镜像复制写审计：actor=mirror，含前后字节数与 sha1 前 12 位", async () => {
  const h = await createHarness();
  try {
    await writeFile(h.vaultFile, goodCanvas("n6"), "utf8");
    await h.mirrorer.syncOnce();

    const log = await readFile(canvasAuditLogPath(h.vaultDir), "utf8");
    const line = log.trim();
    const fields = line.split(" | ");
    assert.equal(fields.length, 8);
    assert.equal(fields[1], "mirror");
    assert.equal(fields[2], BOOK);
    assert.equal(fields[3], "0", "同步侧原不存在 ⇒ bytesBefore=0");
    assert.equal(Number(fields[4]), (await stat(h.syncFile)).size);
    assert.equal(fields[5], "-");
    assert.match(fields[6], /^[0-9a-f]{12}$/);
    assert.equal(fields[7], "yes", "写后结构合法");
  } finally {
    await h.cleanup();
  }
});

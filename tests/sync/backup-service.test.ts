/**
 * 备份层单测（P1）：保留策略、快照前校验、临时目录落盘。
 *
 * 覆盖（COVERED）
 *   - selectSnapshotsToDelete：最近 20 份 + 每天 1 份保留 30 天的裁剪数学
 *   - CanvasBackupService.backupBook：合法词库落快照（temp+rename）、非法词库拒绝快照并告警
 *   - 目录命名（斜杠替换）与快照命名（YYYY-MM-DD-HHmmss.canvas）
 *   - 真实临时目录上的裁剪（老快照被删、近 30 天每天 1 份保留）
 *
 * 不覆盖（NOT COVERED）：真实 vault / iCloud 环境、Notice 的界面呈现、30 秒防抖与每小时的
 * 真实计时（只验证注入计时器的调度接线形状）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CanvasBackupService,
  backupDirNameFor,
  backupFileNameFor,
  newestBackupPath,
  selectSnapshotsToDelete,
  type SnapshotFile,
} from "../../src/sync/backup-service";

const FIXTURE = path.resolve(__dirname, "..", "..", "tests", "fixtures", "canvas-truncated.canvas");

const NOW = new Date(2026, 8, 27, 17, 13, 33); // 2026-09-27 17:13:33 本地时间
const BOOK = "Words/Common Law.canvas";

function goodCanvas(): string {
  return JSON.stringify({
    nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 260, height: 120, text: "sue" }],
    edges: [],
  });
}

test("保留策略：最近 N 份 + 每天 1 份保留 M 天", () => {
  const now = new Date(2026, 8, 27, 12, 0, 0);
  const dayMs = 86400000;
  const snapshots: SnapshotFile[] = [];
  // 每天 3 份，覆盖 40 天：第 0 天（今天）到第 39 天
  for (let day = 0; day < 40; day++) {
    for (let slot = 0; slot < 3; slot++) {
      snapshots.push({
        name: `d${day}-${slot}.canvas`,
        mtimeMs: now.getTime() - day * dayMs - slot * 3600000,
      });
    }
  }

  const doomed = selectSnapshotsToDelete(snapshots, { keepRecent: 20, keepDailyDays: 30, now });
  const keep = snapshots.map((s) => s.name).filter((name) => !doomed.includes(name));

  // 保留集合 = 最近 20 份 ∪ {近 30 天每天最新一份}：
  //   最近 20 份 = 第 0..5 天各 3 份（18）+ 第 6 天的 slot0/slot1（2）
  //   每天最新一份 = 第 0..29 天的 slot0（30）
  //   并集 = 第 0..5 天各 3 份（18）+ 第 6 天 2 份 + 第 7..29 天各 1 份（23） = 43
  assert.equal(keep.length, 43);
  for (let day = 0; day < 30; day++) assert.ok(keep.includes(`d${day}-0.canvas`), `第 ${day} 天应保留`);
  for (let day = 30; day < 40; day++) {
    for (let slot = 0; slot < 3; slot++) {
      assert.ok(doomed.includes(`d${day}-${slot}.canvas`), `第 ${day} 天第 ${slot} 份应删除`);
    }
  }
  assert.equal(doomed.length, 40 * 3 - 43);
});

test("保留策略：每天一份但总量少于阈值时一份都不删；未来时间戳保留", () => {
  const now = new Date(2026, 8, 27, 12, 0, 0);
  const few: SnapshotFile[] = [
    { name: "a.canvas", mtimeMs: now.getTime() - 400 * 86400000 },
    { name: "b.canvas", mtimeMs: now.getTime() - 100 * 86400000 },
  ];
  assert.deepEqual(selectSnapshotsToDelete(few, { keepRecent: 20, keepDailyDays: 30, now }), []);

  const future: SnapshotFile[] = [
    ...few,
    { name: "clock-skew.canvas", mtimeMs: now.getTime() + 5 * 86400000 },
    { name: "old.canvas", mtimeMs: now.getTime() - 401 * 86400000 },
  ];
  const doomed = selectSnapshotsToDelete(future, { keepRecent: 1, keepDailyDays: 1, now });
  assert.equal(doomed.includes("clock-skew.canvas"), false, "未来时间戳不许删");
});

test("命名：斜杠替换成双下划线，快照名为 YYYY-MM-DD-HHmmss.canvas", () => {
  assert.equal(backupDirNameFor("Words/Common Law.canvas"), "Words__Common Law.canvas");
  assert.equal(backupDirNameFor("/Words/Sub/Book.canvas"), "Words__Sub__Book.canvas");
  assert.equal(backupDirNameFor("Book.canvas"), "Book.canvas");
  assert.equal(backupFileNameFor(NOW), "2026-09-27-171333.canvas");
});

test("backupBook：合法词库落快照并可被 newestBackupPath 找到", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nb-backup-"));
  const vault = path.join(root, "vault");
  const backupRoot = path.join(root, "backups");
  const bookAbs = path.join(vault, BOOK);
  await fs.mkdir(path.dirname(bookAbs), { recursive: true });
  await fs.writeFile(bookAbs, goodCanvas(), "utf8");

  const errors: string[] = [];
  const service = new CanvasBackupService({
    vaultBasePath: vault,
    books: [{ path: BOOK, name: "Common Law", enabled: true }],
    rootDir: backupRoot,
    now: () => NOW,
    onError: (message) => errors.push(message),
  });

  try {
    const result = await service.backupBook(BOOK);
    assert.equal(result.ok, true);
    assert.equal(result.path, path.join(backupRoot, "Words__Common Law.canvas", "2026-09-27-171333.canvas"));
    assert.equal(await fs.readFile(result.path!, "utf8"), goodCanvas());
    assert.deepEqual(await fs.readdir(path.dirname(result.path!)), ["2026-09-27-171333.canvas"], "不留 .tmp 残渣");
    assert.deepEqual(errors, []);

    assert.equal(await newestBackupPath(backupRoot, BOOK), result.path);
  } finally {
    service.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("backupBook：非法（真实截断样本）→ 拒绝快照 + 告警，备份目录不留文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nb-backup-"));
  const vault = path.join(root, "vault");
  const backupRoot = path.join(root, "backups");
  const bookAbs = path.join(vault, BOOK);
  await fs.mkdir(path.dirname(bookAbs), { recursive: true });
  await fs.writeFile(bookAbs, await fs.readFile(FIXTURE, "utf8"), "utf8");

  const errors: string[] = [];
  const service = new CanvasBackupService({
    vaultBasePath: vault,
    books: [{ path: BOOK, name: "Common Law", enabled: true }],
    rootDir: backupRoot,
    now: () => NOW,
    onError: (message) => errors.push(message),
  });

  try {
    const result = await service.backupBook(BOOK);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid:not-json");
    assert.ok(errors.some((message) => message.includes("已拒绝备份")), errors.join(" / "));
    assert.deepEqual(await fs.readdir(path.join(backupRoot, "Words__Common Law.canvas")).catch(() => []), []);
    assert.equal(await newestBackupPath(backupRoot, BOOK), null);
  } finally {
    service.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("backupBook：裁剪旧快照（临时目录真实删除）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nb-backup-"));
  const vault = path.join(root, "vault");
  const backupRoot = path.join(root, "backups");
  const bookAbs = path.join(vault, BOOK);
  const backupDir = path.join(backupRoot, "Words__Common Law.canvas");
  await fs.mkdir(path.dirname(bookAbs), { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(bookAbs, goodCanvas(), "utf8");

  // 每天 1 份、覆盖第 1..40 天（今天由本次快照生成）
  const nowMs = NOW.getTime();
  for (let day = 1; day <= 40; day++) {
    const stamp = new Date(nowMs - day * 86400000);
    const name = backupFileNameFor(stamp);
    const filePath = path.join(backupDir, name);
    await fs.writeFile(filePath, goodCanvas(), "utf8");
    const seconds = stamp.getTime() / 1000;
    await fs.utimes(filePath, seconds, seconds);
  }

  const service = new CanvasBackupService({
    vaultBasePath: vault,
    books: [{ path: BOOK, name: "Common Law", enabled: true }],
    rootDir: backupRoot,
    keepRecent: 20,
    keepDailyDays: 30,
    now: () => NOW,
    onError: () => undefined,
  });

  try {
    const result = await service.backupBook(BOOK);
    assert.equal(result.ok, true);

    const remaining = (await fs.readdir(backupDir)).sort();
    // 本次快照落在第 0 天；保留 = 最近 20 份（第 0..19 天）∪ 近 30 天每天 1 份（第 0..29 天） = 30 份
    assert.equal(remaining.length, 30, `今天 1 份 + 近 29 天每天 1 份，实际 ${remaining.length}`);
    assert.ok(remaining.includes("2026-09-27-171333.canvas"));
    assert.ok(remaining.includes(backupFileNameFor(new Date(nowMs - 29 * 86400000))));
    assert.equal(remaining.includes(backupFileNameFor(new Date(nowMs - 30 * 86400000))), false);
    assert.equal(remaining.includes(backupFileNameFor(new Date(nowMs - 40 * 86400000))), false);
  } finally {
    service.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sweep：逐个启用词库快照，非法计入 skipped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nb-backup-"));
  const vault = path.join(root, "vault");
  const goodBook = "Words/good.canvas";
  const badBook = "Words/bad.canvas";
  await fs.mkdir(path.join(vault, "Words"), { recursive: true });
  await fs.writeFile(path.join(vault, goodBook), goodCanvas(), "utf8");
  await fs.writeFile(path.join(vault, badBook), await fs.readFile(FIXTURE, "utf8"), "utf8");

  const service = new CanvasBackupService({
    vaultBasePath: vault,
    books: [
      { path: goodBook, name: "good", enabled: true },
      { path: badBook, name: "bad", enabled: true },
      { path: "Words/off.canvas", name: "off", enabled: false },
    ],
    rootDir: path.join(root, "backups"),
    now: () => NOW,
    onError: () => undefined,
  });

  try {
    const result = await service.sweep();
    assert.deepEqual(result, { created: 1, skipped: 1, failed: 0 });
    assert.ok(await newestBackupPath(service.backupRoot, goodBook));
    assert.equal(await newestBackupPath(service.backupRoot, badBook), null);
  } finally {
    service.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scheduleBackup：注入计时器后按防抖延迟触发一次，stop() 收回所有定时器", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nb-backup-"));
  const vault = path.join(root, "vault");
  const bookAbs = path.join(vault, BOOK);
  await fs.mkdir(path.dirname(bookAbs), { recursive: true });
  await fs.writeFile(bookAbs, goodCanvas(), "utf8");

  const timeouts: Array<{ handler: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const service = new CanvasBackupService({
    vaultBasePath: vault,
    books: [{ path: BOOK, name: "Common Law", enabled: true }],
    rootDir: path.join(root, "backups"),
    now: () => NOW,
    debounceMs: 30000,
    onError: () => undefined,
  });

  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: () => void, ms: number) => {
    timeouts.push({ handler, ms });
    return { fake: true } as any;
  }) as typeof setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  (globalThis as any).clearTimeout = ((handle: unknown) => {
    cleared.push(handle);
  }) as typeof clearTimeout;

  try {
    service.scheduleBackup(BOOK);
    service.scheduleBackup(BOOK); // 第二次调用应清掉第一次的定时器（防抖）
    assert.equal(timeouts.length, 2);
    assert.equal(timeouts[0].ms, 30000);
    assert.equal(cleared.length, 1, "重复调度应清除前一个定时器");

    timeouts[1].handler();
    await new Promise((resolve) => realSetTimeout(resolve, 50));
    assert.ok(await newestBackupPath(service.backupRoot, BOOK), "防抖到期后应产生快照");

    service.scheduleBackup(BOOK);
    const timerCount = timeouts.length;
    service.stop();
    assert.equal(timeouts.length, timerCount);
    assert.equal(cleared.length >= 2, true, "stop() 必须收回防抖定时器");
    assert.equal(await service.backupNow(BOOK).then((result) => result.ok), true, "手动立即快照仍可用");
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    (globalThis as any).clearTimeout = realClearTimeout;
    service.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

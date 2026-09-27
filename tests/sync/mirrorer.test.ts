import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Mirrorer } from "../../src/sync/mirrorer";

function utimeMs(ms: number) {
  return new Date(ms);
}

/** 结构完整的单节点 canvas（校验器要求 id/type/x/y/width/height 齐备） */
function canvasWith(nodeId: string, text: string): string {
  return JSON.stringify({
    nodes: [{ id: nodeId, type: "text", x: 0, y: 0, width: 260, height: 120, text }],
    edges: [],
  });
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
  const changed: string[] = [];
  const mirrorer = new Mirrorer({
    vaultBasePath: vault,
    syncDir: sync,
    books,
    onConflict: (msg) => conflicts.push(msg),
    onVaultChanged: (book) => changed.push(book),
  });

  try {
    await writeFile(vaultFile, canvasWith("n1", "hello"), "utf8");
    await mirrorer.syncOnce();
    assert.equal(await readFile(syncFile, "utf8"), await readFile(vaultFile, "utf8"));

    await writeFile(syncFile, canvasWith("n2", "world"), "utf8");
    await utimes(syncFile, utimeMs(Date.now() + 60000), utimeMs(Date.now() + 60000));
    await mirrorer.syncOnce();
    assert.equal(await readFile(vaultFile, "utf8"), canvasWith("n2", "world"));
    assert.deepEqual(conflicts, []);
    assert.deepEqual(changed, [bookPath]);
  } finally {
    mirrorer.stop();
    await rm(root, { recursive: true, force: true });
  }
});

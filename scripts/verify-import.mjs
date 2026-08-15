// 验证插件真实导入链路：模拟手机修改边车（含冲突副本）后，用 src/sync/sync-importer.ts
// 的真实实现合并进 data.json 的临时副本。不写任何真实用户数据。
import esbuild from "esbuild";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

const vault = path.join(os.homedir(), "Documents/Library");
const syncDir = path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs/NoteBar");
const dataJsonPath = path.join(vault, ".obsidian/plugins/note-bar/data.json");

// 1) 编译真实导入器
await esbuild.build({
  entryPoints: ["src/sync/sync-importer.ts"],
  outfile: ".tests-dist/sync-importer.cjs",
  format: "cjs",
  platform: "node",
  target: "es2018",
  bundle: true,
});
const { importSidecars } = await import(path.resolve(".tests-dist/sync-importer.cjs"));

// 2) 加载用户 data.json 的临时副本
const settings = JSON.parse(await fs.readFile(dataJsonPath, "utf8"));

// 3) 模拟手机写回：把 Daily English 第一个词的 s 改成 777，lastReview 更新
const dailyPath = path.join(syncDir, "Words/Daily English.nb-sync.json");
const daily = JSON.parse(await fs.readFile(dailyPath, "utf8"));
const phoneKey = Object.keys(daily.words)[0];
if (!phoneKey) throw new Error("Daily English 边车没有进度键");
daily.words[phoneKey].s = 777;
daily.words[phoneKey].lastReview = new Date(Date.now() + 3600_000).toISOString();
daily.updatedAt = new Date().toISOString();
await fs.writeFile(dailyPath, JSON.stringify(daily, null, 2), "utf8");

// 4) 模拟 iCloud 冲突副本：Common Law 2.nb-sync.json 更新，其中一个词 s=888
const commonPath = path.join(syncDir, "Words/Common Law.nb-sync.json");
const common = JSON.parse(await fs.readFile(commonPath, "utf8"));
const conflictKey = Object.keys(common.words)[0];
const conflict = JSON.parse(JSON.stringify(common));
if (conflictKey) {
  conflict.words[conflictKey].s = 888;
  conflict.words[conflictKey].lastReview = new Date(Date.now() + 7200_000).toISOString();
}
conflict.updatedAt = new Date(Date.now() + 7200_000).toISOString();
await fs.writeFile(path.join(syncDir, "Words/Common Law 2.nb-sync.json"), JSON.stringify(conflict, null, 2), "utf8");

// 5) 运行真实导入
const result = await importSidecars({ settings, syncDir });

console.log("mergedKeys:", result.mergedKeys);
console.log("conflictsArchived:", JSON.stringify(result.conflictsArchived));
console.log("phone write-back s:", settings.studyProgress[phoneKey]?.s, "(期望 777)");
if (conflictKey) {
  console.log("conflict promoted s:", settings.studyProgress[conflictKey]?.s, "(期望 888)");
}
const ok =
  settings.studyProgress[phoneKey]?.s === 777 &&
  (!conflictKey || settings.studyProgress[conflictKey]?.s === 888) &&
  result.conflictsArchived.includes("Words/Common Law.canvas");
console.log(ok ? "VERIFY-IMPORT: PASS" : "VERIFY-IMPORT: FAIL");
process.exit(ok ? 0 : 1);

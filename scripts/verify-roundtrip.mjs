// 全链路验证：把 iOS App 刚写回边车的评分（s=999）用插件真实导入代码合入 data.json 副本。
import esbuild from "esbuild";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

const vault = "/Users/shengxia/Documents/Library";
const syncDir = path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs/NoteBar");

await esbuild.build({
  entryPoints: ["src/sync/sync-importer.ts"],
  outfile: ".tests-dist/sync-importer.cjs",
  format: "cjs",
  platform: "node",
  target: "es2018",
  bundle: true,
});
const { importSidecars } = await import(path.resolve(".tests-dist/sync-importer.cjs"));

const settings = JSON.parse(await fs.readFile(path.join(vault, ".obsidian/plugins/note-bar/data.json"), "utf8"));
const result = await importSidecars({ settings, syncDir });

const matches = Object.entries(settings.studyProgress).filter(([, p]) => p?.s === 999);
console.log("mergedKeys:", result.mergedKeys);
console.log("s=999 的键:", matches.map(([k]) => k).join(", ") || "(无)");
const ok = matches.length > 0;
console.log(ok ? "VERIFY-ROUNDTRIP: PASS" : "VERIFY-ROUNDTRIP: FAIL");
process.exit(ok ? 0 : 1);

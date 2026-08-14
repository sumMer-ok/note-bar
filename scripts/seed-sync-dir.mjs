// 开发辅助脚本：模拟插件导出器，把 vault 中的 Canvas 词库镜像到 iCloud 同步目录，
// 并按 src/sync 的边车 schema 从 data.json 导出进度边车。
// 用法: node scripts/seed-sync-dir.mjs --vault <vault路径> --out <同步目录>
import { promises as fs } from "fs";
import path from "path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const vault = arg("--vault");
const out = arg("--out");
if (!vault || !out) {
  console.error("用法: node scripts/seed-sync-dir.mjs --vault <vault> --out <syncDir>");
  process.exit(1);
}

const dataJsonPath = path.join(vault, ".obsidian/plugins/note-bar/data.json");
const data = JSON.parse(await fs.readFile(dataJsonPath, "utf8"));
const progress = data.studyProgress || {};
const books = (data.vocabularyBooks || []).filter((b) => b.enabled && b.path.endsWith(".canvas"));

let totalWords = 0;
let totalProgress = 0;

for (const book of books) {
  const src = path.join(vault, book.path);
  const dst = path.join(out, book.path);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);

  const canvas = JSON.parse(await fs.readFile(src, "utf8"));
  const words = {};
  for (const node of canvas.nodes || []) {
    if (!node.id) continue;
    if (node.type === "text" && typeof node.text === "string" && node.text.trim()) {
      const key = `${book.path}:${node.id}`;
      if (progress[key]) {
        words[key] = progress[key];
        totalProgress++;
      }
      totalWords++;
    }
  }

  const base = book.path.replace(/\.canvas$/, "");
  const sidecar = {
    version: 1,
    book: book.path,
    words,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(out, `${base}.nb-sync.json`), JSON.stringify(sidecar, null, 2), "utf8");
  console.log(`${book.path}: ${Object.keys(words).length}/${totalWords ? "words" : ""} 边车已生成`);
}

console.log(`共 ${books.length} 个词库，${totalWords} 个单词，${totalProgress} 条进度`);

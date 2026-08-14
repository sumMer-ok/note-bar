// 从插件 src/main.ts 提取 DEFAULT_AI_DEFINITION_PROMPT，
// 解码 TS 单引号转义后写入 iOS App 资源，保证两端提示词逐字一致。
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const src = readFileSync("src/main.ts", "utf8");
const match = /const DEFAULT_AI_DEFINITION_PROMPT = '([\s\S]*?)';/.exec(src);
if (!match) {
  console.error("未找到 DEFAULT_AI_DEFINITION_PROMPT");
  process.exit(1);
}

const raw = match[1];
let out = "";
for (let i = 0; i < raw.length; i++) {
  const ch = raw[i];
  if (ch === "\\") {
    const next = raw[i + 1];
    if (next === "n") { out += "\n"; i++; }
    else if (next === "'") { out += "'"; i++; }
    else if (next === "\\") { out += "\\"; i++; }
    else if (next !== undefined) { out += next; i++; }
  } else {
    out += ch;
  }
}

mkdirSync("NoteBarApp/Resources", { recursive: true });
writeFileSync("NoteBarApp/Resources/ai-definition-prompt.txt", out, "utf8");
console.log(`已生成 NoteBarApp/Resources/ai-definition-prompt.txt（${out.length} 字符）`);

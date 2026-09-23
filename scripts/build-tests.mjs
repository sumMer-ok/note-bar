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
  // obsidian 在测试运行时没有宿主：改指向最小替身，生产构建仍保持 external
  alias: { obsidian: "./tests/stubs/obsidian.ts" },
  external: [...builtins, "electron"],
  logLevel: "info",
});

execSync(`node --test '${outdir}/**/*.test.js'`, { stdio: "inherit" });

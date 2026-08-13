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

execSync(`node --test '${outdir}/**/*.test.js'`, { stdio: "inherit" });

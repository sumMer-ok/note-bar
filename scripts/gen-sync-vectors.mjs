import esbuild from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("tests/fixtures", { recursive: true });

await esbuild.build({
  entryPoints: ["scripts/gen-sync-vectors.entry.ts"],
  outfile: ".tests-dist/gen-sync-vectors.cjs",
  format: "cjs",
  platform: "node",
  target: "es2018",
  bundle: true,
});

execSync("node .tests-dist/gen-sync-vectors.cjs", { stdio: "inherit" });
console.log("tests/fixtures/sync-vectors.json generated");

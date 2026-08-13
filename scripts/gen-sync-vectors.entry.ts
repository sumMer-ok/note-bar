import {
  initStability,
  initDifficulty,
  nextDifficulty,
  retrievability,
  nextRecallStability,
  nextForgetStability,
  nextInterval,
  type FSRSGrade,
} from "../src/hiwords/core/fsrs";
import { buildStudyKey } from "../src/hiwords/utils/study-key";
import { writeFileSync } from "fs";

const fsrsVectors: any[] = [];
const cases: Array<{ s: number | null; d: number | null; elapsed: number; grade: FSRSGrade }> = [
  { s: null, d: null, elapsed: 0, grade: 1 },
  { s: null, d: null, elapsed: 0, grade: 3 },
  { s: 3.0, d: 5.0, elapsed: 1, grade: 3 },
  { s: 3.0, d: 5.0, elapsed: 30, grade: 1 },
  { s: 30.0, d: 5.0, elapsed: 60, grade: 4 },
  { s: 1.2, d: 8.0, elapsed: 2, grade: 2 },
];

for (const c of cases) {
  let s = c.s ?? initStability(c.grade);
  let d = c.d ?? initDifficulty(c.grade);
  if (c.s !== null && c.d !== null) {
    const r = retrievability(c.elapsed, c.s);
    s = c.grade === 1 ? nextForgetStability(c.d, c.s, r) : nextRecallStability(c.d, c.s, r, c.grade);
    d = nextDifficulty(c.d, c.grade);
  }
  fsrsVectors.push({
    input: { s: c.s, d: c.d, elapsedDays: c.elapsed, grade: c.grade },
    output: { s: round(s), d: round(d), interval: nextInterval(s) },
  });
}

const studyKeyVectors = [
  { input: { word: "Hello,  World!", language: "en", type: "word" }, expected: "en:word:hello, world" },
  { input: { word: "合同", language: "zh-CN" }, expected: "zh-cn:concept:合同" },
  { input: { word: "İstanbul", language: "en" }, expected: "en:word:i̇stanbul" },
  { input: { word: "take off", language: "en" }, expected: "en:phrase:take off" },
  { input: { word: "ｆｕｌｌｗｉｄｔｈ", language: "en" }, expected: "en:word:fullwidth" },
];

const output = { fsrs: fsrsVectors, studyKeys: studyKeyVectors };
writeFileSync("tests/fixtures/sync-vectors.json", JSON.stringify(output, null, 2));

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

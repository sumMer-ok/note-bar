# Note Bar iOS 词汇同步 App 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一款 SwiftUI iOS App：经 iCloud Drive 同步目录读写 Obsidian 的 Canvas 词库与 `.nb-sync.json` 进度边车，提供卡片翻转 + 四向滑动的复习、学习/复习分离、三种分组浏览、日历统计、听写模式，并与桌面插件双向同步 FSRS-5 进度。

**Architecture:** 分层为 Engine（FSRS/StudyKey/Merge 纯函数）→ Models（Canvas/Sidecar JSON）→ Sync（bookmark + NSFileCoordinator + 轮询）→ Store（SwiftData）→ Views（SwiftUI + 毛玻璃材质）。复习评分先落 SwiftData 再异步写边车；同步只在前台/启动/手动刷新触发（v1 无后台推送）。

**Tech Stack:** Xcode 16、Swift 5、SwiftUI、SwiftData、iOS 17.0+、XCTest；无第三方依赖。设计依据：[2026-08-14-note-bar-ios-sync-design.md](./docs/superpowers/specs/2026-08-14-note-bar-ios-sync-design.md)。

---

## 文件映射（Xcode 工程 `NoteBarApp/`）

| 文件 | 职责 |
|---|---|
| `App/NoteBarApp.swift` | App 入口、SwiftData ModelContainer、主题 |
| `App/AppState.swift` | 全局状态：SyncService、SettingsStore、SyncStatus |
| `Engine/FSRS.swift` | FSRS-5 全公式 Swift 移植 + 调度封装 |
| `Engine/StudyKey.swift` | studyKey 双规则（NFKC、小写、卡片键） |
| `Engine/Merge.swift` | 进度合并仲裁（lastReview 取胜、history 去重 50） |
| `Models/Sidecar.swift` | `StudyProgress`、`SidecarFile`（Codable） |
| `Models/CanvasEditor.swift` | JSONSerialization 读写 Canvas：解析/模板/日期组/未知字段保留 |
| `Sync/BookmarkStore.swift` | security-scoped bookmark 持久化与恢复 |
| `Sync/SyncService.swift` | 目录扫描、协调读写、原子写、轮询、合并入 SwiftData |
| `Sync/FolderPicker.swift` | UIDocumentPicker 目录选择器（UIViewControllerRepresentable） |
| `Store/DataStore.swift` | SwiftData `Entry` 模型与查询/评分写回 |
| `Theme/Theme.swift` | 毛玻璃、评分四色、日间黑/夜间暗紫 |
| `Views/HomeView.swift` | 首页：复习/学习双入口、词库卡片 |
| `Views/ReviewView.swift` | 复习卡：翻转 + 四向滑动 + 按钮 + 撤销 + 发音 |
| `Views/WordListView.swift` | 词库浏览：日期/首字母/熟练度三分组 |
| `Views/WordDetailView.swift` | 单词详情：编辑/删除/稳定度 |
| `Views/StatsView.swift` | 统计：日历下钻 + 热力图 |
| `Views/DictationView.swift` | 听写模式 |
| `Views/SettingsView.swift` | 设置：目录授权、暗夜、自动朗读、上限 |
| `Tests/FSRSTests.swift`、`StudyKeyTests.swift`、`MergeTests.swift`、`CanvasEditorTests.swift` | 单测（含冻结向量对拍） |

## 全局约定

- studyKey 双规则：Canvas 普通节点 `source:nodeId`；卡片词条 `语言:类型:规范文本`（v1 不同步卡片，仅边界实现）。
- `dueDate` 用本地 `YYYY-MM-DD`；`lastReview` 用 ISO 8601 带时区。
- 评分映射：不认识=again(1)、模糊=hard(2)、认识=good(3)、太简单=easy(4)。
- 所有文件写操作原子化（临时文件 + rename）；写边车前重读磁盘再合并。
- Canvas 节点文本模板：首行单词、可选别名行 `*a, b*`、空行后释义；新增词自建「今天」日期组。

---

## Task 1：在插件仓库生成冻结测试向量

**Files:**
- Create: `scripts/gen-sync-vectors.mjs`、`scripts/gen-sync-vectors.entry.ts`
- Output: `tests/fixtures/sync-vectors.json`

- [ ] **Step 1: 写生成器入口（TS，复用真实 fsrs.ts / study-key.ts）**

创建 `scripts/gen-sync-vectors.entry.ts`：

```ts
import {
  initStability, initDifficulty, nextDifficulty, retrievability,
  nextRecallStability, nextForgetStability, nextInterval,
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
```

- [ ] **Step 2: 写编译运行脚本**

创建 `scripts/gen-sync-vectors.mjs`：

```js
import esbuild from "esbuild";
import { execSync } from "node:child_process";

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
```

- [ ] **Step 3: 运行并记录向量**

Run: `node scripts/gen-sync-vectors.mjs`
Expected: 生成 `tests/fixtures/sync-vectors.json`，无报错

- [ ] **Step 4: 提交并作为两端对拍基线冻结**

```bash
git add scripts/gen-sync-vectors.mjs scripts/gen-sync-vectors.entry.ts tests/fixtures/sync-vectors.json
git commit -m "test: freeze cross-platform FSRS and studyKey vectors"
```

> 后续任何对 `fsrs.ts`/`study-key.ts` 的修改都必须先重跑本脚本并检查 diff。

---

## Task 2：Xcode 工程脚手架

- [ ] **Step 1: 新建工程**

Xcode → File → New → Project → iOS App，参数：

- Product Name: `NoteBarApp`；Team: 你的付费开发者账号；Organization Identifier: `com.notebar`（Bundle ID 生成为 `com.notebar.NoteBarApp`）
- Interface: SwiftUI；Language: Swift；Storage: None（SwiftData 由代码配置）
- Minimum Deployments: iOS 17.0
- 保存位置：**本仓库根目录**（工程文件夹就是 `NoteBarApp/`，`.xcodeproj` 与源码同级，这样本计划里所有相对路径和 git 命令直接可用）
- Build Settings → Swift Language Version 设为 **Swift 5**（保持非严格并发模式，避免 `@MainActor` 初始化报错）

- [ ] **Step 2: 建目录**

在工程里按「文件映射」创建 `App/Engine/Models/Sync/Store/Theme/Views` 分组，并把 Xcode 自动生成的 `ContentView.swift` 删除（Task 9 重建页面）。

- [ ] **Step 3: 开启 iCloud Documents 能力**

Target → Signing & Capabilities → + Capability → iCloud → 勾选 iCloud Documents，Container 使用 `iCloud.com.notebar.NoteBarApp`。

- [ ] **Step 4: 测试 target**

Unit Testing Bundle：`NoteBarAppTests`，勾选 Host Application。把 `tests/fixtures/sync-vectors.json` 拖入测试 target 的 Copy Bundle Resources。

- [ ] **Step 5: Info.plist 追加**

```xml
<key>UISupportsDocumentBrowser</key>
<true/>
<key>LSSupportsOpeningDocumentsInPlace</key>
<true/>
```

- [ ] **Step 6: 忽略工程本地文件**

`.gitignore` 末尾追加：

```text
DerivedData/
*.xcuserstate
xcuserdata/
```

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "chore: scaffold NoteBarApp Xcode project with iCloud Documents"
```

---

## Task 3：FSRS-5 Swift 移植与对拍

**Files:**
- Create: `NoteBarApp/Engine/FSRS.swift`
- Test: `NoteBarAppTests/FSRSTests.swift`

- [ ] **Step 1: 写对拍测试（先失败）**

创建 `NoteBarAppTests/FSRSTests.swift`：

```swift
import XCTest
@testable import NoteBarApp

final class FSRSTests: XCTestCase {
    func testFrozenVectors() throws {
        let url = Bundle(for: Self.self).url(forResource: "sync-vectors", withExtension: "json")!
        let data = try Data(contentsOf: url)
        let root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let vectors = root["fsrs"] as! [[String: Any]]

        for vector in vectors {
            let input = vector["input"] as! [String: Any]
            let output = vector["output"] as! [String: Any]
            let s = input["s"] as? Double
            let d = input["d"] as? Double
            let elapsed = input["elapsedDays"] as! Double
            let grade = FSRSGrade(rawValue: input["grade"] as! Int)!

            var nextS: Double
            var nextD: Double
            if let s, let d {
                let r = FSRS.retrievability(elapsed, s)
                nextS = grade == .again
                    ? FSRS.nextForgetStability(d, s, r)
                    : FSRS.nextRecallStability(d, s, r, grade)
                nextD = FSRS.nextDifficulty(d, grade)
            } else {
                nextS = FSRS.initStability(grade)
                nextD = FSRS.initDifficulty(grade)
            }

            XCTAssertEqual(round9(nextS), (output["s"] as! NSNumber).doubleValue, accuracy: 1e-9)
            XCTAssertEqual(round9(nextD), (output["d"] as! NSNumber).doubleValue, accuracy: 1e-9)
            XCTAssertEqual(FSRS.nextInterval(nextS), output["interval"] as! Int)
        }
    }
}

private func round9(_ value: Double) -> Double { (value * 1e9).rounded() / 1e9 }
```

- [ ] **Step 2: 运行确认失败**

Run: `xcodebuild test -project NoteBarApp.xcodeproj -scheme NoteBarApp -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: FAIL（FSRS 不存在）

- [ ] **Step 3: 实现 FSRS.swift**

```swift
import Foundation

enum FSRSGrade: Int, CaseIterable {
    case again = 1, hard = 2, good = 3, easy = 4
}

enum FSRS {
    static let w: [Double] = [
        0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604,
        0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605,
        2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
    ]
    static let decay = -0.5
    static let factor = pow(0.9, 1.0 / decay) - 1
    static let maxInterval = 36500.0

    static func clampD(_ d: Double) -> Double { min(10, max(1, d)) }

    static func initStability(_ grade: FSRSGrade) -> Double {
        max(0.1, w[grade.rawValue - 1])
    }

    static func initDifficulty(_ grade: FSRSGrade) -> Double {
        clampD(w[4] - exp(w[5] * Double(grade.rawValue - 1)) + 1)
    }

    static func nextDifficulty(_ d: Double, _ grade: FSRSGrade) -> Double {
        let delta = -w[6] * Double(grade.rawValue - 3)
        let damped = d + (delta * (10 - d)) / 9
        let regressed = w[7] * initDifficulty(.easy) + (1 - w[7]) * damped
        return clampD(regressed)
    }

    static func retrievability(_ tDays: Double, _ s: Double) -> Double {
        pow(1 + (factor * tDays) / s, decay)
    }

    static func nextRecallStability(_ d: Double, _ s: Double, _ r: Double, _ grade: FSRSGrade) -> Double {
        let hard = grade == .hard ? w[15] : 1.0
        let easy = grade == .easy ? w[16] : 1.0
        return s * (1 + exp(w[8]) * (11 - d) * pow(s, -w[9]) * (exp((1 - r) * w[10]) - 1) * hard * easy)
    }

    static func nextForgetStability(_ d: Double, _ s: Double, _ r: Double) -> Double {
        w[11] * pow(d, -w[12]) * (pow(s + 1, w[13]) - 1) * exp((1 - r) * w[14])
    }

    static func nextInterval(_ s: Double, targetRetention: Double = 0.9) -> Int {
        let interval = (s / factor) * (pow(targetRetention, 1.0 / decay) - 1)
        return min(Int(maxInterval), max(1, Int(interval.rounded())))
    }

    static func humanInterval(_ days: Double) -> String {
        if days < 1 { return "<1天" }
        if days < 30 { return "\(Int(days))天" }
        if days < 365 { return "\(Int((days / 30).rounded()))个月" }
        return String(format: "%.1f年", days / 365)
    }

    /// 一次评分后的完整调度结果（与桌面语义一致；冻结向量为准）
    static func schedule(
        s: Double?, d: Double?, lapses: Int?, elapsedDays: Double,
        grade: FSRSGrade, today: Date = Date(), graduatedThreshold: Double = 30
    ) -> (s: Double, d: Double, lapses: Int, interval: Int, dueDate: String, graduated: Bool) {
        var nextS: Double
        var nextD: Double
        var nextLapses = lapses ?? 0
        if let s, let d {
            let r = retrievability(elapsedDays, s)
            if grade == .again {
                nextS = nextForgetStability(d, s, r)
                nextLapses += 1
            } else {
                nextS = nextRecallStability(d, s, r, grade)
            }
            nextD = nextDifficulty(d, grade)
        } else {
            nextS = initStability(grade)
            nextD = initDifficulty(grade)
        }
        let interval = nextInterval(nextS)
        let due = Calendar.current.date(byAdding: .day, value: interval, to: startOfDay(today))!
        return (nextS, nextD, nextLapses, interval, Self.dayString(due), nextS >= graduatedThreshold)
    }

    static func startOfDay(_ date: Date) -> Date {
        Calendar.current.startOfDay(for: date)
    }

    static func dayString(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `xcodebuild test ...`
Expected: PASS（6 组向量全部通过）

- [ ] **Step 5: 提交**

```bash
git add NoteBarApp/Engine/FSRS.swift NoteBarAppTests/FSRSTests.swift
git commit -m "feat: port FSRS-5 to Swift with frozen-vector parity tests"
```

---

## Task 4：studyKey 双规则移植

**Files:**
- Create: `NoteBarApp/Engine/StudyKey.swift`
- Test: `NoteBarAppTests/StudyKeyTests.swift`

- [ ] **Step 1: 写对拍测试（先失败）**

创建 `NoteBarAppTests/StudyKeyTests.swift`：

```swift
import XCTest
@testable import NoteBarApp

final class StudyKeyTests: XCTestCase {
    func testFrozenVectors() throws {
        let url = Bundle(for: Self.self).url(forResource: "sync-vectors", withExtension: "json")!
        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let vectors = root["studyKeys"] as! [[String: Any]]
        for vector in vectors {
            let input = vector["input"] as! [String: Any]
            let expected = vector["expected"] as! String
            let key = StudyKey.build(
                word: input["word"] as! String,
                language: input["language"] as? String,
                type: input["type"] as? String
            )
            XCTAssertEqual(key, expected)
        }
    }

    func testCanvasFallbackKey() {
        XCTAssertEqual(StudyKey.canvas(source: "English/words.canvas", nodeId: "abcd"), "English/words.canvas:abcd")
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `xcodebuild test ...`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `NoteBarApp/Engine/StudyKey.swift`：

```swift
import Foundation

enum StudyKey {
    /// 与 JS 端 normalizeStudyText 对齐：NFKC → trim → 空白折叠 → 去首尾标点/符号 → 小写。
    /// 小写统一用 Unicode 默认（JS 端 `toLowerCase()` ↔ Swift `lowercased()`），不依赖运行环境 locale。
    static func normalizeText(_ value: String) -> String {
        var s = nfkc(value).trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        s = s.trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.symbols))
        return s.lowercased()
    }

    static func normalizeLanguage(_ language: String?) -> String {
        let s = nfkc(language ?? "und").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return s.isEmpty ? "und" : s
    }

    static func inferType(word: String, language: String?) -> String {
        let text = normalizeText(word)
        if normalizeLanguage(language).hasPrefix("zh") { return "concept" }
        if text.range(of: "[\\s-]", options: .regularExpression) != nil { return "phrase" }
        return "word"
    }

    static func build(word: String, language: String?, type: String?) -> String? {
        let text = normalizeText(word)
        guard !text.isEmpty else { return nil }
        let lang = normalizeLanguage(language)
        let kind = type ?? inferType(word: word, language: language)
        return "\(lang):\(kind):\(text)"
    }

    /// Canvas 普通节点的进度键（桌面回退规则 `source:nodeId`）
    static func canvas(source: String, nodeId: String) -> String {
        "\(source):\(nodeId)"
    }

    private static func nfkc(_ s: String) -> String {
        s.applyingTransform(StringTransform(rawValue: "NFKC"), reverse: false) ?? s
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `xcodebuild test ...`
Expected: PASS（含 `ｉ`/`İ`/`合同`/短语用例）

- [ ] **Step 5: 提交**

```bash
git add NoteBarApp/Engine/StudyKey.swift NoteBarAppTests/StudyKeyTests.swift
git commit -m "feat: port dual-rule studyKey to Swift with locale-safe normalization"
```

---

## Task 5：模型与合并逻辑

**Files:**
- Create: `NoteBarApp/Models/Sidecar.swift`、`NoteBarApp/Engine/Merge.swift`
- Test: `NoteBarAppTests/MergeTests.swift`

- [ ] **Step 1: 写失败测试**

创建 `NoteBarAppTests/MergeTests.swift`：

```swift
import XCTest
@testable import NoteBarApp

final class MergeTests: XCTestCase {
    func testLastReviewWinsAndHistoryDedup() {
        var local = StudyProgress()
        local.s = 10
        local.lastReview = "2026-08-12T00:00:00.000Z"
        local.history = [ReviewRecord(date: "2026-08-12T00:00:00.000Z", quality: "good")]

        var remote = StudyProgress()
        remote.s = 99
        remote.lastReview = "2026-08-13T00:00:00.000Z"
        remote.history = [
            ReviewRecord(date: "2026-08-12T00:00:00.000Z", quality: "good"),
            ReviewRecord(date: "2026-08-13T00:00:00.000Z", quality: "again"),
        ]

        let merged = Merge.progress(local: local, remote: remote)!
        XCTAssertEqual(merged.s, 99)
        XCTAssertEqual(merged.history?.count, 2)
        XCTAssertEqual(merged.history?.last?.quality, "again")
    }

    func testHistoryCappedAt50() {
        let a = (0..<50).map { i in
            ReviewRecord(date: ISO(i), quality: "good")
        }
        let b = [ReviewRecord(date: "2026-08-14T00:00:00.000Z", quality: "hard")]
        let merged = Merge.history(a: a, b: b)!
        XCTAssertEqual(merged.count, 50)
        XCTAssertEqual(merged.last?.quality, "hard")
    }

    private func ISO(_ second: Int) -> String {
        let d = Date(timeIntervalSince1970: TimeInterval(second))
        return ISO8601DateFormatter().string(from: d)
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `xcodebuild test ...`
Expected: FAIL

- [ ] **Step 3: 实现模型**

创建 `NoteBarApp/Models/Sidecar.swift`：

```swift
import Foundation

struct ReviewRecord: Codable, Hashable {
    var date: String
    var quality: String // again | hard | good | easy
}

/// 与插件 StudyProgressItem 逐字段对应
struct StudyProgress: Codable {
    var status: String? // new | learning | review | mastered
    var stage: Int?
    var reps: Int?
    var ef: Double?
    var interval: Int?
    var s: Double?
    var d: Double?
    var lapses: Int?
    var dueDate: String?
    var lastReview: String?
    var history: [ReviewRecord]?
    var lifecycle: String? // active | graduated | archived | retired
    var pinned: Bool?
    var masteredAt: String?
    var updatedAt: String?

    init() {}
}

struct SidecarFile: Codable {
    var version: Int
    var book: String
    var words: [String: StudyProgress]
    var updatedAt: String
}
```

- [ ] **Step 4: 实现合并**

创建 `NoteBarApp/Engine/Merge.swift`：

```swift
import Foundation

enum Merge {
    static let historyLimit = 50

    static func timeOf(_ value: String?) -> Double {
        guard let value else { return 0 }
        return ISO8601DateFormatter().date(from: value)?.timeIntervalSince1970
            ?? Date(timeIntervalSince1970: 0).timeIntervalSince1970
    }

    static func history(a: [ReviewRecord]?, b: [ReviewRecord]?) -> [ReviewRecord]? {
        var map: [String: ReviewRecord] = [:]
        for record in (a ?? []) + (b ?? []) {
            let key = "\(record.date)|\(record.quality)"
            if let existing = map[key] {
                if timeOf(record.date) >= timeOf(existing.date) { map[key] = record }
            } else {
                map[key] = record
            }
        }
        let sorted = map.values.sorted { timeOf($0.date) < timeOf($1.date) }
        return sorted.isEmpty ? nil : Array(sorted.suffix(historyLimit))
    }

    /// lastReview 较新者胜；history 去重合并
    static func progress(local: StudyProgress?, remote: StudyProgress?) -> StudyProgress? {
        guard let local else { return remote }
        guard let remote else { return local }
        let remoteWins = timeOf(remote.lastReview) > timeOf(local.lastReview)
        let winner = remoteWins ? remote : local
        let loser = remoteWins ? local : remote

        var merged = loser
        if let s = winner.s { merged.s = s }
        if let d = winner.d { merged.d = d }
        merged.status = winner.status ?? loser.status
        merged.stage = winner.stage ?? loser.stage
        merged.reps = winner.reps ?? loser.reps
        merged.ef = winner.ef ?? loser.ef
        merged.interval = winner.interval ?? loser.interval
        merged.lapses = winner.lapses ?? loser.lapses
        merged.dueDate = winner.dueDate ?? loser.dueDate
        merged.lastReview = winner.lastReview ?? loser.lastReview
        merged.lifecycle = winner.lifecycle ?? loser.lifecycle
        merged.pinned = winner.pinned ?? loser.pinned
        merged.masteredAt = winner.masteredAt ?? loser.masteredAt
        merged.updatedAt = winner.updatedAt ?? loser.updatedAt
        merged.history = history(a: local.history, b: remote.history)
        return merged
    }

    static func isConflictCopy(_ name: String) -> Bool {
        name.range(of: "^.+ \\d+\\.nb-sync\\.json$", options: .regularExpression) != nil
    }

    static func conflictBaseName(_ name: String) -> String? {
        let pattern = "^(.+) \\d+\\.nb-sync\\.json$"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(name.startIndex..., in: name)
        guard let match = regex.firstMatch(in: name, range: range),
              match.numberOfRanges > 1,
              let r = Range(match.range(at: 1), in: name) else { return nil }
        return "\(name[r]).nb-sync.json"
    }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `xcodebuild test ...`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add NoteBarApp/Models/Sidecar.swift NoteBarApp/Engine/Merge.swift NoteBarAppTests/MergeTests.swift
git commit -m "feat: add sidecar models and lastReview-wins merge logic"
```

---

## Task 6：Canvas 读写（JSONSerialization）

**Files:**
- Create: `NoteBarApp/Models/CanvasEditor.swift`
- Test: `NoteBarAppTests/CanvasEditorTests.swift`

- [ ] **Step 1: 写失败测试**

创建 `NoteBarAppTests/CanvasEditorTests.swift`：

```swift
import XCTest
@testable import NoteBarApp

final class CanvasEditorTests: XCTestCase {
    func testParseTemplate() throws {
        let json = """
        {"nodes":[
          {"id":"n1","type":"text","x":0,"y":0,"width":260,"height":120,"text":"hello\\n*hi, hey*\\n\\n你好，问候"}
        ],"edges":[]}
        """
        let words = try CanvasEditor.parseWords(data: Data(json.utf8), source: "English/words.canvas")
        XCTAssertEqual(words.count, 1)
        XCTAssertEqual(words[0].word, "hello")
        XCTAssertEqual(words[0].aliases, ["hi", "hey"])
        XCTAssertEqual(words[0].definition, "你好，问候")
    }

    func testAddWordCreatesTodayGroupAndPreservesUnknownFields() throws {
        var data = try JSONSerialization.jsonObject(with: Data(#"{"nodes":[],"edges":[],"futureField":{"keep":true}}"#.utf8)) as! [String: Any]
        let nodeId = try CanvasEditor.addWord(
            data: &data, word: "world", definition: "世界", aliases: ["globe"],
            color: "2", cardWidth: 260, cardHeight: 120
        )
        XCTAssertEqual(nodeId.count, 16)
        let nodes = data["nodes"] as! [[String: Any]]
        let group = nodes.first { ($0["type"] as? String) == "group" }
        XCTAssertEqual(group?["label"] as? String, CanvasEditor.todayLabel())
        let textNode = nodes.first { ($0["type"] as? String) == "text" }!
        XCTAssertEqual(textNode["text"] as? String, "world\n*globe*\n\n世界")
        XCTAssertEqual((data["futureField"] as? [String: Any])?["keep"] as? Bool, true)
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `xcodebuild test ...`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `NoteBarApp/Models/CanvasEditor.swift`：

```swift
import Foundation

struct ParsedWord {
    var nodeId: String
    var word: String
    var aliases: [String]
    var definition: String
    var color: String?
    var addedDate: String?
}

enum CanvasEditor {
    static func randomHexId() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        _ = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 8, $0.baseAddress!) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func todayLabel(date: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    static func parseWords(data: Data, source: String) throws -> [ParsedWord] {
        let root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let nodes = (root["nodes"] as? [[String: Any]]) ?? []
        let groups = nodes.filter { ($0["type"] as? String) == "group" }
        let dateGroups = groups.filter { label($0).flatMap { $0.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil } ?? false }

        var words: [ParsedWord] = []
        for node in nodes {
            guard let type = node["type"] as? String, let id = node["id"] as? String else { continue }
            let text: String?
            switch type {
            case "text": text = node["text"] as? String
            case "file": text = nil // v1 文件节点按文件名处理，见下方 fallback
            default: text = nil
            }
            guard let parsed = parseText(text ?? (node["file"] as? String) ?? "", nodeId: id) else { continue }
            var addedDate: String?
            for group in dateGroups where nodeInGroup(node, group) { addedDate = label(group) }
            words.append(ParsedWord(
                nodeId: id, word: parsed.word, aliases: parsed.aliases,
                definition: parsed.definition, color: node["color"] as? String, addedDate: addedDate
            ))
        }
        return words
    }

    static func addWord(
        data: inout [String: Any], word: String, definition: String,
        aliases: [String], color: String?, cardWidth: Double, cardHeight: Double
    ) throws -> String {
        var nodes = (data["nodes"] as? [[String: Any]]) ?? []
        let nodeId = randomHexId()

        var group = nodes.first { ($0["type"] as? String) == "group" && label($0) == todayLabel() }
        if group == nil {
            let maxX = nodes.filter { ($0["type"] as? String) == "group" }
                .map { ($0["x"] as? Double ?? 0) + ($0["width"] as? Double ?? 0) }
                .max() ?? 0
            let newGroup: [String: Any] = [
                "id": randomHexId(), "type": "group",
                "x": nodes.isEmpty ? 0 : maxX + 40, "y": 0,
                "width": 48 + cardWidth, "height": 48 + cardHeight,
                "label": todayLabel(),
            ]
            nodes.append(newGroup)
            group = newGroup
        }

        let members = nodes.filter { $0["type"] as? String != "group" && nodeInGroup($0, group!) }
        let index = members.count
        let col = index % 2, row = index / 2
        let gx = group!["x"] as? Double ?? 0
        let gy = group!["y"] as? Double ?? 0

        var text = word
        if !aliases.isEmpty { text += "\n*\(aliases.joined(separator: ", "))*" }
        if !definition.isEmpty { text += "\n\n\(definition)" }

        var node: [String: Any] = [
            "id": nodeId, "type": "text",
            "x": gx + 24 + Double(col) * (cardWidth + 12),
            "y": gy + 24 + Double(row) * (cardHeight + 12),
            "width": cardWidth, "height": cardHeight, "text": text,
        ]
        if let color { node["color"] = color }
        nodes.append(node)
        data["nodes"] = nodes
        return nodeId
    }

    static func updateWord(data: inout [String: Any], nodeId: String, word: String, definition: String, aliases: [String]) -> Bool {
        guard var nodes = data["nodes"] as? [[String: Any]],
              let i = nodes.firstIndex(where: { $0["id"] as? String == nodeId }) else { return false }
        var text = word
        if !aliases.isEmpty { text += "\n*\(aliases.joined(separator: ", "))*" }
        if !definition.isEmpty { text += "\n\n\(definition)" }
        nodes[i]["text"] = text
        data["nodes"] = nodes
        return true
    }

    static func deleteWord(data: inout [String: Any], nodeId: String) -> Bool {
        guard var nodes = data["nodes"] as? [[String: Any]],
              let i = nodes.firstIndex(where: { $0["id"] as? String == nodeId }) else { return false }
        nodes.remove(at: i)
        data["nodes"] = nodes
        return true
    }

    // MARK: - 私有

    private static func label(_ node: [String: Any]) -> String? { node["label"] as? String }

    private static func parseText(_ text: String, nodeId: String) -> (word: String, aliases: [String], definition: String)? {
        var lines = text.components(separatedBy: "\n")
        while let first = lines.first, first.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeFirst() }
        guard var word = lines.first?.trimmingCharacters(in: .whitespaces) else { return nil }
        word = word.replacingOccurrences(of: "^#+\\s*", with: "", options: .regularExpression)
        word = stripMarkdown(word)
        guard !word.isEmpty else { return nil }
        lines.removeFirst()

        var aliases: [String] = []
        var definition: [String] = []
        var seenDefinition = false
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespaces)
            if !seenDefinition, t.hasPrefix("*"), t.hasSuffix("*"), !t.hasPrefix("**"), !t.hasSuffix("**"), t.count > 2 {
                aliases = String(t.dropFirst().dropLast()).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            } else if !t.isEmpty {
                seenDefinition = true
                definition.append(t)
            } else if seenDefinition {
                definition.append(t)
            }
        }
        return (word.lowercased(), aliases, definition.joined(separator: "\n").trimmingCharacters(in: .newlines))
    }

    private static func stripMarkdown(_ s: String) -> String {
        s.replacingOccurrences(of: #"\*\*(.*?)\*\*"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"\*(.*?)\*"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"__(.*?)__"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"`(.*?)`"#, with: "$1", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    private static func nodeInGroup(_ node: [String: Any], _ group: [String: Any]) -> Bool {
        let nx = node["x"] as? Double ?? 0, ny = node["y"] as? Double ?? 0
        let nw = node["width"] as? Double ?? 200, nh = node["height"] as? Double ?? 60
        let gx = group["x"] as? Double ?? 0, gy = group["y"] as? Double ?? 0
        let gw = group["width"] as? Double ?? 0, gh = group["height"] as? Double ?? 0
        let cx = nx + nw / 2, cy = ny + nh / 2
        return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `xcodebuild test ...`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add NoteBarApp/Models/CanvasEditor.swift NoteBarAppTests/CanvasEditorTests.swift
git commit -m "feat: add canvas parser/writer with template and date-group support"
```

---

## Task 7：SwiftData 与同步服务

**Files:**
- Create: `NoteBarApp/Store/DataStore.swift`、`NoteBarApp/Sync/BookmarkStore.swift`、`NoteBarApp/Sync/SyncService.swift`

- [ ] **Step 1: SwiftData 模型**

创建 `NoteBarApp/Store/DataStore.swift`：

```swift
import Foundation
import SwiftData

@Model
final class Entry {
    @Attribute(.unique) var studyKey: String
    var book: String
    var source: String
    var nodeId: String
    var word: String
    var aliases: [String]
    var definition: String
    var color: String?
    var addedDate: String?
    var s: Double?
    var d: Double?
    var lapses: Int?
    var dueDate: String?
    var lastReview: String?
    var history: [ReviewRecord]?
    var lifecycle: String?
    var pinned: Bool?
    var status: String?
    var stage: Int?

    init(
        studyKey: String, book: String, source: String, nodeId: String,
        word: String, aliases: [String] = [], definition: String = "",
        color: String? = nil, addedDate: String? = nil
    ) {
        self.studyKey = studyKey
        self.book = book
        self.source = source
        self.nodeId = nodeId
        self.word = word
        self.aliases = aliases
        self.definition = definition
        self.color = color
        self.addedDate = addedDate
    }

    var progress: StudyProgress {
        get {
            var p = StudyProgress()
            p.status = status; p.stage = stage; p.s = s; p.d = d
            p.lapses = lapses; p.dueDate = dueDate; p.lastReview = lastReview
            p.history = history; p.lifecycle = lifecycle; p.pinned = pinned
            return p
        }
        set {
            status = newValue.status; stage = newValue.stage; s = newValue.s; d = newValue.d
            lapses = newValue.lapses; dueDate = newValue.dueDate; lastReview = newValue.lastReview
            history = newValue.history; lifecycle = newValue.lifecycle; pinned = newValue.pinned
        }
    }
}

@MainActor
final class DataStore {
    let context: ModelContext
    init(context: ModelContext) { self.context = context }

    func entry(forKey key: String) throws -> Entry? {
        var descriptor = FetchDescriptor<Entry>(predicate: #Predicate { $0.studyKey == key })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    func upsert(word: ParsedWord, book: String, source: String, progress: StudyProgress?) throws {
        let key = StudyKey.canvas(source: source, nodeId: word.nodeId)
        if let existing = try entry(forKey: key) {
            existing.word = word.word
            existing.aliases = word.aliases
            existing.definition = word.definition
            existing.color = word.color
            existing.addedDate = word.addedDate
            if let progress { existing.progress = progress }
        } else {
            let e = Entry(studyKey: key, book: book, source: source, nodeId: word.nodeId,
                          word: word.word, aliases: word.aliases, definition: word.definition,
                          color: word.color, addedDate: word.addedDate)
            if let progress { e.progress = progress }
            context.insert(e)
        }
        try context.save()
    }
}
```

- [ ] **Step 2: bookmark 存取**

创建 `NoteBarApp/Sync/BookmarkStore.swift`：

```swift
import Foundation

enum BookmarkStore {
    private static let key = "sync-folder-bookmark"

    static func save(_ bookmark: Data) {
        UserDefaults.standard.set(bookmark, forKey: key)
    }

    static func load() -> Data? {
        UserDefaults.standard.data(forKey: key)
    }

    static func resolve() -> URL? {
        guard let data = load() else { return nil }
        var stale = false
        let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        guard let url, !stale else { return nil }
        return url.startAccessingSecurityScopedResource() ? url : nil
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
```

- [ ] **Step 3: SyncService**

创建 `NoteBarApp/Sync/SyncService.swift`：

```swift
import Foundation
import SwiftData

@MainActor
final class SyncService {
    private(set) var syncDir: URL?
    private var timer: Timer?
    private let store: DataStore
    private let onConflict: (String) -> Void

    init(store: DataStore, onConflict: @escaping (String) -> Void) {
        self.store = store
        self.onConflict = onConflict
    }

    func configure(folder url: URL) {
        syncDir = url
        let bookmark = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        if let bookmark { BookmarkStore.save(bookmark) }
    }

    func start() {
        stop()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.scan() }
        }
        Task { @MainActor in await scan() }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// 全量扫描：canvas 解析 + 边车进度合并入 SwiftData
    func scan() async {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }
        let fm = FileManager.default
        let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: nil)
        var sidecars: [String: SidecarFile] = [:]
        var canvases: [(relative: String, url: URL)] = []
        while let url = enumerator?.nextObject() as? URL {
            let ext = url.pathExtension.lowercased()
            let rel = url.path.replacingOccurrences(of: root.path + "/", with: "")
            if ext == "canvas" {
                canvases.append((rel, url))
            } else if ext == "json" && url.lastPathComponent.hasSuffix(".nb-sync.json") {
                if let data = try? Data(contentsOf: url), let sidecar = try? JSONDecoder().decode(SidecarFile.self, from: data) {
                    sidecars[sidecar.book] = sidecar
                }
            }
        }

        for (relative, url) in canvases {
            let data = (try? Data(contentsOf: url)) ?? Data()
            let words = (try? CanvasEditor.parseWords(data: data, source: relative)) ?? []
            for word in words {
                let key = StudyKey.canvas(source: relative, nodeId: word.nodeId)
                let progress = sidecars[relative]?.words[key]
                if let existing = try? store.entry(forKey: key) {
                    existing.word = word.word
                    existing.definition = word.definition
                    existing.aliases = word.aliases
                    if let progress, let merged = Merge.progress(local: existing.progress, remote: progress) {
                        existing.progress = merged
                    }
                } else {
                    try? store.upsert(word: word, book: relative, source: relative, progress: progress)
                }
            }
        }
        try? store.context.save()
    }

    /// 评分后写回边车：读磁盘 → 合并 → 原子写
    func persist(book: String, key: String, progress: StudyProgress) {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }
        let base = book.replacingOccurrences(of: "\\.canvas$", with: "", options: .regularExpression)
        let sidecarURL = root.appendingPathComponent("\(base).nb-sync.json")
        var sidecar: SidecarFile
        if let data = try? Data(contentsOf: sidecarURL),
           let decoded = try? JSONDecoder().decode(SidecarFile.self, from: data) {
            sidecar = decoded
        } else {
            sidecar = SidecarFile(version: 1, book: book, words: [:], updatedAt: "")
        }
        sidecar.words[key] = Merge.progress(local: sidecar.words[key], remote: progress)
        sidecar.updatedAt = ISO8601DateFormatter().string(from: Date())
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(sidecar) {
            writeAtomically(data, to: sidecarURL)
        }
    }

    func readCanvas(_ relative: String) -> [String: Any]? {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return nil }
        let url = root.appendingPathComponent(relative)
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json
    }

    func writeCanvas(_ relative: String, data: [String: Any]) {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }
        let url = root.appendingPathComponent(relative)
        let encoded = try? JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys])
        guard let encoded else { return }
        writeAtomically(encoded, to: url)
    }

    private func writeAtomically(_ data: Data, to url: URL) {
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.appendingPathExtension("tmp")
        var coordinatorError: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinatorError) { target in
            try? data.write(to: tmp, options: .atomic)
            _ = try? fm.replaceItemAt(target, withItemAt: tmp)
        }
    }
}
```

- [ ] **Step 4: 构建验证**

Run: `xcodebuild build -project NoteBarApp.xcodeproj -scheme NoteBarApp -destination 'generic/platform=iOS Simulator'`
Expected: BUILD SUCCEEDED

- [ ] **Step 5: 提交**

```bash
git add NoteBarApp/Store/DataStore.swift NoteBarApp/Sync/BookmarkStore.swift NoteBarApp/Sync/SyncService.swift
git commit -m "feat: add SwiftData store, bookmark handling, and sync service"
```

---

## Task 8：主题与全局状态

**Files:**
- Create: `NoteBarApp/Theme/Theme.swift`、`NoteBarApp/App/AppState.swift`

- [ ] **Step 1: 主题**

创建 `NoteBarApp/Theme/Theme.swift`：

```swift
import SwiftUI

enum Theme {
    static let againRed = Color(red: 0.76, green: 0.22, blue: 0.24)
    static let hardGray = Color(red: 0.55, green: 0.58, blue: 0.62)
    static let goodGreen = Color(red: 0.18, green: 0.55, blue: 0.34)
    static let easyOrange = Color(red: 0.90, green: 0.54, blue: 0.0)
    static let darkPurpleWord = Color(red: 0.72, green: 0.62, blue: 1.0)

    static func wordColor(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkPurpleWord : .black
    }
}

struct GlassBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

extension View {
    func glassCard() -> some View { modifier(GlassBackground()) }
}
```

- [ ] **Step 2: AppState**

创建 `NoteBarApp/App/AppState.swift`：

```swift
import SwiftUI
import SwiftData

@MainActor
final class AppState: ObservableObject {
    @Published var settings = Settings()
    @Published var syncStatus = "未连接"
    @Published var conflicts: [String] = []

    let sync: SyncService

    init(context: ModelContext) {
        sync = SyncService(store: DataStore(context: context)) { [weak self] message in
            self?.conflicts.append(message)
        }
    }

    struct Settings {
        var autoPronounce = true
        var forceDarkMode = false
        var dailyNewWordLimit = 20
        var dailyReviewLimit = 50
        var dictationPerSession = 20
        var ttsTemplate = "https://dict.youdao.com/dictvoice?audio={{word}}&type=2"
    }

    func ttsURL(word: String) -> URL? {
        let encoded = word.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? word
        let url = settings.ttsTemplate
            .replacingOccurrences(of: "{{word}}", with: encoded)
            .replacingOccurrences(of: "{{type}}", with: "2")
            .replacingOccurrences(of: "{{accent}}", with: "us")
        return URL(string: url)
    }

    func speak(_ word: String) {
        if let url = ttsURL(word: word) {
            Task { await AudioPlayer.play(url: url) }
        }
    }
}

enum AudioPlayer {
    static func play(url: URL) async {
        // 简化实现：AVFoundation 播放远程音频，失败降级 AVSpeechSynthesizer
        _ = url
        let utterance = AVSpeechUtterance(string: url.absoluteString)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        AVSpeechSynthesizer().speak(utterance)
    }
}
```

> 说明：`AudioPlayer.play` 的完整实现用 `AVPlayer` 播远程 URL，`catch` 时降级 `AVSpeechSynthesizer` 朗读 `word` 本身；此处骨架演示接口，实现时把 `word` 作为参数传入。

- [ ] **Step 3: 构建验证**

Run: `xcodebuild build ...`
Expected: BUILD SUCCEEDED

- [ ] **Step 4: 提交**

```bash
git add NoteBarApp/Theme/Theme.swift NoteBarApp/App/AppState.swift
git commit -m "feat: add glass theme and app state with TTS"
```

---

## Task 9：首页与复习卡

**Files:**
- Create: `NoteBarApp/Views/HomeView.swift`、`NoteBarApp/Views/ReviewView.swift`、`NoteBarApp/App/NoteBarApp.swift`

- [ ] **Step 1: App 入口**

创建 `NoteBarApp/App/NoteBarApp.swift`：

```swift
import SwiftUI
import SwiftData

@main
struct NoteBarApp: App {
    let container: ModelContainer
    @StateObject private var appState: AppState

    init() {
        let schema = Schema([Entry.self])
        container = try! ModelContainer(for: schema)
        _appState = StateObject(wrappedValue: AppState(context: container.mainContext))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(\.modelContext, container.mainContext)
                .environmentObject(appState)
                .preferredColorScheme(appState.settings.forceDarkMode ? .dark : nil)
                .onAppear { appState.sync.start() }
        }
    }
}

struct RootView: View {
    var body: some View {
        TabView {
            HomeView().tabItem { Label("学习", systemImage: "book.fill") }
            WordListView().tabItem { Label("词库", systemImage: "books.vertical") }
            StatsView().tabItem { Label("统计", systemImage: "chart.bar.fill") }
            SettingsView().tabItem { Label("设置", systemImage: "gearshape.fill") }
        }
    }
}
```

- [ ] **Step 2: 首页**

创建 `NoteBarApp/Views/HomeView.swift`：

```swift
import SwiftUI
import SwiftData

struct HomeView: View {
    @EnvironmentObject var appState: AppState
    @Query private var entries: [Entry]

    private var dueCount: Int {
        let today = FSRS.dayString(Date())
        return entries.filter { entry in
            guard let due = entry.dueDate, due <= today else { return false }
            return entry.lifecycle != "graduated" && entry.lifecycle != "archived" && entry.lifecycle != "retired"
        }.count
    }

    private var newCount: Int {
        entries.filter { $0.s == nil && ($0.lifecycle == nil || $0.lifecycle == "active") }.count
    }

    private var books: [String] {
        Array(Set(entries.map(\.book))).sorted()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("学习").font(.largeTitle.bold())
                    HStack(spacing: 10) {
                        NavigationLink {
                            ReviewView(mode: .review)
                        } label: {
                            Label("开始复习", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(.blue, in: RoundedRectangle(cornerRadius: 14))
                                .foregroundStyle(.white)
                        }
                        NavigationLink {
                            ReviewView(mode: .learn)
                        } label: {
                            Label("开始学习", systemImage: "sparkles")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(.purple, in: RoundedRectangle(cornerRadius: 14))
                                .foregroundStyle(.white)
                        }
                    }
                    Text("今日待复习 \(dueCount) · 新词 \(newCount)").font(.subheadline).foregroundStyle(.secondary)
                    Text("我的词库").font(.headline)
                    ForEach(books, id: \.self) { book in
                        NavigationLink {
                            WordListView(book: book)
                        } label: {
                            HStack {
                                Text(book).fontWeight(.medium)
                                Spacer()
                                Text("待复习 \(dueCount)").font(.caption).foregroundStyle(.red)
                            }
                            .padding()
                            .glassCard()
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding()
            }
        }
    }
}
```

- [ ] **Step 3: 复习卡（翻转 + 四向滑动）**

创建 `NoteBarApp/Views/ReviewView.swift`：

```swift
import SwiftUI
import SwiftData

struct ReviewView: View {
    enum Mode { case review, learn }
    let mode: Mode

    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) var scheme
    @Environment(\.modelContext) private var context
    @Query private var all: [Entry]
    @State private var queue: [Entry] = []
    @State private var index = 0
    @State private var flipped = false
    @State private var drag: CGSize = .zero
    @State private var activeDirection: Direction?
    @State private var preview: String?
    @State private var undoStack: [(Entry, StudyProgress)] = []
    @Environment(\.dismiss) private var dismiss

    enum Direction: String {
        case good = "认识", again = "不认识", hard = "模糊", easy = "太简单"
    }

    private var current: Entry? { queue.indices.contains(index) ? queue[index] : nil }

    var body: some View {
        VStack(spacing: 12) {
            if let current {
                HStack {
                    Text("\(index + 1) / \(queue.count)")
                    Spacer()
                    Button("撤销") { undo() }.disabled(undoStack.isEmpty)
                }
                .font(.caption).foregroundStyle(.secondary)

                ZStack {
                    cardFace(current, back: false)
                        .opacity(flipped ? 0 : 1)
                        .rotation3DEffect(.degrees(flipped ? 180 : 0), axis: (x: 0, y: 1, z: 0))
                    cardFace(current, back: true)
                        .opacity(flipped ? 1 : 0)
                        .rotation3DEffect(.degrees(flipped ? 0 : -180), axis: (x: 0, y: 1, z: 0))
                }
                .frame(maxHeight: 420)
                .overlay(alignment: .center) {
                    if let dir = activeDirection {
                        Text(dir.rawValue)
                            .font(.title3.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16).padding(.vertical, 8)
                            .background(color(for: dir), in: Capsule())
                            .allowsHitTesting(false)
                    }
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 24)
                        .strokeBorder(color(for: activeDirection).opacity(activeDirection == nil ? 0 : 0.9), lineWidth: 4)
                }
                .gesture(
                    DragGesture(minimumDistance: 20)
                        .onChanged { value in drag = value.translation; activeDirection = direction(for: drag) }
                        .onEnded { value in
                            defer { drag = .zero; activeDirection = nil }
                            guard let dir = direction(for: value.translation), absMax(value.translation) > 60 else { return }
                            rate(dir)
                        }
                )
                .onTapGesture { withAnimation(.spring(duration: 0.45)) { flipped.toggle() } }

                if let preview {
                    Text("下次 \(preview)").font(.caption).foregroundStyle(.secondary)
                }

                HStack(spacing: 8) {
                    rateButton("不认识", .again, .red)
                    rateButton("模糊", .hard, .gray)
                    rateButton("认识", .good, .green)
                }
            } else {
                ContentUnavailableView("全部完成", systemImage: "checkmark.circle", description: Text("本轮没有更多卡片"))
                Button("返回") { dismiss() }.buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: buildQueue)
    }

    private func cardFace(_ entry: Entry, back: Bool) -> some View {
        VStack(spacing: 12) {
            if back {
                Text(entry.definition.isEmpty ? "（无释义）" : entry.definition)
                    .multilineTextAlignment(.center)
                    .font(.title3)
            } else {
                Text(entry.word)
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.wordColor(scheme))
                Button { appState.speak(entry.word) } label: { Image(systemName: "speaker.wave.2.fill") }
                    .font(.title2)
                Text("点击翻面 · 四向滑动评分").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .glassCard()
    }

    private func rateButton(_ title: String, _ dir: Direction, _ color: Color) -> some View {
        Button { rate(dir) } label: {
            Text(title).frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(color.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(color)
        }
    }

    private func rate(_ dir: Direction) {
        guard let entry = current else { return }
        let before = entry.progress
        let grade = grade(for: dir)
        let elapsed = entry.lastReview.flatMap(FSRS.dayStringSinceReview) ?? 0
        let result = FSRS.schedule(s: entry.s, d: entry.d, lapses: entry.lapses, elapsedDays: elapsed, grade: grade)
        var progress = before
        progress.s = result.s; progress.d = result.d; progress.lapses = result.lapses
        progress.dueDate = result.dueDate
        progress.lastReview = ISO8601DateFormatter().string(from: Date())
        progress.history = Merge.history(a: entry.history, b: [ReviewRecord(date: progress.lastReview!, quality: grade.label)])!
        if result.graduated { progress.lifecycle = "graduated" }
        undoStack.append((entry, before))
        entry.progress = progress
        try? context.save()
        preview = "\(result.interval) 天后"
        appState.sync.persist(book: entry.book, key: entry.studyKey, progress: progress)
        if appState.settings.autoPronounce { appState.speak(entry.word) }
        withAnimation(.spring(duration: 0.35)) { index += 1; flipped = false; preview = nil }
    }

    private func undo() {
        guard let (entry, progress) = undoStack.popLast() else { return }
        entry.progress = progress
        try? context.save()
        index = max(0, index - 1)
    }

    private func buildQueue() {
        let today = FSRS.dayString(Date())
        let limit = mode == .review ? appState.settings.dailyReviewLimit : appState.settings.dailyNewWordLimit
        let active = all.filter { !["graduated", "archived", "retired"].contains($0.lifecycle ?? "") }
        switch mode {
        case .review:
            queue = active.filter { ($0.dueDate ?? "") <= today }.sorted { ($0.dueDate ?? "") < ($1.dueDate ?? "") }
        case .learn:
            queue = active.filter { $0.s == nil }
        }
        queue = Array(queue.prefix(limit))
    }

    private func direction(for size: CGSize) -> Direction? {
        if abs(size.width) < 20 && abs(size.height) < 20 { return nil }
        if abs(size.width) >= abs(size.height) { return size.width < 0 ? .good : .again }
        return size.height < 0 ? .easy : .hard
    }

    private func absMax(_ size: CGSize) -> CGFloat { max(abs(size.width), abs(size.height)) }

    private func color(for dir: Direction?) -> Color {
        switch dir {
        case .good: return Theme.goodGreen
        case .again: return Theme.againRed
        case .hard: return Theme.hardGray
        case .easy: return Theme.easyOrange
        case nil: return .clear
        }
    }

    private func grade(for dir: Direction) -> FSRSGrade {
        switch dir {
        case .again: return .again
        case .hard: return .hard
        case .good: return .good
        case .easy: return .easy
        }
    }
}

extension FSRS {
    static func dayStringSinceReview(_ iso: String) -> Double {
        guard let date = ISO8601DateFormatter().date(from: iso) else { return 0 }
        let start = startOfDay(Date()).timeIntervalSince(date)
        return max(0, (start / 86400).rounded())
    }
}

extension FSRSGrade {
    var label: String {
        switch self {
        case .again: return "again"
        case .hard: return "hard"
        case .good: return "good"
        case .easy: return "easy"
        }
    }
}
```

- [ ] **Step 4: 构建验证**

Run: `xcodebuild build ...`
Expected: BUILD SUCCEEDED

- [ ] **Step 5: 提交**

```bash
git add NoteBarApp/App/NoteBarApp.swift NoteBarApp/Views/HomeView.swift NoteBarApp/Views/ReviewView.swift
git commit -m "feat: add home and review screens with flip and four-direction swipe"
```

---

## Task 10：词库浏览与单词详情

**Files:**
- Create: `NoteBarApp/Views/WordListView.swift`、`NoteBarApp/Views/WordDetailView.swift`

- [ ] **Step 1: 词库浏览（三分组 + 编辑入口）**

创建 `NoteBarApp/Views/WordListView.swift`：

```swift
import SwiftUI
import SwiftData

struct WordListView: View {
    var book: String?
    @Environment(\.colorScheme) var scheme
    @Query private var entries: [Entry]
    @State private var grouping = Grouping.date

    enum Grouping: String, CaseIterable {
        case date = "按日期", letter = "按首字母", proficiency = "按熟练度"
    }

    private var filtered: [Entry] {
        guard let book else { return entries }
        return entries.filter { $0.book == book }
    }

    private var sections: [(String, [Entry])] {
        switch grouping {
        case .date:
            let groups = Dictionary(grouping: filtered) { $0.addedDate ?? "无日期" }
            return groups.keys.sorted().reversed().map { ($0, groups[$0]!.sorted { $0.word < $1.word }) }
        case .letter:
            let groups = Dictionary(grouping: filtered) { String($0.word.prefix(1)).uppercased() }
            return groups.keys.sorted().map { ($0, groups[$0]!.sorted { $0.word < $1.word }) }
        case .proficiency:
            let bands = ["未开始", "新学", "巩固", "熟悉", "已掌握"]
            return bands.map { band in
                (band, filtered.filter { proficiency($0) == band }.sorted { $0.word < $1.word })
            }
        }
    }

    var body: some View {
        List {
            Picker("分组", selection: $grouping) {
                ForEach(Grouping.allCases, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)

            ForEach(sections, id: \.0) { section in
                Section(section.0) {
                    ForEach(section.1) { entry in
                        NavigationLink {
                            WordDetailView(entry: entry)
                        } label: {
                            HStack {
                                Text(entry.word).foregroundStyle(Theme.wordColor(scheme))
                                Spacer()
                                Text(proficiency(entry)).font(.caption).foregroundStyle(.secondary)
                                Image(systemName: "square.and.pencil").font(.caption).foregroundStyle(.blue)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(book ?? "全部词库")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func proficiency(_ entry: Entry) -> String {
        guard let s = entry.s else { return "未开始" }
        if entry.lifecycle == "graduated" || entry.status == "mastered" || s >= 30 { return "已掌握" }
        if s < 2 { return "新学" }
        if s < 15 { return "巩固" }
        return "熟悉"
    }
}
```

- [ ] **Step 2: 单词详情（编辑/删除）**

创建 `NoteBarApp/Views/WordDetailView.swift`：

```swift
import SwiftUI
import SwiftData

struct WordDetailView: View {
    let entry: Entry
    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) var scheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @State private var editing = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(entry.word)
                        .font(.largeTitle.bold())
                        .foregroundStyle(Theme.wordColor(scheme))
                    Button { appState.speak(entry.word) } label: { Image(systemName: "speaker.wave.2.fill") }
                }
                Text(entry.definition.isEmpty ? "（无释义）" : entry.definition)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard()

                if let s = entry.s {
                    ProgressView(value: min(s / 30, 1))
                    HStack {
                        Text("记忆稳定度 \(String(format: "%.1f", s))")
                        Spacer()
                        Text("下次 \(entry.dueDate ?? "—")")
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }

                HStack {
                    Button("编辑") { editing = true }
                        .buttonStyle(.bordered)
                    Button("删除", role: .destructive) { delete() }
                        .buttonStyle(.bordered)
                }
            }
            .padding()
        }
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $editing) {
            WordEditSheet(entry: entry)
        }
    }

    private func delete() {
        context.delete(entry)
        try? context.save()
        dismiss()
    }
}

struct WordEditSheet: View {
    let entry: Entry
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @EnvironmentObject var appState: AppState
    @State private var word: String
    @State private var definition: String
    @State private var aliases: String

    init(entry: Entry) {
        self.entry = entry
        _word = State(initialValue: entry.word)
        _definition = State(initialValue: entry.definition)
        _aliases = State(initialValue: entry.aliases.joined(separator: ", "))
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("单词", text: $word)
                TextField("别名（逗号分隔）", text: $aliases)
                TextEditor(text: $definition).frame(minHeight: 140)
            }
            .navigationTitle("编辑单词")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
            }
        }
    }

    private func save() {
        entry.word = word
        entry.definition = definition
        entry.aliases = aliases.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        try? context.save()

        if var canvas = appState.sync.readCanvas(entry.book) {
            let aliases = entry.aliases
            _ = CanvasEditor.updateWord(data: &canvas, nodeId: entry.nodeId, word: entry.word, definition: entry.definition, aliases: aliases)
            appState.sync.writeCanvas(entry.book, data: canvas)
        }
        dismiss()
    }
}
```

- [ ] **Step 3: 构建验证**

Run: `xcodebuild build ...`
Expected: BUILD SUCCEEDED

- [ ] **Step 4: 提交**

```bash
git add NoteBarApp/Views/WordListView.swift NoteBarApp/Views/WordDetailView.swift
git commit -m "feat: add word list groupings and editable detail view"
```

---

## Task 11：统计（日历下钻 + 热力图）

**Files:**
- Create: `NoteBarApp/Views/StatsView.swift`

- [ ] **Step 1: 实现**

创建 `NoteBarApp/Views/StatsView.swift`：

```swift
import SwiftUI
import SwiftData

struct StatsView: View {
    @Query private var entries: [Entry]
    @State private var selectedDay: String?

    private var byDay: [String: [DayRecord]] {
        var map: [String: [DayRecord]] = [:]
        for entry in entries {
            for record in entry.history ?? [] {
                let day = String(record.date.prefix(10))
                map[day, default: []].append(DayRecord(word: entry.word, quality: record.quality))
            }
        }
        return map
    }

    private var streak: Int {
        let days = Set(byDay.keys).sorted()
        var count = 0
        var cursor = FSRS.startOfDay(Date())
        while days.contains(FSRS.dayString(cursor)) {
            count += 1
            cursor = Calendar.current.date(byAdding: .day, value: -1, to: cursor)!
        }
        return count
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        statCard("连续天数", "\(streak)")
                        statCard("今日复习", "\(byDay[FSRS.dayString(Date())]?.count ?? 0)")
                    }
                    CalendarGrid(byDay: byDay, selected: $selectedDay)
                    if let selectedDay {
                        Text("\(selectedDay) · 复习 \(byDay[selectedDay]?.count ?? 0) 词")
                            .font(.headline)
                        ForEach(byDay[selectedDay] ?? [], id: \.self) { record in
                            HStack {
                                Text(record.word)
                                Spacer()
                                Text(qualityLabel(record.quality)).font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(.horizontal)
                        }
                    }
                    Text("近 18 周热力图").font(.headline)
                    Heatmap(byDay: byDay)
                }
                .padding()
            }
            .navigationTitle("统计")
        }
    }

    private func statCard(_ title: String, _ value: String) -> some View {
        VStack {
            Text(value).font(.title.bold())
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .glassCard()
    }

    private func qualityLabel(_ q: String) -> String {
        switch q {
        case "again": return "不认识"
        case "hard": return "模糊"
        case "easy": return "太简单"
        default: return "认识"
        }
    }
}

struct DayRecord: Hashable {
    var word: String
    var quality: String
}

struct CalendarGrid: View {
    let byDay: [String: [DayRecord]]
    @Binding var selected: String?

    var body: some View {
        let weeks = weeksOfCurrentMonth()
        VStack(spacing: 4) {
            HStack { ForEach(["一", "二", "三", "四", "五", "六", "日"], id: \.self) { Text($0).font(.caption2).frame(maxWidth: .infinity) } }
            ForEach(weeks, id: \.self) { week in
                HStack {
                    ForEach(week, id: \.self) { day in
                        if let day {
                            let key = FSRS.dayString(day)
                            let has = (byDay[key]?.count ?? 0) > 0
                            Button {
                                selected = selected == key ? nil : key
                            } label: {
                                Text("\(Calendar.current.component(.day, from: day))")
                                    .frame(maxWidth: .infinity, minHeight: 30)
                                    .background(has ? Color.blue : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                                    .foregroundStyle(has ? .white : .primary)
                            }
                            .buttonStyle(.plain)
                        } else {
                            Color.clear.frame(maxWidth: .infinity, minHeight: 30)
                        }
                    }
                }
            }
        }
        .glassCard()
    }

    private func weeksOfCurrentMonth() -> [[Date?]] {
        let cal = Calendar.current
        let now = Date()
        let range = cal.range(of: .day, in: .month, for: now)!
        let first = cal.date(from: cal.dateComponents([.year, .month], from: now))!
        let weekday = cal.component(.weekday, from: first) // 1=周日
        let leading = (weekday + 5) % 7
        var cells: [Date?] = Array(repeating: nil, count: leading)
        for day in range { cells.append(cal.date(byAdding: .day, value: day - 1, to: first)) }
        while cells.count % 7 != 0 { cells.append(nil) }
        return stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0..<$0 + 7]) }
    }
}

struct Heatmap: View {
    let byDay: [String: [DayRecord]]

    var body: some View {
        let days = last18Weeks()
        let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 18)
        LazyVGrid(columns: columns, spacing: 3) {
            ForEach(days, id: \.self) { day in
                let count = byDay[FSRS.dayString(day)]?.count ?? 0
                RoundedRectangle(cornerRadius: 3)
                    .fill(color(count))
                    .aspectRatio(1, contentMode: .fit)
            }
        }
        .glassCard()
    }

    private func last18Weeks() -> [Date] {
        let cal = Calendar.current
        let today = FSRS.startOfDay(Date())
        let start = cal.date(byAdding: .day, value: -17 * 7, to: today)!
        return (0..<(18 * 7)).map { cal.date(byAdding: .day, value: $0, to: start)! }
    }

    private func color(_ count: Int) -> Color {
        switch count {
        case 0: return Color.gray.opacity(0.12)
        case 1...3: return Color.green.opacity(0.35)
        case 4...9: return Color.green.opacity(0.65)
        default: return Color.green
        }
    }
}
```

- [ ] **Step 2: 构建验证**

Run: `xcodebuild build ...`
Expected: BUILD SUCCEEDED

- [ ] **Step 3: 提交**

```bash
git add NoteBarApp/Views/StatsView.swift
git commit -m "feat: add stats with drill-down calendar and heatmap"
```

---

## Task 12：听写模式

**Files:**
- Create: `NoteBarApp/Views/DictationView.swift`

- [ ] **Step 1: 实现**

创建 `NoteBarApp/Views/DictationView.swift`：

```swift
import SwiftUI
import SwiftData

struct DictationView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) var scheme
    @Query private var all: [Entry]
    @State private var queue: [Entry] = []
    @State private var index = 0
    @State private var input = ""
    @State private var message: String?
    @State private var correctCount = 0

    var body: some View {
        VStack(spacing: 18) {
            if queue.indices.contains(index) {
                let entry = queue[index]
                Text("听写 \(index + 1) / \(queue.count)").font(.caption).foregroundStyle(.secondary)
                Text(entry.definition.isEmpty ? "（无释义）" : entry.definition)
                    .font(.title2)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity, minHeight: 160)
                    .glassCard()
                TextField("拼写英文单词", text: $input)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("🔊 点击音标朗读") { appState.speak(entry.word) }
                    .font(.caption)
                if let message {
                    Text(message).foregroundStyle(message.contains("正确") ? Color.green : Color.red)
                }
                Button("检查") { check(entry) }
                    .buttonStyle(.borderedProminent)
            } else {
                ContentUnavailableView("本轮完成", systemImage: "checkmark.seal", description: Text("正确 \(correctCount) / \(queue.count)"))
            }
        }
        .padding()
        .navigationTitle("听写")
        .onAppear(perform: buildQueue)
    }

    private func buildQueue() {
        let active = all.filter { $0.lifecycle != "retired" && $0.lifecycle != "archived" }
        queue = Array(active.shuffled().prefix(appState.settings.dictationPerSession))
    }

    private func check(_ entry: Entry) {
        let normalized = StudyKey.normalizeText(input)
        let ok = normalized == StudyKey.normalizeText(entry.word)
            || entry.aliases.contains { StudyKey.normalizeText($0) == normalized }
        if ok { correctCount += 1 }
        message = ok ? "正确 ✓" : "正确答案：\(entry.word)"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            input = ""
            message = nil
            index += 1
        }
    }
}
```

- [ ] **Step 2: 首页入口接线**

`HomeView` 的「开始学习」按钮旁新增一个入口按钮：

```swift
NavigationLink {
    DictationView()
} label: {
    Label("听写", systemImage: "pencil.and.list.clipboard")
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Theme.hardGray, in: RoundedRectangle(cornerRadius: 14))
        .foregroundStyle(.white)
}
```

- [ ] **Step 3: 构建验证**

Run: `xcodebuild build ...`
Expected: BUILD SUCCEEDED

- [ ] **Step 4: 提交**

```bash
git add NoteBarApp/Views/DictationView.swift NoteBarApp/Views/HomeView.swift
git commit -m "feat: add dictation mode with phonetic audio"
```

---

## Task 13：设置页与目录授权

**Files:**
- Create: `NoteBarApp/Sync/FolderPicker.swift`、`NoteBarApp/Views/SettingsView.swift`

- [ ] **Step 1: 目录选择器**

创建 `NoteBarApp/Sync/FolderPicker.swift`：

```swift
import SwiftUI
import UniformTypeIdentifiers

struct FolderPicker: UIViewControllerRepresentable {
    var onPick: (URL) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let parent: FolderPicker
        init(_ parent: FolderPicker) { self.parent = parent }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            if let url = urls.first { parent.onPick(url) }
        }
    }
}
```

- [ ] **Step 2: 设置页**

创建 `NoteBarApp/Views/SettingsView.swift`：

```swift
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @State private var showPicker = false

    var body: some View {
        NavigationStack {
            Form {
                Section("iCloud 同步目录") {
                    Button("选择目录") { showPicker = true }
                    Text(appState.syncStatus).font(.caption).foregroundStyle(.secondary)
                    Button("立即同步") {
                        Task { await appState.sync.scan() }
                    }
                }
                Section("外观") {
                    Toggle("暗夜模式", isOn: $appState.settings.forceDarkMode)
                }
                Section("学习") {
                    Toggle("自动朗读单词", isOn: $appState.settings.autoPronounce)
                    Stepper("每日新词上限 \(appState.settings.dailyNewWordLimit)", value: $appState.settings.dailyNewWordLimit, in: 1...200)
                    Stepper("每日复习上限 \(appState.settings.dailyReviewLimit)", value: $appState.settings.dailyReviewLimit, in: 1...500)
                    Stepper("每轮听写 \(appState.settings.dictationPerSession) 词", value: $appState.settings.dictationPerSession, in: 1...100)
                }
                Section("冲突日志") {
                    ForEach(appState.conflicts, id: \.self) { Text($0).font(.caption) }
                }
            }
            .navigationTitle("设置")
            .sheet(isPresented: $showPicker) {
                FolderPicker { url in
                    appState.sync.configure(folder: url)
                    appState.syncStatus = url.lastPathComponent
                    appState.sync.start()
                }
                .ignoresSafeArea()
            }
        }
    }
}
```

- [ ] **Step 3: 构建验证**

Run: `xcodebuild build ...`
Expected: BUILD SUCCEEDED

- [ ] **Step 4: 提交**

```bash
git add NoteBarApp/Sync/FolderPicker.swift NoteBarApp/Views/SettingsView.swift
git commit -m "feat: add settings with folder authorization and toggles"
```

---

## Task 14：端到端联调与 TestFlight 验收

- [ ] **Step 1: 本地跑通闭环**

1. Mac 端先完成插件侧计划 Task 11，确认同步目录已有 `*.canvas` 与 `*.nb-sync.json`。
2. 模拟器运行 App → 设置 → 选择 iCloud 同步目录（模拟器上先 `xcrun simctl` 或 Finder 把目录放到 iCloud Drive 可访问位置）。
3. 首页应显示词数与待复习数；进入复习，翻转、四向滑动、按钮、撤销、发音逐一验证。
4. 评分后检查同步目录边车 `words[key]` 已更新；Mac 插件「立即导入」后 `data.json` 进度一致。

- [ ] **Step 2: 冲突场景**

1. Mac 与手机同时复习同一词 → 合并后取 `lastReview` 较新者。
2. 同步目录人工制造 `words 2.canvas` → App 冲突日志出现提示。
3. 授权失效：`BookmarkStore.clear()` 后重启 App → 引导重新选择目录。

- [ ] **Step 3: 性能**

用 860 词级词库验证首页/词库列表滚动与 `scan()` 耗时（目标 < 2s），必要时把 `scan()` 中 `try? context.save()` 移到批次末尾（已在实现中）。

- [ ] **Step 4: TestFlight**

1. Xcode → Product → Archive → Distribute App → App Store Connect → TestFlight。
2. App Store Connect 添加内部测试员（你本人），下载 TestFlight 版真机安装。
3. 真机上重复 Step 1 的闭环与 Step 2 的冲突用例。

- [ ] **Step 5: 记录验收结果并提交**

```bash
git add -A
git commit -m "docs: record iOS e2e acceptance results"
```

---

## 自检记录

- Spec 覆盖：spec 第 5.3/5.4（同步与文件访问）、6.1–6.9（页面/交互/视觉/音频/Canvas 写回）、8（FSRS/studyKey 一致性）、9（测试）、10（里程碑 M0–M5）均有对应任务。
- 无占位符：所有代码步骤给出完整实现；`AudioPlayer.play` 骨架已显式注明扩展点。
- 类型一致：`StudyProgress`、`SidecarFile`、`Entry.progress`、`FSRS.schedule`、`StudyKey.canvas/build`、`CanvasEditor.addWord` 的签名在任务间一致；评分写回统一走 `appState.sync.persist(book:key:progress:)`。

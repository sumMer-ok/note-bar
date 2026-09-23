# macOS 划词「加入词库」改造方案

> 目标：在 macOS 上使用 WPS 时，选中英文单词或句子即可唤出与 Note Bar「加入词库」一致的交互，词条最终出现在 Obsidian 词库（Canvas）中。
> 前提：目标平台为 macOS；Note Bar 插件既有数据模型与字段不得破坏。

---

## 一、结论先行

1. **WPS 官方加载项路线在 macOS 上不作为主路径**。WPS 官方《加载项概述》明确"目前已针对 Windows/Linux 操作系统进行适配"；社区虽证实 macOS 可以开发并**手动安装**加载项，但"跟 wps 通信的 58890 端口的连接没有建立成功"、官方在线安装不可用，需自行编写安装脚本——属非官方支持路径，随 WPS 版本升级易碎，不作为依赖。
2. **推荐架构是"系统级划词助手 + 收件箱文件"**：macOS 原生助手负责选区捕获与浮窗交互，词条以协议文件交给 Obsidian 侧插件落库。WPS 侧零改造（不依赖它任何扩展能力），对 Word/Pages/浏览器/PDF 同样生效。
3. **插件的落库权必须留在插件侧**：外部进程**不直接写 `.canvas`**，而是写"收件箱"，由插件调用既有的 `addWordToMultipleCanvas()` 完成格式、日期分组、自动排版与缓存刷新。这样"格式唯一权威在插件"，且规避与 Obsidian 编辑器争抢同一文件。

---

## 二、平台事实与依据

### 2.1 已确认

| 事项 | 结论 | 依据 |
| --- | --- | --- |
| WPS 加载项官方平台 | 仅 Windows / Linux | WPS 开放平台《加载项概述》《加载项开发说明》 |
| macOS 加载项现状 | 可开发、可手动安装（社区脚本）；在线安装与 58890 端口通信失败 | WPS 官方论坛《MAC系统安装加载项》 |
| WPS Mac 的跨平台扩展方案 | JSA 宏（JS 宏）为 Mac/Linux 方向的官方兜底 | 知乎《WPS JSA 宏来了》 |
| macOS 划词的技术底座 | 辅助功能 API（AX）读选中文本 + 全局事件监听/热键 + 自绘浮窗，是 Bob、PopClip 等成熟工具的通用做法 | Bob 文档与实现描述 |
| 插件既有同步基础设施 | `SyncManager` = 双向镜像（`Mirrorer`）+ 进度边车（`.nb-sync.json`）+ `fs.watch` + 轮询兜底 + 冲突日志；导入侧已有 `.processed` 归档约定 | `src/sync/` |
| 插件既有落库 API | `vocabularyManager.addWordToMultipleCanvas()` / `reloadVocabularyBook()` / `refreshHighlighter()` | `src/hiwords/core/vocabulary-manager.ts`、`src/main.ts` |
| 词库配置真实形态 | `data.json` 的 `vocabularyBooks`（path/name/enabled）+ `defaultVocabularyBookPaths`；正式 vault 已有 4 个词库 | `~/Documents/Library/.obsidian/plugins/note-bar/data.json` |
| 离线词典位置 | vault 内 `.obsidian/plugins/note-bar/data/dictionary.json`（中文词典）与 `legal-dictionary.json` | 项目约定与 vault 实体文件 |

### 2.2 待验证（决定方案分支，须先做）

1. **WPS for Mac 的文字窗口是否暴露 `AXSelectedText`**（关键未知项）。若暴露 → 主路径成立；若不暴露 → 走 5.3 的 ⌘C 兜底或 JSA 宏取词。
2. WPS Mac 的 JSA 宏可用性：开发工具/JS 宏入口是否存在、能否发起 HTTP 请求、宏的分发与信任方式。
3. macOS TCC 对助手访问 `~/Documents/**`（vault 与 `~/Documents/Library`）的授权表现：首次访问是否弹窗、是否需要"完全磁盘访问"。
4. iOS 端与助手是否可能同时写同一 `syncDir`（影响收件箱文件的命名与归档策略）。

---

## 三、总体架构

三层次，单向数据流：

```
[选区捕获层]  AX 读取选中文本 + 所在句
      ↓（内存）
[交互层]      NSPanel 浮窗（WKWebView 载入与 Note Bar 同源的表单片段）
      ↓（落盘：追加一条 JSON 记录）
[收件箱]      note-bar-inbox.jsonl（默认置于 mobileSync.syncDir）
      ↓（插件监听/轮询）
[落库层]      InboxImporter → addWordToMultipleCanvas() → Canvas（日期分组+排版）→ 刷新高亮与侧边栏
```

要点：

- 助手与 WPS **无耦合**：不注入、不模拟键鼠、不依赖加载项，因此不受 WPS 版本差异影响（除 2.2 第 1 项这一读取能力前提）。
- 收件箱是**追加式、可重放、可幂等**的协议文件，不参与 Canvas 的 mtime 竞争。
- 既有 `Mirrorer` 的双向镜像继续负责 Canvas 本身；收件箱只负责"加词意图"，两者互不干扰。

---

## 四、关键决策与备选对比

### 4.1 选区捕获路径

| 路径 | 成熟度 | 限制 | 定位 |
| --- | --- | --- | --- |
| A. AX API 读 `AXSelectedText` | 高（Bob/PopClip 等长期验证） | 需辅助功能授权；WPS Mac 是否暴露该属性**待验证** | **主路径** |
| B. JSA 宏在 WPS 内取词后 POST 给助手 | 中（Mac 上为官方跨平台方向） | 需用户手动装宏与信任；UI 能力弱；能力边界待验证 | **兜底**（A 失效时） |
| C. 模拟 ⌘C + 读剪贴板 | 中 | 会污染用户剪贴板、需合成按键权限、有副作用 | **最后兜底** |
| D. 只做全局热键显式取词 | 高 | 牺牲"选中即弹" | 降级形态 |

### 4.2 弹窗承载

| 方案 | 一致性 | 说明 |
| --- | --- | --- |
| NSPanel + WKWebView（推荐） | 最高 | 浮窗内载入与 Note Bar 同源的 HTML/CSS（复用 `styles.css` 中 add-word 相关类名），字段与视觉可对齐；可锚定鼠标/选区位置 |
| 原生 SwiftUI 表单 | 中 | 无 Web 依赖、体积小，但样式需重新实现，容易走样 |
| WPS 加载项 ShowDialog / 任务窗格 | 低 | 依赖非官方安装路径，且对话框位置由宿主控制、无法锚定选区 |

### 4.3 落库通道

| 通道 | 改造量 | 风险 | 结论 |
| --- | --- | --- | --- |
| 直接写 `syncDir` 里的 Canvas 副本，靠 `Mirrorer` mtime 回流 | 最小（可零改造） | **最后写入者胜**：Obsidian 正在编辑该 Canvas 时可能丢改动；外部需自行实现节点格式与排版否则重叠 | 不采用（仅作应急验证手段） |
| **收件箱文件 + 插件消费（推荐）** | 中（插件新增一个 importer） | 需设计幂等与失败重试；延迟 = 轮询间隔 | **采用** |
| 助手直接写 vault 内 Canvas | 大 | 直接与 Obsidian 抢文件，冲突面最大 | 不采用 |

---

## 五、Obsidian 侧改造清单（本方案的主要工作量）

### 5.1 新增文件

- `src/sync/inbox-types.ts`：收件箱条目与文件格式定义（纯类型 + 版本号，与 `sync/types.ts` 同风格）。
- `src/sync/inbox-importer.ts`：读取收件箱、逐条落库、归档已处理条目、汇总失败原因。
- 可选 `src/hiwords/ui/inbox-review-modal.ts`：若采用"人工确认"模式，复用 `AddWordModal` 的渲染逻辑做批量确认。

### 5.2 修改文件

- `src/sync/sync-manager.ts`：在 `start()` 中挂接收件箱监听（复用同一 `syncDir` 的 `fs.watch` + 轮询兜底），新增 `importInbox()`；`stop()` 中清理。
- `src/main.ts`：注册命令 `Note Bar: 导入跨应用词条`（手动兜底触发）；新增设置项（收件箱开关、收件箱路径、重名策略）；在插件卸载/停用时归档未处理条目。
- `src/hiwords/utils/types.ts`：仅在 `HiWordsSettings` 下新增**独立子对象** `crossAppInbox`（enabled / path / duplicatePolicy / requireConfirm），**不改动** `vocabularyBooks`、`studyProgress`、`WordDefinition` 等既有结构。
- `samples/`（可选）：提供一份收件箱样例文件，便于助手侧联调与回归。

### 5.3 数据契约（收件箱条目）

一行一条 JSON（JSONL 追加写），字段与插件侧字段同义：

```json
{
  "v": 1,
  "id": "uuid-每条唯一，用于幂等",
  "createdAt": "ISO8601",
  "source": "wps-macos",
  "word": "consideration",
  "sentence": "For valuable consideration...",
  "definition": "n. 对价；考虑",
  "aliases": ["considerations"],
  "color": "4",
  "books": ["Words/Common Law.canvas"],
  "origin": { "app": "WPS Office", "file": "/Users/.../contract.docx" }
}
```

约定：

- `books` 缺省时由插件回落到 `defaultVocabularyBookPaths`；两条都空则该条判为失败并保留在收件箱。
- `definition` 为空时由插件用本地词典补全（复用 `LocalDictionaryService`），保证与插件内自动填充结果一致。
- `aliases` 由插件侧统一小写规范化（与 `AddWordModal` 提交路径一致），助手不做规范化，避免两处规则漂移。
- 版本号 `v` 不匹配时整条跳过并记日志，不尝试猜测式解析。

### 5.4 幂等、去重与失败处理

- **幂等键**：`id`；插件维护一个已处理 id 的环形集合（可用设置内的有限数组或 `.processed` 行数游标），重复 `id` 直接跳过。
- **内容去重**：目标 Canvas 中已存在同词（或同别名，遵循 `vocabularyManager` 已有的 `aliases.includes()` 判定逻辑）时，按 `duplicatePolicy` 处理：`skip`（默认，Notice 提示）/ `update`（改写释义，走 `updateWordInCanvas`）。
- **顺序**：严格按文件行序处理，保证"添加顺序 = 用户操作顺序"。
- **失败**：单条失败不影响后续条目；失败条目写入 `note-bar-inbox.failed.jsonl` 并 Notice，原文件保留未处理部分。
- **中断与恢复**：处理完的行整体归档为 `.processed`（沿用 `sync-importer.ts` 既有归档约定），进程中断后重启只读未归档部分，不重复落库（配合 `id` 幂等双保险）。
- **半行 JSON**：跳过错行并保留原文件，等待下一轮读取（助手为追加写，正常不会产生半行，但需容错）。

---

## 六、macOS 助手侧设计

### 6.1 能力清单

- 常驻菜单栏 App（无 Dock 图标），开机自启可选。
- 全局热键（主触发，建议 ⇧⌘D 一类不与系统冲突的组合）+ 可选的"鼠标抬起后 AX 轮询"实现选中即弹。
- AX 读取当前前台应用选区：文本、所属窗口、粗略坐标（用于浮窗定位）。
- 浮窗：NSPanel（`nonactivatingPanel` + 无边框 + 失焦自动关闭）；内容为 WKWebView，载入与 Note Bar 同源的表单片段。
- 配置：vault 路径、收件箱路径、目标词库多选（从 `data.json` 的 `vocabularyBooks` 读取，只在助手内缓存展示，**不写 data.json**）、热键、是否显示释义。
- 释义可选两种来源：读 vault 内 `dictionary.json`（离线、与插件一致）；或调 AI 接口（需用户自配 key，MVP 可不做）。

### 6.2 权限与系统边界

- **辅助功能**：读选区必需；未授权时明确引导到"系统设置 → 隐私与安全性 → 辅助功能"，不静默失效。
- **输入监控**：仅当采用 CGEventTap 监听鼠标抬起时才需要。
- **文件访问**：写收件箱目录；vault 在 `~/Documents` 下时受 TCC 保护，首次写入可能触发授权（待验证具体表现）。
- **Gatekeeper**：自用需 ad-hoc 签名或开发者签名，否则首次运行被拦截。
- **不做的事**：不注入 WPS 进程、不修改 WPS 文件、不模拟键鼠（除 4.1-C 兜底路径外）、不写 Obsidian 的 `data.json`。

### 6.3 与"交互一致"的界定

- 可做到一致：**字段集合**（单词 / 例句 / 目标单词本多选 / 卡片颜色 / 别名 / 释义）、**提交流程**（校验 → 写入 → 成功提示）、**文案与配色**（复用 `styles.css` 相关类名）。
- 不可做到一致：宿主窗口层级带来的观感差异、Obsidian 侧 `AddWordModal` 的"编辑既有词条"分支（助手只做新增）、同类多选下拉与 Canvas 卡片色的原生控件细节。
- 结论：以"同一套 HTML/CSS 片段 + 同一字段与校验规则"作为一致性的验收口径，而非像素级一致。

---

## 七、WPS 侧改造

- **主路径：零改造**。助手在系统层工作，WPS 无需安装任何东西，也不受其版本与个人版限制影响。
- **可选兜底（仅在 2.2 第 1 项验证失败时启用）**：使用 JSA 宏在 WPS 内取词，只做"读取 Selection → 发一条 HTTP 请求给助手的本地端口"这一件事；UI 仍由助手浮窗渲染，从而保持交互一致。触发方式为 Ribbon 按钮或快捷键，而非"选中即弹"（宏能否监听选区变化待验证）。

---

## 八、边界处理

| 场景 | 期望行为 |
| --- | --- |
| 正向：选中英文单词 → 提交 | 助手追加一条记录；插件在轮询周期内落库，Canvas 出现带日期分组的节点，正文高亮与侧边栏即时刷新 |
| 未选中 / 选中空白 / 纯中文 | 浮窗不出现或提示"未识别到英文"，不产生记录 |
| 整段英文 | 助手按"单词字段取首词或整段"策略规范化，与插件 `inferLearningItemType` 的 word/phrase 判定保持同口径 |
| 重复提交同一词 | 按 `duplicatePolicy` 跳过或更新；两种策略都不产生重复节点 |
| 目标词库不存在 / 被改名 / 被禁用 | 该条判失败 → `.failed.jsonl` + Notice，不静默丢弃 |
| Obsidian 未运行 | 条目留在收件箱，Obsidian 启动后补处理（不丢、不重复） |
| 收件箱含坏行 | 跳过坏行并保留原文件，其余条目正常处理 |
| 与 iOS 端 / Mirrorer 并发 | 收件箱不触碰 Canvas 文件，不产生冲突副本 |
| 处理中插件被停用 | 已归档部分生效，未归档部分下次启动继续 |
| 辅助功能授权被撤销 | 助手明确提示并停止取词，不产生空记录 |

---

## 九、验收用例清单

1. 在 WPS 文字中选中英文单词，热键唤出浮窗，位置贴近选区；按 ESC 关闭后收件箱无新增。
2. 浮窗提交后 ≤ 1 个轮询周期，目标 Canvas 出现词条；节点位于当天 `YYYY-MM-DD` 分组内且排版不重叠。
3. 提交后无需重载插件，正文高亮与生词本侧边栏立即包含该词。
4. 同一词连续提交两次，按策略得到"提示跳过"或"释义被更新"之一，节点数不增加。
5. 未选中文本时触发热键：明确提示且不写收件箱。
6. 关闭 Obsidian 后提交 3 条，重新打开 Obsidian，3 条全部落库且无重复。
7. 手工在收件箱中插入一行坏 JSON，处理后其余条目正常，坏行仍在原文件。
8. 向一个不存在的词库路径提交：产生失败记录与 Notice；插件无异常抛出、其余词库不受影响。
9. 助手未获辅助功能授权时：提示授权引导，取词禁用，浮窗不出现。
10. 回归：iOS 边车同步与 `Mirrorer` 行为不变，未产生额外冲突副本；`data.json` 除新增 `crossAppInbox` 外无字段变化。

---

## 十、风险与待验证清单

**风险**

- **AX 不可读**（最致命）：WPS Mac 若为自绘界面且不实现 AX 文本属性，主路径失效 → 需切 JSA 兜底或 ⌘C 兜底，交互从"选中即弹"降级为"热键取词"。
- **权限体验**：辅助功能授权、Documents 目录 TCC 授权、Gatekeeper，任一处被拒都会让助手"静默不工作"，必须做显式引导。
- **释义不一致**：助手若走在线 AI 而插件用本地词典，同词两处释义不同 → 默认只读 vault 内 `dictionary.json`。
- **别名/学习键漂移**：`studyKey` 由单词与别名派生，助手与服务端若各自规范化会产生对不上的进度键 → 规范化只在插件侧做一次。
- **收件箱与 iOS 端共用目录**：需确认文件名不与 `.nb-sync.json` 规则冲突（命名上带独立前缀即可）。
- **无签名分发**：自用可接受，若给他人用需签名与公证。

**待验证（按优先级）**

1. WPS for Mac 是否暴露 `AXSelectedText`（用 Accessibility Inspector 实测，预计 30 分钟内可判定）。
2. 外部追加写收件箱 → 插件监听到落库的端到端时延（取决于 `pollIntervalSec`，默认 15 秒，必要时为收件箱单独缩短）。
3. WPS Mac 的 JSA 宏可用性与 HTTP 能力（兜底路径可行性）。
4. `~/Documents` 下 vault 的 TCC 授权表现。
5. 收件箱路径选择：`mobileSync.syncDir`（复用既有监听与 iOS 一致，但要求该目录已配置）vs vault 内 `.obsidian/plugins/note-bar/inbox.jsonl`（不依赖 iCloud，权限面更小）——**需你拍板**，方案默认前者。

---

## 十一、分阶段实施

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| P0 验证（半天） | ① Accessibility Inspector 判定 WPS Mac 可读性；② 手工写收件箱条目，验证插件侧能否落库（先写最小 importer） | 两条链路各自跑通，得出主路径结论 |
| P1 插件侧 | `inbox-importer.ts` + 类型 + 设置项 + 命令 + 幂等/失败/归档 | 第九节用例 4–8、10 通过 |
| P2 助手 MVP | 菜单栏 App：热键取词 + AX 读取 + NSPanel 浮窗 + 写收件箱（表单字段与 Note Bar 对齐） | 用例 1–3、9 通过 |
| P3 增强 | 本地词典释义、配置界面（词库多选/热键）、可选"选中即弹"轮询、必要时 JSA 兜底宏 | 用例 5 与全量回归通过 |

**实施状态**

- P0（收件箱链路）：未执行（需人工）。端到端验收需在测试 vault 中重载插件并观测 Canvas 落库，尚未执行，验收记录文件 `documents/p0-验收记录-跨应用加词.md` 尚未创建。
- P0（WPS AX 可读性探针）：未执行（需人工）。判定需在 macOS 上用 Accessibility Inspector 实测 WPS for Mac 选区属性，尚未执行。
- P1（插件侧收件箱）：已完成。`inbox-types.ts` / `inbox-store.ts` / `inbox-importer.ts` / `inbox-vocabulary-adapter.ts` 四个模块与单测落地，`SyncManager` 已接监听与消费，`crossAppInbox` 设置项与 `Note Bar: 导入跨应用词条` 命令已注册；`npm test` 47 项通过，`npx tsc -noEmit -skipLibCheck` 与 `npm run build` 通过。
- P2（macOS 助手）：等待 P0 探针结论后另立计划。

**不做（non-goals）**

- 不改造 WPS（不写加载项、不注入进程、不改 WPS 文件）。
- 不设计双向同步：WPS 侧只做"新增词条"，编辑与删除仍只在 Obsidian 内进行（避免与 iOS 边车、Mirrorer 三方竞争）。
- 不追求像素级还原 Obsidian 弹窗，只保证字段、校验与文案口径一致。

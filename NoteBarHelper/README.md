# NoteBar Helper（macOS 划词助手）

在任意 macOS 应用（首要 WPS for Mac）里选中英文，按全局热键弹出与 Note Bar「加入词库」一致的浮窗；
提交后助手指把词条**追加**写入 Note Bar 的收件箱协议文件，由 Obsidian 插件自动落库到 Canvas。

助手**绝不**写 vault：不写 `.canvas`、不写 `data.json`（只读）、不写 `.obsidian/**`。
唯一写入是向收件箱目录追加 `note-bar-inbox.jsonl`。

## 首次运行三步

### ① 填写 vault 路径与取词快捷键

菜单栏点 `NB` → 「设置…」：

| 项 | 说明 |
| --- | --- |
| 取词快捷键 | 点「录制」后按下组合键（至少一个修饰键 cmd/alt/ctrl/shift + 一个字母、数字或符号），Esc 取消录制。保存后**立即重注册**，不用重启 App。 |
| vault 路径 | Obsidian vault 根目录（助手只读其中的 `.obsidian/plugins/note-bar/data.json` 与它指向的词典 JSON）。 |
| 收件箱目录覆盖 | 可留空；留空时用 vault 里 `crossAppInbox.syncDir`（为空再回落 `mobileSync.syncDir`）。 |

保存会写回 `~/Library/Application Support/NoteBarHelper/config.json`，窗口底部会给出保存结果；
热键被别的应用占用导致注册失败时也会在窗口里明说（此时仍可用菜单栏「取词」）。

也可以直接手改该文件：

```json
{
  "vaultPath": "/Users/<你>/Documents/Obisidian-test-value",
  "hotkey": "alt+shift+d"
}
```

- `hotkey`：形如 `alt+shift+d` / `cmd+shift+d`；字母、数字（0-9）与 `- = [ ] ; ' , . / \` 都可用。
- 若该目录不存在，`mkdir -p "$HOME/Library/Application Support/NoteBarHelper"` 后再建文件。

### ② 授予「辅助功能」权限

系统设置 → 隐私与安全性 → 辅助功能 → 勾选 `NoteBarHelper`。

- 第一级取词（读 `AXSelectedText`）与第二级兜底（合成 ⌘C 读剪贴板）**都依赖它**：
  未授权时合成的 ⌘C 会被系统直接丢弃，症状就是「按热键毫无反应」。
- 不会静默失效：会响提示音、自动打开辅助功能设置页并弹出说明，日志也会写清原因。
- **重新打包后授权会失效**（ad-hoc 签名的代码要求含 CDHash，二进制一变就匹配不上）。
  修复：到列表里把 NoteBarHelper 取消勾选、再重新勾选；若仍不行，用「−」移除后把 `.app` 拖回列表。
- 想免掉反复授权：建一个自签代码签名证书（钥匙串访问 → 证书助理 → 创建证书，
  类型选「代码签名」，名称如 `NoteBarHelper Dev`），之后用
  `NOTEBAR_SIGN_ID="NoteBarHelper Dev" NoteBarHelper/scripts/package.sh` 打包，授权即可跨构建保持。

### ③ 重载配置

菜单栏点 `NB` → 「重载 vault 配置」；日志应打印 `已载入 N 个词库，收件箱=<路径>`。

**平时不需要手点它**：助手会在**每次打开浮窗前**自动重读一遍 vault 的 `data.json`，
所以在不重启助手的情况下新增/重命名/停用词库，下一次按热键打开浮窗就是最新的词库列表
（读盘失败时沿用上一次的快照并写日志，不会因此打不开浮窗）。

## 浮窗里的两处自动填充

浮窗字段与插件「加入词库」弹窗一致，另有两处自动填充（都**只读** vault，绝不写）：

- **本地词典预填**：打开浮窗后按 `data.json` 的 `chineseDictionary`（启用时）查该词，
  别名 = `a` 逗号连接，释义 = 音标一行 + `d` 每行一条（与插件 AddWordModal 的格式一致）。
  只填**还空着**的字段，不覆盖你已经改过的内容。
  查词典在后台线程流式进行：真实 vault 的 `dictionary.json` 实测 363MB（整文件解析会吃掉几个 GB），
  助手按块扫描只解析命中的那一个词条（实测约 2.4s，且不阻塞浮窗出现）。
  词典未启用 / 文件缺失 / 查不到词都**静默跳过**，原因写在日志里。
- **AI 释义**：释义框右上角的「AI 释义」按钮，按 `data.json` 的 `aiService` + `aiDefinition` 请求
  `${apiUrl}/chat/completions`（OpenAI 兼容，Bearer apiKey，`extraParams` 能解析就合并进请求体）。
  模型返回的 `{"aliases": [...], "definition": "..."}`（可能被 ```json 代码块包住）会被解析后回填到面板。
  失败（未配置 Key / 已关闭 AI 释义 / 网络 / 鉴权 / 解析）会在面板上显示一行错误，
  同时写入日志；**日志里绝不写 apiKey**。

## 排障

先看日志：菜单栏 `NB` → 「打开日志文件」，或
`cat "$HOME/Library/Application Support/NoteBarHelper/helper.log"`。

| 症状 | 含义与处理 |
| --- | --- |
| 按热键毫无反应 | 多半是辅助功能授权失效（重打包后常见）。日志写「没有辅助功能授权」；按提示取消勾选再重新勾选 |
| 改了快捷键没生效 | 到设置窗口看保存提示；日志会写「全局热键已注册：xxx」或「热键注册失败」。可能被其他应用占用 |
| 响一声但没有浮窗 | 取词失败：目标应用当时没有选中文本，或选区不在前台窗口 |
| 浮窗空白、看不到单词 | 表单初始化失败，日志会写 `nbhInit 执行失败` |
| 浮窗没有本地词典预填 | 日志写「本地词典预填跳过：…」并给出原因（词典未启用/文件缺失/没这个词） |
| 点「AI 释义」只看到一行错误 | 面板上的错误文案即原因；日志有更完整的记录（不会含 apiKey） |
| 浮窗里没有词库复选框 | vault 里没有「已启用且以 `.canvas` 结尾」的词库，检查 `data.json` 的 `vocabularyBooks` |
| 浮窗里少列了刚新增的词库 | 不该再出现：每次打开浮窗都会重读 `data.json`。若仍发生，看日志是否写了「刷新 vault 配置失败，沿用上一次的快照」 |
| 提交后 Obsidian 没落库 | 先 `cat <收件箱目录>/note-bar-inbox.jsonl`：有那行 JSON 是插件侧消费问题，没有则是助手写入问题 |

## 打包与运行

```bash
NoteBarHelper/scripts/package.sh      # 产出 NoteBarHelper/dist/NoteBarHelper.app（ad-hoc 签名）
open NoteBarHelper/dist/NoteBarHelper.app
```

`LSUIElement=true`：只在菜单栏常驻，无 Dock 图标。

## 开发

```bash
cd NoteBarHelper
swift build
swift test
```

- 零第三方依赖，仅用系统框架（AppKit / WebKit / ApplicationServices / Carbon / CoreGraphics）。
- 取词三层策略：AX 读选区 → 合成 ⌘C 读剪贴板（成功后恢复用户原剪贴板）→ 预留 JSA 宏上报位点
  （追加一个 `TextAcquirer` 即可接入）。
- 可测试的纯逻辑都单独成文件并配 XCTest：`Config/DictionaryPrefill.swift`（词典条目 → 表单字段）、
  `Config/JSONValue.swift`（深合并，与插件 `deepMerge` 同语义）、`AI/AIDefinition.swift`
  （提示词渲染、请求体拼装、模型回复解析）、`Hotkey/HotkeySpec.swift`（spec 生成与展示）。
- 真实大词典的回归（默认跳过，只在给路径时运行）：

  ```bash
  NOTEBAR_TEST_DICTIONARY="$HOME/Documents/Obisidian-test-value/.obsidian/plugins/note-bar/data/dictionary.json" \
  NOTEBAR_TEST_WORD=consideration swift test --filter testRealDictionary
  ```

- 浮窗表单（`Resources/form.html`）的 JS + 样式冒烟检查（用最小 DOM 桩，不需要开窗口）：

  ```bash
  node scripts/check-form-js.mjs Sources/NoteBarHelper/Resources/form.html
  ```

  它除了验证 `nbhInit`/`nbhFill`/`nbhFillAI`/submit 载荷形状，还会守住两条现场踩过的坑：
  「全局 `width:100%` 不得命中裸 `input`」（否则复选框被拉成整行宽、词库名被挤成竖排一列一个字）
  与「`.books label` 必须 `inline-flex` + `nowrap`」。

- 跨语言协议由 `Tests/Fixtures/inbox-sample.jsonl` 保证：先跑 `swift test` 生成样本，
  再在仓库根跑 `npm test`（`tests/sync/inbox-helper-contract.test.ts` 用插件侧 `parseInboxLine` 解析该样本）。

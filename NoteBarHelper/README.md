# NoteBar Helper（macOS 划词助手）

在任意 macOS 应用（首要 WPS for Mac）里选中英文，按全局热键弹出与 Note Bar「加入词库」一致的浮窗；
提交后助手指把词条**追加**写入 Note Bar 的收件箱协议文件，由 Obsidian 插件自动落库到 Canvas。

助手**绝不**写 vault：不写 `.canvas`、不写 `data.json`（只读）、不写 `.obsidian/**`。
唯一写入是向收件箱目录追加 `note-bar-inbox.jsonl`。

## 首次运行三步

### ① 填写 vault 路径

编辑 `~/Library/Application Support/NoteBarHelper/config.json`：

```json
{
  "vaultPath": "/Users/<你>/Documents/Obisidian-test-value",
  "hotkey": "alt+shift+d"
}
```

- `vaultPath`：Obsidian vault 根目录（助手只读其中的 `.obsidian/plugins/note-bar/data.json`）。
- `hotkey`：全局热键，形如 `alt+shift+d` / `cmd+shift+d`（修饰键支持 cmd/alt/ctrl/shift）。
- `inboxDirOverride`：可选；留空时使用 vault 里 `crossAppInbox.syncDir`（为空则回落 `mobileSync.syncDir`）。

若该目录不存在，`mkdir -p "$HOME/Library/Application Support/NoteBarHelper"` 后再建文件。

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

## 排障

先看日志：菜单栏 `NB` → 「打开日志文件」，或
`cat "$HOME/Library/Application Support/NoteBarHelper/helper.log"`。

| 症状 | 含义与处理 |
| --- | --- |
| 按热键毫无反应 | 多半是辅助功能授权失效（重打包后常见）。日志写「没有辅助功能授权」；按提示取消勾选再重新勾选 |
| 响一声但没有浮窗 | 取词失败：目标应用当时没有选中文本，或选区不在前台窗口 |
| 浮窗空白、看不到单词 | 表单初始化失败，日志会写 `nbhInit 执行失败` |
| 浮窗里没有词库复选框 | vault 里没有「已启用且以 `.canvas` 结尾」的词库，检查 `data.json` 的 `vocabularyBooks` |
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
- 跨语言协议由 `Tests/Fixtures/inbox-sample.jsonl` 保证：先跑 `swift test` 生成样本，
  再在仓库根跑 `npm test`（`tests/sync/inbox-helper-contract.test.ts` 用插件侧 `parseInboxLine` 解析该样本）。

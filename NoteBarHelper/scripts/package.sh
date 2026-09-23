#!/usr/bin/env bash
# 打包 NoteBarHelper.app（ad-hoc 签名；仅供本机自用）
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release

APP="dist/NoteBarHelper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/NoteBarHelper "$APP/Contents/MacOS/NoteBarHelper"
cp Resources/Info.plist "$APP/Contents/Info.plist"

# SwiftPM 资源包（form.html）随可执行文件一起放在 Resources
# 注意：.build/release 是指向 arm64-apple-macosx/release 的符号链接，
# BSD find 不会进入符号链接起点，必须带结尾斜杠；否则这里静默取不到 bundle，
# 打出一个缺 form.html 的 .app（浮窗会是空白页）。
BUNDLE="$(find .build/release/ -maxdepth 1 -name '*.bundle' | head -1 || true)"
if [ -z "${BUNDLE:-}" ]; then
  echo "错误：未找到 SwiftPM 资源包（form.html），打出的 .app 将无法显示表单" >&2
  exit 1
fi
cp -R "$BUNDLE" "$APP/Contents/Resources/"

# 签名：优先用稳定的签名身份（TCC 授权可跨构建保持），否则退回 ad-hoc。
# 为什么要紧：ad-hoc 签名的 designated requirement 里含 CDHash，每次重新打包都会变，
# 系统里的「辅助功能」授权随即失效 —— 症状就是按热键毫无反应（AX 读不到、合成 ⌘C 被丢弃）。
SIGN_ID="${NOTEBAR_SIGN_ID:-}"
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(.*\)".*/\1/p' | head -1 || true)"
fi

if [ -n "${SIGN_ID:-}" ] && codesign --force --deep --sign "$SIGN_ID" "$APP" 2>/dev/null; then
  echo "签名身份：$SIGN_ID（辅助功能授权可跨构建保持）"
else
  codesign --force --deep --sign - "$APP"
  echo "⚠️  使用 ad-hoc 签名：每次重新打包都会让「辅助功能」授权失效，"
  echo "    需要在 系统设置 → 隐私与安全性 → 辅助功能 里取消勾选再重新勾选 NoteBarHelper。"
  echo "    想免掉这一步：用「钥匙串访问 → 证书助理 → 创建证书」建一个代码签名证书（名称如 NoteBarHelper Dev），然后："
  echo "      NOTEBAR_SIGN_ID=\"NoteBarHelper Dev\" ./scripts/package.sh"
fi
echo "已生成 $APP"
echo "首次运行：open $APP   然后到 系统设置 → 隐私与安全性 → 辅助功能 里勾选 NoteBarHelper"

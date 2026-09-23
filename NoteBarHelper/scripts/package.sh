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

codesign --force --deep --sign - "$APP"
echo "已生成 $APP"
echo "首次运行：open $APP   然后到 系统设置 → 隐私与安全性 → 辅助功能 里勾选 NoteBarHelper"

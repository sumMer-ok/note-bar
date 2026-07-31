# Note Bar

Obsidian 社区插件 — 飞书风格浮动格式工具栏 + HiWords 生词本系统。

## 功能

### 浮动格式工具栏

选中文本时弹出格式化工具栏，支持：

- **文本样式**：标题（H1–H6）、正文
- **对齐**：左对齐、居中、右对齐
- **格式**：加粗、斜体、删除线、高亮颜色
- **快捷操作**：复制（文件路径:选中文本）、注释、翻译、加入词库

### HiWords 生词本

- 以 Obsidian Canvas 文件作为单词本存储
- 在 Markdown / PDF 中自动高亮生词本中的单词
- 悬停查看释义、发音，标记掌握状态
- AI 自动释义 + 本地离线英汉词典自动填充
- 右侧生词本侧边栏，按文档/学习中/已掌握展示
- Canvas 单词本导出为 CSV

### 闪卡复习

- 基于 SM-2 间隔重复算法
- 英→中 / 中→英 两种模式
- 单词发音（有道云 TTS）
- 拼写检查
- 键盘快捷键：`Space` 翻转 / `s` 不认识 / `d` 模糊 / `f` 认识
- 3D 翻转 + 滑动切换动画

## 安装

### 从社区插件市场

1. 打开 Obsidian → 设置 → 社区插件
2. 搜索 "Note Bar"
3. 安装并启用

### 手动安装

```bash
# 克隆到 Obsidian 插件目录
cd <vault>/.obsidian/plugins
git clone https://github.com/sumMer-ok/note-bar.git note-bar
cd note-bar
npm install
npm run build
```

## 开发

```bash
git clone https://github.com/sumMer-ok/note-bar.git
cd note-bar
npm install

# 开发模式（watch）
npm run dev

# 生产构建
npm run build

# 构建离线词典（需先放置 AutoCompleteData.db 到 src/hiwords/data/）
npm run build:dictionary
```

> **注意**：`src/hiwords/data/` 目录被 `.gitignore` 忽略，新克隆后需先执行 `npm run build:dictionary` 生成离线词典，否则构建会因缺少 `dictionary.json` 失败。

## 使用

### 浮动工具栏

在编辑器中选中文本，工具栏会自动弹出。

### 生词本

1. 在设置中启用 Canvas 单词本
2. 阅读时生词会高亮显示
3. 使用 `Ctrl/Cmd + P` → "Note Bar: 开始闪卡复习" 打开复习

### 闪卡复习

- 通过命令面板或侧边栏「今日待复习」入口打开
- 选择要复习的单词本
- 使用键盘或按钮进行复习

## 许可证

MIT

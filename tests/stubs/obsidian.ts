/**
 * node:test 运行时的最小 obsidian 替身。
 *
 * 生产构建把 `obsidian` 标为 external（真实 API 由宿主注入）；测试运行时没有宿主，
 * 因此 scripts/build-tests.mjs 用 esbuild 的 alias 把 `obsidian` 指向本文件。
 *
 * 只提供被测试模块**真正用到**的运行时符号，不要在这里塞进 UI / 工作区模拟：
 * 一旦某个模块需要更多符号，说明它不该被拉进单测（边界规则见 tests/sync/inbox-canvas-integration.test.ts）。
 */

/** 真实 API 里 vault 文件的载体；测试只用得到 path / name / extension / basename */
export class TFile {
  path: string;
  name: string;
  extension: string;
  basename: string;
  parent: null = null;

  constructor(path: string) {
    const clean = String(path);
    const fileName = clean.split("/").pop() || clean;
    const dot = fileName.lastIndexOf(".");
    this.path = clean;
    this.name = fileName;
    this.extension = dot > 0 ? fileName.slice(dot + 1) : "";
    this.basename = dot > 0 ? fileName.slice(0, dot) : fileName;
  }
}

export class TAbstractFile {
  path = "";
  name = "";
}

/** 仅作为类型出现在被测模块里的基类，运行时给个空实现即可 */
export class App {}

export class Notice {
  constructor(
    public message?: unknown,
    public timeout?: number
  ) {}
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
};

/** 桌面端等价于 window；测试里由 node 全局提供 */
export const activeWindow = globalThis as unknown as Window;

/** 与真实实现保持一致的路径规范化：统一分隔符、去 ./- 前缀与尾部斜杠 */
export function normalizePath(inputPath: string): string {
  return String(inputPath)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

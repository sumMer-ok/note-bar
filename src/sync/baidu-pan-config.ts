/**
 * 百度网盘同步的配置默认值与向后兼容补齐（纯函数）。
 *
 * 只允许 `import type`：本模块必须能在 node:test 环境下直接运行，
 * 任何运行时的 obsidian 依赖（含间接）都会让 `require("obsidian")` 失败。
 *
 * 「只增不改」的落地方式与 `definitionSectionOrder` 一致：
 * 旧 data.json 缺 `baiduPan`（或其中某几个字段）时补齐成一份完整合法的配置；
 * 调用方只有在返回值 `changed === true` 时才写回 data.json，避免每次启动都刷盘。
 * 已有字段一律不改写——只填空缺/非法值。
 */
import type { BaiduPanSettings, HiWordsSettings } from "../hiwords/utils/types";

/** 网盘沙箱内默认目录名：实际路径为 `/apps/<dir>/Words/` */
export const DEFAULT_BAIDU_PAN_DIR = "NoteBar";

/** 网盘内词库与边车的子目录（相对应用沙箱根） */
export const BAIDU_PAN_WORDS_SUBDIR = "Words";

/** access_token 有效期（秒）；百度网盘文档为 30 天，这里按秒存、按毫秒比较 */
export const BAIDU_PAN_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 默认配置（每次返回新对象，避免调用方互相污染） */
export function defaultBaiduPanSettings(): BaiduPanSettings {
  return {
    enabled: false,
    appKey: "",
    secretKey: "",
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    dir: DEFAULT_BAIDU_PAN_DIR,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 从任意来源值规整出一份完整配置（不改动入参；给测试与调用方做「期望值」用） */
export function normalizeBaiduPanSettings(raw: unknown): BaiduPanSettings {
  const source = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<BaiduPanSettings>;
  const dir = asString(source.dir);
  return {
    enabled: source.enabled === true,
    appKey: asString(source.appKey) ?? "",
    secretKey: asString(source.secretKey) ?? "",
    accessToken: asString(source.accessToken) ?? "",
    refreshToken: asString(source.refreshToken) ?? "",
    expiresAt: asFiniteTimestamp(source.expiresAt) ?? 0,
    dir: dir && dir.trim().length > 0 ? dir.trim() : DEFAULT_BAIDU_PAN_DIR,
  };
}

/**
 * 就地把 `settings.baiduPan` 补齐为完整合法配置，并报告是否需要写回 data.json。
 *
 * 三条约束（与 `definitionSectionOrder` 的既有写法一致）：
 * 1. 只增不改：已有合法值原样保留，未知字段（未来版本新增的）也不丢弃；
 * 2. 只填空缺/非法值：缺失字段、类型不对的字段、空白 dir；
 * 3. 只在发生变化时写回：传 `saved`（磁盘上的原始 data.json）时，若磁盘形态已经完整
 *    就返回 `changed: false`，避免每次启动都刷盘；旧配置完全没有 `baiduPan` 时补写一次。
 */
export function ensureBaiduPanSettings(
  settings: HiWordsSettings,
  saved?: Record<string, unknown> | null
): { changed: boolean; value: BaiduPanSettings } {
  const raw = settings.baiduPan as Partial<BaiduPanSettings> | undefined;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const value = defaultBaiduPanSettings();
    settings.baiduPan = value;
    return { changed: true, value };
  }

  let mutated = false;
  const assign = <K extends keyof BaiduPanSettings>(key: K, next: BaiduPanSettings[K]): void => {
    if (raw[key] !== next) {
      raw[key] = next;
      mutated = true;
    }
  };

  assign("enabled", raw.enabled === true);
  assign("appKey", asString(raw.appKey) ?? "");
  assign("secretKey", asString(raw.secretKey) ?? "");
  assign("accessToken", asString(raw.accessToken) ?? "");
  assign("refreshToken", asString(raw.refreshToken) ?? "");
  assign("expiresAt", asFiniteTimestamp(raw.expiresAt) ?? 0);
  const dir = asString(raw.dir);
  assign("dir", dir && dir.trim().length > 0 ? dir.trim() : DEFAULT_BAIDU_PAN_DIR);

  const value = raw as BaiduPanSettings;
  settings.baiduPan = value;

  // 旧 data.json 里根本没这个字段：补写一次，让配置落盘
  const onDiskMissing = saved !== undefined && saved !== null && saved.baiduPan === undefined;
  return { changed: mutated || onDiskMissing, value };
}

/**
 * 应用沙箱根路径：`/apps/<dir>`。
 * 百度网盘开放平台的「未上线/未过审」应用只能读写自己应用目录下的路径，
 * 越界写入会被服务端拒绝（errno 非 0）；客户端也会在本地先做一次校验。
 */
export function baiduPanSandboxRoot(config: Pick<BaiduPanSettings, "dir">): string {
  const dir = (config.dir || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return `/apps/${dir && dir.length > 0 ? dir : DEFAULT_BAIDU_PAN_DIR}`;
}

/** 网盘内词库与边车所在目录：`/apps/<dir>/Words` */
export function baiduPanWordsDir(config: Pick<BaiduPanSettings, "dir">): string {
  return `${baiduPanSandboxRoot(config)}/${BAIDU_PAN_WORDS_SUBDIR}`;
}

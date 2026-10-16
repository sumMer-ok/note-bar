/**
 * 百度网盘设置默认值与「只增不改」迁移单测。
 *
 * 覆盖（COVERED）
 *   - 旧 data.json 完全没有 baiduPan → 补默认值且报告需要写回一次
 *   - 磁盘上已有完整 baiduPan → 不再写回（changed=false），避免每次启动刷盘
 *   - 单个字段缺失/类型非法 → 只补该字段，已有合法值原样保留
 *   - 凭证字段不会被迁移清空（这是最危险的回归）
 *   - 未知/未来字段不被丢弃（只增不改）
 *   - 沙箱路径推导：dir 决定 /apps/<dir> 与 /apps/<dir>/Words
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BAIDU_PAN_DIR,
  baiduPanSandboxRoot,
  baiduPanWordsDir,
  defaultBaiduPanSettings,
  ensureBaiduPanSettings,
  normalizeBaiduPanSettings,
} from "../../src/sync/baidu-pan-config";
import type { HiWordsSettings } from "../../src/hiwords/utils/types";

function bareSettings(): HiWordsSettings {
  // 模拟旧 data.json：完全没有 baiduPan 字段
  return {
    vocabularyBooks: [],
    showDefinitionOnHover: true,
    enableAutoHighlight: true,
    highlightStyle: "underline",
    enableMasteredFeature: true,
    showMasteredInSidebar: true,
    blurDefinitions: false,
    aiService: { provider: "openai-compatible", apiUrl: "", apiKey: "", model: "", extraParams: "{}" },
    aiDefinition: { enabled: false, prompt: "" },
    selectionTranslate: { enabled: false, targetLang: "zh-CN", prompt: "" },
  };
}

test("旧配置（无 baiduPan）补齐默认值并报告需要写回一次", () => {
  const settings = bareSettings();
  const before = Object.keys(settings).length;
  const { changed, value } = ensureBaiduPanSettings(settings, {});
  assert.equal(changed, true);
  assert.deepEqual(value, defaultBaiduPanSettings());
  assert.equal(value.dir, DEFAULT_BAIDU_PAN_DIR);
  assert.equal(settings.baiduPan, value);
  // 只新增字段，不动既有字段
  assert.equal(Object.keys(settings).length, before + 1);
  assert.equal(settings.showDefinitionOnHover, true);
  assert.equal(settings.highlightStyle, "underline");
});

test("磁盘上已有完整 baiduPan 时不再写回（changed=false，避免每次启动刷盘）", () => {
  const onDisk = {
    enabled: true,
    appKey: "k",
    secretKey: "s",
    accessToken: "a",
    refreshToken: "r",
    expiresAt: 12345,
    dir: "MyApp",
  };
  const settings = bareSettings();
  settings.baiduPan = { ...onDisk };
  const { changed, value } = ensureBaiduPanSettings(settings, { baiduPan: { ...onDisk } });
  assert.equal(changed, false);
  assert.deepEqual(value, { ...onDisk });
});

test("单个字段缺失或类型非法时只补该字段，合法值原样保留", () => {
  const settings = bareSettings();
  settings.baiduPan = {
    enabled: true,
    appKey: "keep-me",
    secretKey: "keep-me-too",
    accessToken: "token",
    refreshToken: "refresh",
    // expiresAt 缺失、dir 类型非法
  } as never;
  (settings.baiduPan as Record<string, unknown>).expiresAt = "not-a-number";
  (settings.baiduPan as Record<string, unknown>).dir = 42;

  const { changed, value } = ensureBaiduPanSettings(settings, { baiduPan: {} });
  assert.equal(changed, true);
  // 凭证一律保留，绝不被迁移清空
  assert.equal(value.appKey, "keep-me");
  assert.equal(value.secretKey, "keep-me-too");
  assert.equal(value.accessToken, "token");
  assert.equal(value.refreshToken, "refresh");
  assert.equal(value.enabled, true);
  // 非法值被补成默认
  assert.equal(value.expiresAt, 0);
  assert.equal(value.dir, DEFAULT_BAIDU_PAN_DIR);
});

test("dir 为纯空白时回落到 NoteBar", () => {
  const settings = bareSettings();
  settings.baiduPan = { ...defaultBaiduPanSettings(), dir: "   " };
  const { value } = ensureBaiduPanSettings(settings);
  assert.equal(value.dir, DEFAULT_BAIDU_PAN_DIR);
});

test("未知/未来字段不被丢弃（只增不改）", () => {
  const settings = bareSettings();
  settings.baiduPan = { ...defaultBaiduPanSettings(), futureFlag: "keep" } as never;
  ensureBaiduPanSettings(settings);
  assert.equal((settings.baiduPan as Record<string, unknown>).futureFlag, "keep");
});

test("baiduPan 是非对象（数组/字符串）时替换为默认值", () => {
  for (const broken of [[], "oops", 123]) {
    const settings = bareSettings();
    settings.baiduPan = broken as never;
    const { changed, value } = ensureBaiduPanSettings(settings, { baiduPan: broken });
    assert.equal(changed, true);
    assert.deepEqual(value, defaultBaiduPanSettings());
  }
});

test("normalizeBaiduPanSettings 不改动入参并返回全新对象", () => {
  const source = { ...defaultBaiduPanSettings(), dir: "  X  " };
  const snapshot = JSON.stringify(source);
  const normalized = normalizeBaiduPanSettings(source);
  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(normalized.dir, "X");
  assert.notEqual(normalized, source);
});

test("沙箱路径推导：/apps/<dir> 与 /apps/<dir>/Words", () => {
  assert.equal(baiduPanSandboxRoot({ dir: "NoteBar" }), "/apps/NoteBar");
  assert.equal(baiduPanWordsDir({ dir: "NoteBar" }), "/apps/NoteBar/Words");
  assert.equal(baiduPanSandboxRoot({ dir: "MyApp" }), "/apps/MyApp");
  // 前后斜杠与空白都规整掉，避免拼出 /apps//X/Words
  assert.equal(baiduPanSandboxRoot({ dir: "/Trim/" }), "/apps/Trim");
  assert.equal(baiduPanSandboxRoot({ dir: "  " }), "/apps/NoteBar");
});

test("多次调用 ensureBaiduPanSettings 结果稳定（幂等）", () => {
  const settings = bareSettings();
  ensureBaiduPanSettings(settings, {});
  const first = JSON.stringify(settings.baiduPan);
  const { changed } = ensureBaiduPanSettings(settings, { baiduPan: JSON.parse(first) });
  assert.equal(changed, false);
  assert.equal(JSON.stringify(settings.baiduPan), first);
});

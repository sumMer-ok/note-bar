import { test } from "node:test";
import assert from "node:assert/strict";
import { isInboxEnabled, resolveInboxDir } from "../../src/sync/inbox-config";
import type { HiWordsSettings } from "../../src/hiwords/utils/types";

/** 只构造本模块用到的两个子对象，其余字段与本模块无关 */
function settings(config: {
  enabled?: boolean;
  inboxDir?: string;
  mobileDir?: string;
  crossAppInbox?: unknown;
}): HiWordsSettings {
  const value: any = {
    mobileSync: config.mobileDir === undefined ? undefined : { enabled: false, syncDir: config.mobileDir, pollIntervalSec: 15 },
  };
  if (config.crossAppInbox !== undefined) {
    value.crossAppInbox = config.crossAppInbox;
  } else {
    value.crossAppInbox = { enabled: config.enabled ?? false, syncDir: config.inboxDir ?? "", duplicatePolicy: "skip" };
  }
  return value as HiWordsSettings;
}

test("未配置 crossAppInbox 时视为未启用", () => {
  assert.equal(isInboxEnabled(settings({ crossAppInbox: undefined })), false);
});

test("enabled 明确为 true 才算启用，false 与缺省都算未启用", () => {
  assert.equal(isInboxEnabled(settings({ enabled: false })), false);
  assert.equal(isInboxEnabled(settings({ enabled: true })), true);
  assert.equal(isInboxEnabled(settings({ crossAppInbox: { enabled: false, syncDir: "x", duplicatePolicy: "skip" } })), false);
  assert.equal(isInboxEnabled(settings({ crossAppInbox: { duplicatePolicy: "skip" } })), false);
});

test("收件箱目录优先用 crossAppInbox.syncDir", () => {
  assert.equal(resolveInboxDir(settings({ inboxDir: "/inbox", mobileDir: "/mobile" })), "/inbox");
});

test("crossAppInbox.syncDir 为空时回落到 mobileSync.syncDir", () => {
  assert.equal(resolveInboxDir(settings({ inboxDir: "", mobileDir: "/mobile" })), "/mobile");
  assert.equal(resolveInboxDir(settings({ crossAppInbox: { enabled: true, duplicatePolicy: "skip" }, mobileDir: "/mobile" })), "/mobile");
});

test("两处目录都为空或只有空白时返回 null", () => {
  assert.equal(resolveInboxDir(settings({ inboxDir: "", mobileDir: "" })), null);
  assert.equal(resolveInboxDir(settings({ inboxDir: "   ", mobileDir: "\t\n " })), null);
  assert.equal(resolveInboxDir(settings({ crossAppInbox: undefined, mobileDir: undefined })), null);
});

test("目录两端空白被裁剪", () => {
  assert.equal(resolveInboxDir(settings({ inboxDir: "  /inbox  " })), "/inbox");
  assert.equal(resolveInboxDir(settings({ inboxDir: "  ", mobileDir: "  /mobile  " })), "/mobile");
});

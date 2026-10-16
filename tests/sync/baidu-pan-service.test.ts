/**
 * 百度网盘同步服务单测（假 provider，不触网、不依赖 obsidian）。
 *
 * 覆盖（COVERED）
 *   - start 按配额友好的间隔轮询；stop 后不再触发；可重复 start（先停旧的）
 *   - syncNow 并发调用复用同一个在途 Promise（连点/轮询撞车不重复吃配额）
 *   - provider 返回 null / 抛错时的行为与可见告警
 *   - onResult 被回调；stop 幂等
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BaiduPanSyncService,
  DEFAULT_BAIDU_PAN_POLL_SEC,
} from "../../src/sync/baidu-pan-service";
import type { BaiduPanProvider, BaiduPanSyncResult } from "../../src/sync/baidu-pan-provider";

function emptyResult(overrides: Partial<BaiduPanSyncResult> = {}): BaiduPanSyncResult {
  return { uploaded: 0, downloaded: 0, rejected: 0, mergedKeys: 0, sidecarsUploaded: 0, failed: [], ...overrides };
}

/** 可选注入的假计时器：记录间隔，并可手动触发 tick */
function fakeTimers() {
  const handlers: Array<() => void> = [];
  const intervals: number[] = [];
  let cleared = 0;
  return {
    handlers,
    intervals,
    clearedCount: () => cleared,
    setIntervalFn: (handler: () => void, ms: number) => {
      handlers.push(handler);
      intervals.push(ms);
      return handlers.length as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {
      cleared++;
    },
  };
}

test("start 使用默认轮询间隔（300 秒，配额友好）并注册定时器", () => {
  const timers = fakeTimers();
  const service = new BaiduPanSyncService({
    provider: () => ({ syncOnce: async () => emptyResult() } as unknown as BaiduPanProvider),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  service.start();
  assert.equal(service.isRunning, true);
  assert.deepEqual(timers.intervals, [DEFAULT_BAIDU_PAN_POLL_SEC * 1000]);
});

test("start 支持自定义间隔，且下限被夹到 30 秒（防止把配额打光）", () => {
  const a = fakeTimers();
  const serviceA = new BaiduPanSyncService({
    provider: () => null,
    pollIntervalSec: 600,
    setIntervalFn: a.setIntervalFn,
    clearIntervalFn: a.clearIntervalFn,
  });
  serviceA.start();
  assert.deepEqual(a.intervals, [600_000]);

  const b = fakeTimers();
  const serviceB = new BaiduPanSyncService({
    provider: () => null,
    pollIntervalSec: 1,
    setIntervalFn: b.setIntervalFn,
    clearIntervalFn: b.clearIntervalFn,
  });
  serviceB.start();
  assert.deepEqual(b.intervals, [30_000]);
});

test("stop 清理定时器并置 isRunning=false；可重复调用且可再次 start", () => {
  const timers = fakeTimers();
  const service = new BaiduPanSyncService({
    provider: () => null,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  service.start();
  service.stop();
  assert.equal(service.isRunning, false);
  service.stop(); // 幂等
  assert.equal(service.isRunning, false);
  service.start();
  assert.equal(service.isRunning, true);
  service.stop();
});

test("syncNow 并发调用复用同一个在途 Promise（不重复消耗配额）", async () => {
  let calls = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new BaiduPanSyncService({
    provider: () =>
      ({
        syncOnce: async () => {
          calls++;
          await gate;
          return emptyResult({ uploaded: 1 });
        },
      }) as unknown as BaiduPanProvider,
  });

  const first = service.syncNow();
  const second = service.syncNow();
  release!();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1, "并发调用只应触发一次同步");
  assert.equal(a?.uploaded, 1);
  assert.equal(b?.uploaded, 1);

  // 在途结束后可以再次发起
  await service.syncNow();
  assert.equal(calls, 2);
});

test("provider 返回 null（未配置/未启用）时 syncNow 返回 null 且不报错", async () => {
  const errors: string[] = [];
  const service = new BaiduPanSyncService({
    provider: () => null,
    onError: (message) => void errors.push(message),
  });
  assert.equal(await service.syncNow(), null);
  assert.deepEqual(errors, []);
});

test("provider 抛错时 syncNow 返回 null 且经 onError 可见（不把异常抛给调用方）", async () => {
  const errors: string[] = [];
  const service = new BaiduPanSyncService({
    provider: () =>
      ({
        syncOnce: async () => {
          throw new Error("errno=20012（访问超限）");
        },
      }) as unknown as BaiduPanProvider,
    onError: (message) => void errors.push(message),
  });
  assert.equal(await service.syncNow(), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /20012/);
});

test("onResult 收到同步结果", async () => {
  const seen: BaiduPanSyncResult[] = [];
  const service = new BaiduPanSyncService({
    provider: () =>
      ({
        syncOnce: async () => emptyResult({ mergedKeys: 7, downloaded: 2 }),
      }) as unknown as BaiduPanProvider,
    onResult: (result) => void seen.push(result),
  });
  await service.syncNow();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mergedKeys, 7);
  assert.equal(seen[0].downloaded, 2);
});

test("轮询回调触发时通过 provider() 重新取 provider（设置变更后无需重建服务）", async () => {
  const timers = fakeTimers();
  let current: BaiduPanProvider | null = null;
  let calls = 0;
  const service = new BaiduPanSyncService({
    provider: () => current,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  service.start();
  // 启动时没有 provider：轮询触发不应报错
  timers.handlers.forEach((handler) => handler());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);

  // 之后注入 provider，下一次轮询应使用它
  current = {
    syncOnce: async () => {
      calls++;
      return emptyResult();
    },
  } as unknown as BaiduPanProvider;
  timers.handlers.forEach((handler) => handler());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

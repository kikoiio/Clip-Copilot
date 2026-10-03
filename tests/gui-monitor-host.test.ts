import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MonitorHost, type MonitorUpdate } from "../src/gui/monitor-host.ts";
import { acquireMonitorRunLock } from "../src/monitor/store.ts";
import type { MonitorState, SuggestionRecord } from "../src/monitor/types.ts";

function stubSuggestion(key: string, status: SuggestionRecord["status"]): SuggestionRecord {
  return {
    key,
    id: `sugg-${key}`,
    category: "analysis_error",
    disposition: "record",
    priority: "info",
    evidence: `证据 ${key}`,
    impact: "影响",
    nextAction: "下一步",
    affectedPaths: ["assets/x.mp4"],
    episode: 1,
    status,
    firstSeenAt: "2026-10-03T00:00:00.000Z",
    lastSeenAt: "2026-10-03T00:00:00.000Z",
  };
}

function stubMonitorState(suggestions: SuggestionRecord[]): MonitorState {
  return {
    schemaVersion: 1,
    revision: 1,
    config: { scopes: ["assets"], notificationLevel: "silent", autoRepairHandoff: false },
    suggestions,
    metrics: {
      notificationAttempts: 0,
      notificationSent: 0,
      notificationFailed: 0,
      duplicateNotificationsSuppressed: 0,
      acknowledged: 0,
      ignored: 0,
      resolved: 0,
    },
    repairs: [],
  };
}

/** 模拟真实监测进程：占用真实运行锁直到 abort，再释放。 */
function lockHoldingWatcher(): (dirs: readonly string[], signal: AbortSignal) => Promise<void> {
  return async (dirs, signal) => {
    const lock = await acquireMonitorRunLock(dirs[0]!);
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      await lock.release();
    }
  };
}

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "gui-monitor-host-"));
}

test("T4：运行锁被占时 start 返回确定性的失败条目", async () => {
  const dir = await makeDir();
  const host = new MonitorHost({ watch: lockHoldingWatcher() });
  try {
    const holder = await acquireMonitorRunLock(dir);
    try {
      const entry = await host.start(dir);
      assert.equal(entry.running, false);
      assert.match(entry.error ?? "", /被占用/);
      assert.deepEqual(host.list().filter((item) => item.dir === path.resolve(dir)), []);
    } finally {
      await holder.release();
    }
  } finally {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T4：轮询差分只在建议或指标变化时推送", async () => {
  const dir = await makeDir();
  const states: MonitorState[] = [stubMonitorState([]), stubMonitorState([stubSuggestion("missing-asset", "open")])];
  let call = 0;
  const host = new MonitorHost({
    pollIntervalMs: 10,
    loadMonitor: async () => states[Math.min(call, states.length - 1)]!,
    watch: async (dirs, signal) => {
      void dirs;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  const updates: MonitorUpdate[] = [];
  const unsubscribe = host.onUpdate((update) => updates.push(update));
  try {
    const entry = await host.start(dir);
    assert.equal(entry.running, true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    call = 1; // 下一次轮询读到含建议的状态
    await new Promise((resolve) => setTimeout(resolve, 60));

    const suggestionUpdates = updates.filter((update) => update.suggestions.length > 0);
    assert.equal(suggestionUpdates.length, 1);
    assert.equal(suggestionUpdates[0]!.suggestions[0]!.key, "missing-asset");
    assert.ok(updates.length >= 2, "初始推送 + 变化推送至少两次");
    // 状态不再变化时不应继续推送
    const countBeforeIdle = updates.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(updates.length, countBeforeIdle, "稳定状态下不应重复推送");
  } finally {
    unsubscribe();
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T4：stop 后运行锁立即可被 CLI 接管", async () => {
  const dir = await makeDir();
  const host = new MonitorHost({ watch: lockHoldingWatcher(), pollIntervalMs: 1_000 });
  try {
    const entry = await host.start(dir);
    assert.equal(entry.running, true);
    const stopped = await host.stop(dir);
    assert.equal(stopped.running, false);
    // 引擎释放锁后，CLI 的 acquireMonitorRunLock 必须成功
    const lock = await acquireMonitorRunLock(dir);
    await lock.release();
  } finally {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T4：dispose 停止全部会话", async () => {
  const host = new MonitorHost({
    watch: async (dirs, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      void dirs;
    },
    pollIntervalMs: 1_000,
  });
  const a = await makeDir();
  const b = await makeDir();
  try {
    await host.start(a);
    await host.start(b);
    assert.equal(host.list().length, 2);
    await host.dispose();
    assert.deepEqual(host.list(), []);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("T4：监测进程启动失败时经事件上报可读原因", async () => {
  const dir = await makeDir();
  const host = new MonitorHost({
    watch: async () => {
      throw new AggregateError([new Error("工作区目录不存在")], "所有指定工作区均无法启动监测");
    },
    pollIntervalMs: 1_000,
  });
  const updates: MonitorUpdate[] = [];
  const unsubscribe = host.onUpdate((update) => updates.push(update));
  try {
    await host.start(dir);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const errors = updates.filter((update) => update.error !== undefined);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error ?? "", /工作区目录不存在/);
    assert.deepEqual(host.list(), []);
  } finally {
    unsubscribe();
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

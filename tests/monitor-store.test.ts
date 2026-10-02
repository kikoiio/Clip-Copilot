import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_MONITOR_STATE_BYTES,
  MONITOR_DIR,
  MONITOR_HISTORY_DIR,
  MONITOR_RUN_LOCK,
  MONITOR_STATE_FILE,
  MONITOR_WRITE_LOCK,
  MonitorLockError,
  MonitorStoreError,
  acquireMonitorRunLock,
  iterateMonitorHistory,
  loadMonitorState,
  updateMonitorState,
} from "../src/monitor/store.ts";

async function workspace(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mm-monitor-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function statePath(dir: string): string {
  return path.join(dir, MONITOR_DIR, MONITOR_STATE_FILE);
}

test("T2: missing monitor record loads defaults without touching creative state", async (t) => {
  const dir = await workspace(t);
  const creative = path.join(dir, "state.json");
  await writeFile(creative, "old-workspace-bytes");
  const loaded = await loadMonitorState(dir);
  assert.equal(loaded.revision, 0);
  assert.equal(loaded.config.notificationLevel, "important");
  assert.equal(loaded.config.autoRepairHandoff, false);
  assert.deepEqual(loaded.config.scopes, ["assets", "projects", "outputs", "evidence", "state"]);
  assert.equal(await readFile(creative, "utf8"), "old-workspace-bytes");
  await assert.rejects(readFile(statePath(dir)), { code: "ENOENT" });
});

test("T2: corrupt, unknown-version, and oversized records are preserved", async (t) => {
  const dir = await workspace(t);
  await mkdir(path.dirname(statePath(dir)));
  for (const raw of ["{broken", '{"schemaVersion":99}', "x".repeat(MAX_MONITOR_STATE_BYTES + 1)]) {
    await writeFile(statePath(dir), raw);
    await assert.rejects(loadMonitorState(dir), MonitorStoreError);
    assert.equal(await readFile(statePath(dir), "utf8"), raw);
  }
});

test("T3: atomic commit increments revision and serialization failure preserves old bytes", async (t) => {
  const dir = await workspace(t);
  const first = await updateMonitorState(dir, (current) => {
    current.config.notificationLevel = "silent";
    return current;
  });
  assert.equal(first.revision, 1);
  const original = await readFile(statePath(dir), "utf8");
  await assert.rejects(updateMonitorState(dir, (current) => {
    const withCycle = current as typeof current & { cycle?: unknown };
    withCycle.cycle = withCycle;
    return withCycle;
  }), /circular/i);
  assert.equal(await readFile(statePath(dir), "utf8"), original);
  assert.deepEqual((await readdir(path.dirname(statePath(dir)))).filter((name) => name.includes(".tmp-")), []);
  const second = await updateMonitorState(dir, (current) => current);
  assert.equal(second.revision, 2);
});

test("T4: concurrent updates retain both changes", async (t) => {
  const dir = await workspace(t);
  await Promise.all([
    updateMonitorState(dir, (current) => { current.metrics.acknowledged += 1; return current; }),
    updateMonitorState(dir, (current) => { current.metrics.ignored += 1; return current; }),
  ]);
  const state = await loadMonitorState(dir);
  assert.equal(state.revision, 2);
  assert.equal(state.metrics.acknowledged, 1);
  assert.equal(state.metrics.ignored, 1);
});

test("T4: independent processes serialize updates", async (t) => {
  const dir = await workspace(t);
  const storeUrl = pathToFileURL(fileURLToPath(new URL("../src/monitor/store.ts", import.meta.url))).href;
  const script = `import { updateMonitorState } from ${JSON.stringify(storeUrl)}; await updateMonitorState(process.argv[1], (state) => { state.metrics.acknowledged++; return state; });`;
  async function worker(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir], { stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.setEncoding("utf8").on("data", (part: string) => { error += part; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${error}`)));
    });
  }
  await Promise.all([worker(), worker()]);
  const state = await loadMonitorState(dir);
  assert.equal(state.revision, 2);
  assert.equal(state.metrics.acknowledged, 2);
});

test("T4: live or unknown write lock times out; confirmed dead owner is reclaimed", async (t) => {
  const dir = await workspace(t);
  const monitorDir = path.join(dir, MONITOR_DIR);
  await mkdir(monitorDir);
  const lock = path.join(monitorDir, MONITOR_WRITE_LOCK);
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: "live", acquiredAt: new Date().toISOString() }));
  await assert.rejects(updateMonitorState(dir, (state) => state), MonitorLockError);
  assert.equal((await readFile(lock, "utf8")).includes("live"), true);
  await writeFile(lock, "unknown-owner");
  await assert.rejects(updateMonitorState(dir, (state) => state), MonitorLockError);
  assert.equal(await readFile(lock, "utf8"), "unknown-owner");
  await writeFile(lock, JSON.stringify({ pid: 99_999_999, token: "dead", acquiredAt: new Date().toISOString() }));
  assert.equal((await updateMonitorState(dir, (state) => state)).revision, 1);
});

test("T5: run lock excludes duplicates and release allows restart", async (t) => {
  const dir = await workspace(t);
  const first = await acquireMonitorRunLock(dir);
  await assert.rejects(acquireMonitorRunLock(dir), MonitorLockError);
  await first.release();
  await first.release();
  const second = await acquireMonitorRunLock(dir);
  await second.release();
});

test("T5: run lock reclaims only confirmed dead owners", async (t) => {
  const dir = await workspace(t);
  const monitorDir = path.join(dir, MONITOR_DIR);
  await mkdir(monitorDir);
  const lock = path.join(monitorDir, MONITOR_RUN_LOCK);
  await writeFile(lock, "unknown-owner");
  await assert.rejects(acquireMonitorRunLock(dir), MonitorLockError);
  assert.equal(await readFile(lock, "utf8"), "unknown-owner");
  await writeFile(lock, JSON.stringify({ pid: 99_999_999, token: "dead", acquiredAt: new Date().toISOString() }));
  const acquired = await acquireMonitorRunLock(dir);
  await acquired.release();
});

function resolvedSuggestion(index: number) {
  return {
    id: `suggestion-${index}`,
    key: `reason-${index}`,
    category: "asset_missing" as const,
    disposition: "action" as const,
    priority: "high" as const,
    evidence: `evidence-${index}`,
    impact: "affected output",
    nextAction: "restore asset",
    affectedPaths: ["assets/a.mp4"],
    episode: 1,
    status: "resolved" as const,
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-01T00:00:00.000Z",
    resolvedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    notificationError: "desktop unavailable",
  };
}

test("history compaction preserves resolved suggestions and repairs", async (t) => {
  const dir = await workspace(t);
  await updateMonitorState(dir, (state) => {
    state.suggestions = Array.from({ length: 205 }, (_, index) => resolvedSuggestion(index));
    state.repairs = Array.from({ length: 205 }, (_, index) => ({
      at: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
      action: "rebuild-handoff" as const,
      authorized: true,
      result: "verified" as const,
      evidence: `repair-${index}`,
    }));
    return state;
  });
  const state = await loadMonitorState(dir);
  assert.equal(state.suggestions.length, 200);
  assert.equal(state.repairs.length, 200);
  const history = [];
  for await (const record of iterateMonitorHistory(dir)) history.push(record);
  assert.equal(history.filter((record) => record.kind === "suggestion").length, 5);
  assert.equal(history.filter((record) => record.kind === "repair").length, 5);
  assert.equal(history.find((record) => record.kind === "suggestion")?.record.notificationError, "desktop unavailable");
  await updateMonitorState(dir, (current) => current);
  const historyAgain = [];
  for await (const record of iterateMonitorHistory(dir)) historyAgain.push(record);
  assert.equal(historyAgain.length, 10);
});

test("history write failure preserves all records in old state", async (t) => {
  const dir = await workspace(t);
  await updateMonitorState(dir, (state) => state);
  const original = await readFile(statePath(dir), "utf8");
  await writeFile(path.join(dir, MONITOR_DIR, MONITOR_HISTORY_DIR), "blocking-file");
  await assert.rejects(updateMonitorState(dir, (state) => {
    state.suggestions = Array.from({ length: 201 }, (_, index) => resolvedSuggestion(index));
    return state;
  }));
  assert.equal(await readFile(statePath(dir), "utf8"), original);
});

test("failed state commit leaves uncommitted archive invisible and next update cleans it", async (t) => {
  const dir = await workspace(t);
  await updateMonitorState(dir, (state) => state);
  const original = await readFile(statePath(dir), "utf8");
  await assert.rejects(updateMonitorState(dir, (state) => {
    state.suggestions = Array.from({ length: 201 }, (_, index) => resolvedSuggestion(index));
    const withCycle = state as typeof state & { cycle?: unknown };
    withCycle.cycle = withCycle;
    return withCycle;
  }), /circular/i);
  assert.equal(await readFile(statePath(dir), "utf8"), original);
  const hidden = [];
  for await (const record of iterateMonitorHistory(dir)) hidden.push(record);
  assert.equal(hidden.length, 0);
  await updateMonitorState(dir, (state) => state);
  const visible = [];
  for await (const record of iterateMonitorHistory(dir)) visible.push(record);
  assert.equal(visible.length, 0);
  assert.deepEqual(await readdir(path.join(dir, MONITOR_DIR, MONITOR_HISTORY_DIR)), []);
});

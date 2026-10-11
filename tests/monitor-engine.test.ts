import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyState, saveState } from "../src/workspace/store.ts";
import { watchWorkspaces } from "../src/monitor/engine.ts";
import { loadMonitorState, updateMonitorState } from "../src/monitor/store.ts";

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-engine-"));
  await mkdir(path.join(dir, "assets"));
  await mkdir(path.join(dir, "projects"));
  const state = emptyState({
    title: "Engine fixture", theme: "Fixture", minFrames: 1, maxFrames: 100,
    outputSpec: { width: 1920, height: 1080, fps: 30 }, moodArc: [],
  });
  await saveState(dir, state, 0);
  return dir;
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("等待监测条件超时");
}

test("T20/T21: two workspaces establish quiet baselines, restart finds only offline net change", async () => {
  const a = await workspace();
  const b = await workspace();
  try {
    const firstStop = new AbortController();
    const firstRun = watchWorkspaces([b, a], firstStop.signal, { stableMs: 30, reconcileMs: 100 });
    try {
      await eventually(async () => !!(await loadMonitorState(a)).baseline && !!(await loadMonitorState(b)).baseline);
      const firstA = await loadMonitorState(a);
      const firstB = await loadMonitorState(b);
      assert.equal(firstA.metrics.notificationAttempts, 0);
      assert.equal(firstB.metrics.notificationAttempts, 0);
      assert.ok(firstA.suggestions.some((item) => item.category === "handoff_missing"));
    } finally { firstStop.abort(); await firstRun; }

    await writeFile(path.join(a, "projects", "offline.mmp"), "invalid xml");
    const secondStop = new AbortController();
    const secondRun = watchWorkspaces([a, b], secondStop.signal, { stableMs: 30, reconcileMs: 100 });
    try {
      await eventually(async () => (await loadMonitorState(a)).suggestions.some((item) => item.category === "project_invalid"));
      const latestA = await loadMonitorState(a);
      const latestB = await loadMonitorState(b);
      assert.equal(latestA.suggestions.filter((item) => item.category === "project_invalid").length, 1);
      assert.equal(latestB.suggestions.filter((item) => item.category === "project_invalid").length, 0);
      assert.equal(latestB.metrics.notificationAttempts, 0);
    } finally { secondStop.abort(); await secondRun; }
    // Released run locks permit immediate restart.
    const thirdStop = new AbortController();
    const thirdRun = watchWorkspaces([a], thirdStop.signal, { stableMs: 20, reconcileMs: 100 });
    await eventually(async () => !!(await loadMonitorState(a)).baseline);
    thirdStop.abort();
    await thirdRun;
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("T21: corrupted monitor record in one workspace does not stop the other", async () => {
  const broken = await workspace();
  const healthy = await workspace();
  try {
    await mkdir(path.join(broken, ".monitor"));
    await writeFile(path.join(broken, ".monitor", "state.json"), "{broken");
    const errors: string[] = [];
    const stop = new AbortController();
    const run = watchWorkspaces([broken, healthy], stop.signal, {
      stableMs: 20, reconcileMs: 100,
      onWorkspaceError: (dir) => errors.push(dir),
    });
    try {
      await eventually(async () => !!(await loadMonitorState(healthy)).baseline && errors.includes(broken));
      assert.equal(await readFile(path.join(broken, ".monitor", "state.json"), "utf8"), "{broken");
    } finally { stop.abort(); await run; }
  } finally {
    await rm(broken, { recursive: true, force: true });
    await rm(healthy, { recursive: true, force: true });
  }
});

test("T21: running monitor reloads scope changes without treating disabled paths as deletions", async () => {
  const dir = await workspace();
  try {
    await updateMonitorState(dir, (state) => {
      state.config.scopes = ["state"];
      state.config.notificationLevel = "silent";
      return state;
    });
    const stop = new AbortController();
    const run = watchWorkspaces([dir], stop.signal, { stableMs: 20, reconcileMs: 100 });
    try {
      await eventually(async () => !!(await loadMonitorState(dir)).baseline);
      await writeFile(path.join(dir, "assets", "ignored.mp4"), "x");
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal((await loadMonitorState(dir)).suggestions.some((item) => item.category === "asset_added"), false);
      await updateMonitorState(dir, (state) => { state.config.scopes = ["state", "assets"]; return state; });
      await eventually(async () => (await loadMonitorState(dir)).suggestions.some((item) => item.category === "asset_added"));
      await writeFile(path.join(dir, "assets", "new.mp4"), "y");
      await eventually(async () => (await loadMonitorState(dir)).suggestions.filter((item) => item.category === "asset_added").length === 2);
      assert.equal((await loadMonitorState(dir)).metrics.notificationAttempts, 0);
    } finally { stop.abort(); await run; }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { syncHandoff } from "../src/monitor/repair.ts";
import { loadMonitorState, updateMonitorState } from "../src/monitor/store.ts";
import { emptyState, saveState, writeHandoffAtomic } from "../src/workspace/store.ts";

async function setup(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-handoff-"));
  const state = emptyState({ title: "测试", theme: "山间清晨", minFrames: 30, maxFrames: 300,
    outputSpec: { width: 1920, height: 1080, fps: 30 }, moodArc: [] });
  await saveState(dir, state, 0);
  return dir;
}

test("handoff rebuild requires per-workspace authorization and records verification", async () => {
  const dir = await setup();
  try {
    await syncHandoff(dir);
    assert.equal(await stat(path.join(dir, "handoff.md")).then(() => true, () => false), false);
    await updateMonitorState(dir, (state) => { state.config.autoRepairHandoff = true; return state; });
    await syncHandoff(dir);
    const content = await readFile(path.join(dir, "handoff.md"), "utf8");
    assert.match(content, /revision 1/);
    assert.match(content, /主动建议/);
    const monitor = await loadMonitorState(dir);
    assert.equal(monitor.repairs.length, 1);
    assert.equal(monitor.repairs[0]?.result, "verified");
    await syncHandoff(dir);
    assert.equal((await loadMonitorState(dir)).repairs.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed atomic render preserves existing handoff bytes", async () => {
  const dir = await setup();
  try {
    await writeHandoffAtomic(dir, async () => "original");
    await assert.rejects(writeHandoffAtomic(dir, async () => { throw new Error("render failed"); }));
    assert.equal(await readFile(path.join(dir, "handoff.md"), "utf8"), "original");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

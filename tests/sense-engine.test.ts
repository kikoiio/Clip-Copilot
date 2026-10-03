/**
 * 感知引擎单测（task.md T5）：假观测序列驱动状态机（task.md 验证方式）。
 * 标题样本取自 2026-10-03 探针实测。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SenseEngine } from "../src/sense/engine.ts";
import type { InstanceApp, SpiSource } from "../src/sense/atspi.ts";
import type { SenseUpdate } from "../src/sense/types.ts";

const DIRTY = "final */ HD 1080p 30 fps — Kdenlive";
const CLEAN = "final / HD 1080p 30 fps — Kdenlive";

/** 可手工驱动的假观测源（与 SpiSource 同形）。 */
class FakeSource implements SpiSource {
  #cb: ((apps: InstanceApp[]) => void) | null = null;
  degraded: string | null = null;
  emit(apps: InstanceApp[]): void {
    this.#cb?.(apps);
  }
  async start(cb: (apps: InstanceApp[]) => void): Promise<void> {
    this.#cb = cb;
  }
  async stop(): Promise<void> {
    this.#cb = null;
  }
  degradedReason(): string | null {
    return this.degraded;
  }
}

function mkWorkspace(name: string, projects: string[]): string {
  const root = path.join(os.tmpdir(), `acc-p5-engine-${process.pid}`);
  const projectDir = path.join(root, name, "projects");
  mkdirSync(projectDir, { recursive: true });
  for (const p of projects) writeFileSync(path.join(projectDir, `${p}.kdenlive`), "<xml/>");
  return root;
}

function engineFor(root: string, source: FakeSource, cacheRoot?: string): SenseEngine {
  return new SenseEngine({
    source,
    workspacesRoot: root,
    listWorkspaceDirs: () => ["alpha", "beta"].map((d) => path.join(root, d)),
    ...(cacheRoot ? { cacheRoot } : {}),
  });
}

test("引擎：实例出现 → 运行+工程+脏标记（来源 title）", async () => {
  const root = mkWorkspace("alpha", ["final"]);
  const source = new FakeSource();
  const engine = engineFor(root, source);
  const updates: SenseUpdate[] = [];
  engine.onChange((u) => updates.push(u));
  engine.start();
  source.emit([{ pid: 11, title: DIRTY, focused: false }]);
  await asyncSettle();
  const state = engine.getState(path.join(root, "alpha"));
  assert.ok(state);
  assert.equal(state.running, true);
  assert.equal(state.unsavedSignal, true);
  assert.equal(state.unsavedSource, "title");
  assert.equal(state.instances[0]?.projectBasename, "final");
  await engine.stop();
  rmSync(root, { recursive: true, force: true });
});

test("引擎：保存后脏标记消失 → 信号解除；实例退出 → running=false", async () => {
  const root = mkWorkspace("alpha", ["final"]);
  const source = new FakeSource();
  const engine = engineFor(root, source);
  const updates: SenseUpdate[] = [];
  engine.onChange((u) => updates.push(u));
  engine.start();
  source.emit([{ pid: 11, title: DIRTY, focused: false }]);
  await asyncSettle();
  source.emit([{ pid: 11, title: CLEAN, focused: false }]);
  await asyncSettle();
  assert.equal(updates.at(-1)?.state.unsavedSignal, false);
  source.emit([]);
  await asyncSettle();
  assert.equal(updates.at(-1)?.state.running, false);
  assert.equal(updates.at(-1)?.state.unsavedSignal, null);
  await engine.stop();
  rmSync(root, { recursive: true, force: true });
});

test("引擎：无变化不重复推送（差分）", async () => {
  const root = mkWorkspace("alpha", ["final"]);
  const source = new FakeSource();
  const engine = engineFor(root, source);
  let pushes = 0;
  engine.onChange(() => pushes++);
  engine.start();
  source.emit([{ pid: 11, title: DIRTY, focused: false }]);
  await asyncSettle();
  const afterFirst = pushes;
  source.emit([{ pid: 11, title: DIRTY, focused: false }]);
  await asyncSettle();
  source.emit([{ pid: 11, title: DIRTY, focused: false }]);
  await asyncSettle();
  assert.equal(pushes, afterFirst);
  await engine.stop();
  rmSync(root, { recursive: true, force: true });
});

test("引擎：无法映射的实例进入 unmapped，不误绑定；空闲状态只推一次", async () => {
  const root = mkWorkspace("alpha", ["intro"]);
  const source = new FakeSource();
  const engine = engineFor(root, source);
  const updates: SenseUpdate[] = [];
  engine.onChange((u) => updates.push(u));
  engine.start();
  source.emit([{ pid: 12, title: "other / HD 1080p 30 fps — Kdenlive", focused: false }]);
  await asyncSettle();
  const snap = engine.snapshot();
  assert.equal(snap.states.size, 2); // 空闲工作区明确显示 Kdenlive 未运行
  assert.ok([...snap.states.values()].every((state) => state.running === false));
  assert.equal(snap.unmapped.length, 1);
  assert.equal(snap.unmapped[0]?.projectBasename, "other");
  const afterFirst = updates.length;
  source.emit([{ pid: 12, title: "other / HD 1080p 30 fps — Kdenlive", focused: false }]);
  await asyncSettle();
  assert.equal(updates.length, afterFirst);
  await engine.stop();
  rmSync(root, { recursive: true, force: true });
});

test("引擎：主信号不可读时走 autosave 次级信号；不可观察则降级", async () => {
  const root = mkWorkspace("alpha", ["final"]);
  const cacheRoot = path.join(os.tmpdir(), `acc-p5-cache-${process.pid}`);
  mkdirSync(path.join(cacheRoot, "stalefiles"), { recursive: true });
  const source = new FakeSource();
  const engine = engineFor(root, source, cacheRoot);
  engine.start();
  writeFileSync(path.join(cacheRoot, "stalefiles", "final.autosave"), "<xml/>");
  source.emit([{ pid: 13, title: "final — Kdenlive", focused: false }]);
  await asyncSettle();
  const state = engine.getState(path.join(root, "alpha"));
  assert.ok(state);
  assert.equal(state.unsavedSignal, true);
  assert.equal(state.unsavedSource, "autosave");
  assert.ok(!state.degraded.includes("autosave-unobservable"));
  await engine.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(cacheRoot, { recursive: true, force: true });
});

test("引擎：AT-SPI 不可用 → 全局降级、状态为零噪声", async () => {
  const root = mkWorkspace("alpha", ["final"]);
  const source = new FakeSource();
  source.degraded = "atspi-unavailable: no gi";
  const engine = engineFor(root, source);
  const updates: SenseUpdate[] = [];
  engine.onChange((u) => updates.push(u));
  engine.start();
  await asyncSettle();
  const snap = engine.snapshot();
  assert.equal(snap.globalDegraded.length, 1);
  assert.ok([...snap.states.values()].every((state) => state.degraded[0] === source.degraded));
  assert.equal(updates.length, 2);
  await engine.stop();
  rmSync(root, { recursive: true, force: true });
});

async function asyncSettle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

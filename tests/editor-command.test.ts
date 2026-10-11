import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createResolveFixtureAdapter } from "../src/editor/resolve/adapter.ts";
import { cmdResolve } from "../src/editor/resolve/command.ts";
import { emptyState, saveState } from "../src/workspace/store.ts";

function goal() {
  return { title: "CLI fixture", theme: "test", minFrames: 30, maxFrames: 300, outputSpec: { width: 1920, height: 1080, fps: 30 }, moodArc: [] };
}

async function workspace(resolve = true): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "resolve-command-"));
  const base = emptyState(goal());
  await saveState(dir, resolve ? {
    ...base,
    workspaceKind: "resolve" as const,
    editorContext: {
      kind: "resolve" as const,
      identity: null,
      latestSnapshot: null,
      health: { state: "offline" as const, checkedAt: "2026-10-11T00:00:00Z", reason: "not read yet" },
    },
  } : base, 0);
  return dir;
}

test("Resolve CLI 显示只读摘要，未知构建策略由真实适配器默认拒绝", async () => {
  const dir = await workspace();
  const output: string[] = [];
  try {
    const code = await cmdResolve(["read", "--workspace", dir], {
      adapter: createResolveFixtureAdapter(),
      stdout: (text) => output.push(text),
    });
    const report = JSON.parse(output[0]!) as { health: string; runtime: { edition: string }; snapshot: { fingerprint: string; counts: { clips: number }; mappingNotes: unknown[] } };
    assert.equal(code, 0);
    assert.equal(report.health, "online");
    assert.equal(report.runtime.edition, "free");
    assert.ok(report.snapshot.fingerprint);
    assert.ok(report.snapshot.counts.clips > 0);
    assert.ok(Array.isArray(report.snapshot.mappingNotes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Resolve CLI 对旧工作区、缺少目录和非只读参数返回错误", async () => {
  const dir = await workspace(false);
  try {
    await assert.rejects(() => cmdResolve(["read"], { adapter: createResolveFixtureAdapter() }), /--workspace/);
    await assert.rejects(() => cmdResolve(["read", "--workspace", dir, "--render"], { adapter: createResolveFixtureAdapter() }), /不支持参数/);
    await assert.rejects(() => cmdResolve(["read", "--workspace", dir], { adapter: createResolveFixtureAdapter() }), /Resolve 标记/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Resolve CLI 对离线刷新打印降级原因并返回非零", async () => {
  const dir = await workspace();
  const output: string[] = [];
  try {
    const code = await cmdResolve(["read", "--workspace", dir], {
      adapter: createResolveFixtureAdapter({ mode: "offline", offlineReason: "Resolve unavailable" }),
      stdout: (text) => output.push(text),
    });
    const report = JSON.parse(output[0]!) as { health: string; degradationReason: string };
    assert.equal(code, 1);
    assert.equal(report.health, "offline");
    assert.match(report.degradationReason, /unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

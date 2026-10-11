import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getWorkspaceDetail } from "../src/gui/read.ts";
import { buildSystemPrompt } from "../src/gui/ai/prompt.ts";
import { toolByName } from "../src/gui/ai/tools.ts";
import { createResolveFixtureAdapter } from "../src/editor/resolve/adapter.ts";
import { refreshResolveWorkspace } from "../src/editor/resolve/service.ts";
import { emptyState, saveState } from "../src/workspace/store.ts";

function goal() {
  return { title: "Resolve GUI fixture", theme: "test", minFrames: 30, maxFrames: 300, outputSpec: { width: 1920, height: 1080, fps: 30 }, moodArc: [] };
}

async function makeWorkspace(resolve = false): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gui-resolve-"));
  const state = emptyState(goal());
  await saveState(dir, resolve ? {
    ...state,
    workspaceKind: "resolve" as const,
    editorContext: {
      kind: "resolve" as const,
      identity: null,
      latestSnapshot: null,
      health: { state: "offline" as const, checkedAt: "2026-10-11T00:00:00Z", reason: "not read yet" },
    },
  } : state, 0);
  return dir;
}

test("旧工作区不伪造 Resolve 状态；Resolve 在线和离线投影快照、能力及过期原因", async () => {
  const oldDir = await makeWorkspace();
  const resolveDir = await makeWorkspace(true);
  try {
    assert.equal((await getWorkspaceDetail(oldDir)).resolve, null);
    await refreshResolveWorkspace(resolveDir, createResolveFixtureAdapter(), { timeoutMs: 500 });
    const online = await getWorkspaceDetail(resolveDir);
    assert.equal(online.resolve?.health.state, "online");
    assert.equal(online.resolve?.runtime?.compatibility, "supported");
    assert.ok(online.resolve?.snapshot?.fingerprint);
    assert.ok(online.resolve?.snapshot?.counts.clips);
    assert.ok(online.resolve?.capabilities.some((item) => item.id === "read.project_snapshot" && item.available));

    await refreshResolveWorkspace(resolveDir, createResolveFixtureAdapter({ mode: "offline", offlineReason: "Resolve disconnected" }), { timeoutMs: 500 });
    const offline = await getWorkspaceDetail(resolveDir);
    assert.equal(offline.resolve?.health.state, "offline");
    assert.match(offline.resolve?.staleReason ?? "", /disconnected/);
    assert.equal(offline.resolve?.snapshot?.fingerprint, online.resolve?.snapshot?.fingerprint);
    assert.equal(offline.resolve?.capabilities.some((item) => item.available), false);
  } finally {
    await rm(oldDir, { recursive: true, force: true });
    await rm(resolveDir, { recursive: true, force: true });
  }
});

test("AI 状态投影包含 Resolve 快照且系统提示说明可能过期", async () => {
  const dir = await makeWorkspace(true);
  try {
    await refreshResolveWorkspace(dir, createResolveFixtureAdapter(), { timeoutMs: 500 });
    await refreshResolveWorkspace(dir, createResolveFixtureAdapter({ mode: "offline", offlineReason: "Resolve disconnected" }), { timeoutMs: 500 });
    const status = JSON.parse(await toolByName("get_status")!.execute!({}, { dir })) as {
      resolve: { health: { state: string }; snapshot: { fingerprint: string } };
    };
    assert.equal(status.resolve.health.state, "offline");
    assert.ok(status.resolve.snapshot.fingerprint);
    const prompt = buildSystemPrompt(await getWorkspaceDetail(dir));
    assert.match(prompt, /Resolve 快照过期提示：Resolve disconnected/u);
    assert.match(prompt, /Resolve 可用能力：无/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

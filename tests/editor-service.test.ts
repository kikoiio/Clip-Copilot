import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createResolveFixtureAdapter } from "../src/editor/resolve/adapter.ts";
import { refreshResolveWorkspace } from "../src/editor/resolve/service.ts";
import { emptyState, loadState, saveState, WorkspaceError } from "../src/workspace/store.ts";

function goal() {
  return {
    title: "Resolve service fixture",
    theme: "test",
    minFrames: 30,
    maxFrames: 300,
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    moodArc: [],
  };
}

async function makeResolveWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "resolve-service-"));
  const state = {
    ...emptyState(goal()),
    workspaceKind: "resolve" as const,
    editorContext: {
      kind: "resolve" as const,
      identity: null,
      latestSnapshot: null,
      health: { state: "offline" as const, checkedAt: "2026-10-11T00:00:00.000Z", reason: "not read yet" },
    },
  };
  await saveState(dir, state, 0);
  return dir;
}

test("在线刷新保存 runtime、身份和快照到唯一 state.json", async () => {
  const dir = await makeResolveWorkspace();
  try {
    const refreshed = await refreshResolveWorkspace(dir, createResolveFixtureAdapter(), { timeoutMs: 500 });
    assert.equal(refreshed.state.editorContext.health.state, "online");
    assert.equal(refreshed.state.editorContext.runtime?.edition, "free");
    assert.equal(refreshed.state.editorContext.identity?.projectId, "fixture-project-001");
    const loaded = await loadState(dir);
    assert.equal(loaded.state.revision, refreshed.state.revision);
    assert.equal(loaded.state.editorContext?.latestSnapshot?.fingerprint, refreshed.state.editorContext.latestSnapshot?.fingerprint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("离线刷新保留最近成功快照和工作区历史", async () => {
  const dir = await makeResolveWorkspace();
  try {
    let refreshed = await refreshResolveWorkspace(dir, createResolveFixtureAdapter(), { timeoutMs: 500 });
    refreshed.state.decisions.push({ at: "2026-10-11T00:00:00.000Z", subject: "fixture", reason: "test", effect: "preserve" });
    refreshed.state.checkpoints.push({
      id: "checkpoint-fixture",
      phase: "score_review",
      createdAt: "2026-10-11T00:00:00.000Z",
      artifactIds: [],
      summary: "preserve checkpoint",
      nextAction: "continue",
      review: "pending",
    });
    refreshed.state.nextAction = "继续查看历史上下文";
    await saveState(dir, refreshed.state, refreshed.state.revision);
    await writeFile(path.join(dir, "handoff.md"), "preserve handoff\n");
    await mkdir(path.join(dir, "evidence"), { recursive: true });
    await writeFile(path.join(dir, "evidence", "verification.json"), "{\"result\":\"preserve\"}\n");
    const beforeFingerprint = refreshed.state.editorContext.latestSnapshot?.fingerprint;

    const offline = await refreshResolveWorkspace(dir, createResolveFixtureAdapter({ mode: "offline", offlineReason: "Resolve disconnected" }), { timeoutMs: 500 });
    assert.equal(offline.state.editorContext.health.state, "offline");
    assert.equal(offline.state.editorContext.health.reason, "Resolve disconnected");
    assert.equal(offline.state.editorContext.latestSnapshot?.fingerprint, beforeFingerprint);
    assert.equal(offline.state.decisions[0]?.subject, "fixture");
    assert.equal(offline.state.checkpoints[0]?.id, "checkpoint-fixture");
    assert.equal(offline.state.nextAction, "继续查看历史上下文");
    assert.equal(await readFile(path.join(dir, "handoff.md"), "utf8"), "preserve handoff\n");
    assert.equal(await readFile(path.join(dir, "evidence", "verification.json"), "utf8"), "{\"result\":\"preserve\"}\n");

    const protocolFailure = await refreshResolveWorkspace(dir, createResolveFixtureAdapter({ mode: "protocol", protocolReason: "malformed response" }), { timeoutMs: 500 });
    assert.equal(protocolFailure.state.editorContext.health.state, "unknown");
    assert.match(protocolFailure.state.editorContext.health.reason ?? "", /malformed response/);
    assert.equal(protocolFailure.state.editorContext.latestSnapshot?.fingerprint, beforeFingerprint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("旧工作区和 revision 冲突都拒绝 Resolve 刷新", async () => {
  const oldDir = await mkdtemp(path.join(tmpdir(), "resolve-service-old-"));
  const resolveDir = await makeResolveWorkspace();
  try {
    await saveState(oldDir, emptyState(goal()), 0);
    await assert.rejects(
      () => refreshResolveWorkspace(oldDir, createResolveFixtureAdapter(), { timeoutMs: 500 }),
      (error: unknown) => error instanceof WorkspaceError && /Resolve 标记/.test(error.message),
    );
    const loaded = await loadState(resolveDir);
    await assert.rejects(
      () => refreshResolveWorkspace(resolveDir, createResolveFixtureAdapter(), { timeoutMs: 500, expectedRevision: loaded.state.revision - 1 }),
      /版本冲突/,
    );
  } finally {
    await rm(oldDir, { recursive: true, force: true });
    await rm(resolveDir, { recursive: true, force: true });
  }
});

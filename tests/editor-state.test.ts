import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyState } from "../src/workspace/store.ts";
import { assertValidState, loadState, saveState, WorkspaceError } from "../src/workspace/store.ts";
import type { ResolveWorkspaceContext } from "../src/editor/contracts.ts";

function context(): ResolveWorkspaceContext {
  return {
    kind: "resolve",
    identity: null,
    latestSnapshot: null,
    health: { state: "offline", checkedAt: "2026-10-11T00:00:00.000Z", reason: "fixture" },
  };
}

function goal() {
  return {
    title: "Resolve fixture",
    theme: "test",
    minFrames: 30,
    maxFrames: 300,
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    moodArc: [],
  };
}

test("Resolve 标记要求合法 editorContext，旧状态仍不进入 Resolve 类型", () => {
  const oldState = emptyState(goal());
  assert.equal(oldState.workspaceKind, undefined);
  assert.doesNotThrow(() => assertValidState(oldState));

  const resolveState = { ...oldState, workspaceKind: "resolve" as const, editorContext: context() };
  assert.deepEqual(assertValidState(resolveState).editorContext, context());
  assert.throws(
    () => assertValidState({ ...oldState, workspaceKind: "resolve" as const }),
    (error: unknown) => error instanceof WorkspaceError && /editorContext/.test(error.message),
  );
});

test("Resolve 上下文经唯一 state.json 保存并可重新读取", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "clip-copilot-editor-state-"));
  try {
    const state = { ...emptyState(goal()), workspaceKind: "resolve" as const, editorContext: context() };
    const saved = await saveState(dir, state, 0);
    const loaded = await loadState(dir);
    assert.equal(saved.revision, 1);
    assert.deepEqual(loaded.state.editorContext, context());
    assert.equal(loaded.state.workspaceKind, "resolve");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("带 Resolve 标记但损坏上下文的状态被拒绝", () => {
  const base = emptyState(goal());
  assert.throws(() => assertValidState({ ...base, workspaceKind: "resolve" }), WorkspaceError);
  assert.throws(
    () => assertValidState({ ...base, workspaceKind: "resolve", editorContext: { kind: "resolve" } }),
    /editorContext/,
  );
  assert.throws(
    () => assertValidState({ ...base, editorContext: context() }),
    /不得包含 editorContext/,
  );
});

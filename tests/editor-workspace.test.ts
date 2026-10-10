import assert from "node:assert/strict";
import test from "node:test";
import { isResolveWorkspaceState, refreshResolveWorkspaceContext, validateResolveWorkspaceContext } from "../src/editor/workspace.ts";
import type {
  EditorAdapter,
  EditorHealth,
  ResolveWorkspaceContext,
  TimelineSnapshot,
} from "../src/editor/contracts.ts";
import { emptyState } from "../src/workspace/store.ts";

const health: EditorHealth = { state: "online", checkedAt: "2026-10-11T00:00:00.000Z" };
const snapshot: TimelineSnapshot = {
  identity: {
    projectId: "project-1",
    databaseId: "database-1",
    projectName: "Fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
  },
  timeBase: { numerator: 24, denominator: 1 },
  width: 1920,
  height: 1080,
  tracks: [],
  clips: [],
  markers: [],
  subtitles: [],
  media: [],
  capturedAt: "2026-10-11T00:00:00.000Z",
  fingerprint: "fingerprint-1",
  mappingNotes: [],
};

function adapter(mode: "online" | "offline" | "protocol"): EditorAdapter {
  return {
    editorKind: "resolve",
    getCapabilities: () => [],
    async getHealth() {
      return mode === "offline"
        ? { state: "offline", checkedAt: "2026-10-11T00:00:01.000Z", reason: "fixture offline" }
        : health;
    },
    async readProjectSnapshot() {
      if (mode === "protocol") {
        return {
          ok: false,
          error: { capabilityId: "read.project_snapshot", kind: "protocol", reason: "bad fixture", retryable: false },
        };
      }
      return { ok: true, value: snapshot };
    },
  };
}

function previous(): ResolveWorkspaceContext {
  return {
    kind: "resolve",
    identity: snapshot.identity,
    latestSnapshot: snapshot,
    health,
  };
}

test("在线刷新更新身份和快照", async () => {
  const refreshed = await refreshResolveWorkspaceContext(previous(), adapter("online"), { timeoutMs: 1000 });
  assert.equal(refreshed.health.state, "online");
  assert.equal(refreshed.latestSnapshot?.fingerprint, snapshot.fingerprint);
  assert.equal(refreshed.identity?.projectId, "project-1");
});

test("离线刷新保留最后成功快照并明确原因", async () => {
  const refreshed = await refreshResolveWorkspaceContext(previous(), adapter("offline"), { timeoutMs: 1000 });
  assert.equal(refreshed.health.state, "offline");
  assert.equal(refreshed.health.reason, "fixture offline");
  assert.equal(refreshed.latestSnapshot?.fingerprint, snapshot.fingerprint);
});

test("协议失败更新健康原因但不丢弃快照", async () => {
  const refreshed = await refreshResolveWorkspaceContext(previous(), adapter("protocol"), { timeoutMs: 1000 });
  assert.equal(refreshed.health.state, "unknown");
  assert.match(refreshed.health.reason ?? "", /bad fixture/);
  assert.equal(refreshed.latestSnapshot?.fingerprint, snapshot.fingerprint);
});

test("旧状态不进入 Resolve 路径，损坏上下文被拒绝", () => {
  const oldState = emptyState({
    title: "old",
    theme: "old",
    minFrames: 1,
    maxFrames: 2,
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    moodArc: [],
  });
  assert.equal(isResolveWorkspaceState(oldState), false);
  assert.throws(() => validateResolveWorkspaceContext({ kind: "resolve" }), /health/);
});

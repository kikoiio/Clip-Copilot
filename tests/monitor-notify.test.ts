import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverNotifications } from "../src/monitor/notify.ts";
import { loadMonitorState, updateMonitorState } from "../src/monitor/store.ts";
import type { SuggestionRecord } from "../src/monitor/types.ts";

function suggestion(id: string): SuggestionRecord {
  return {
    id, episode: 1, key: `reference_missing:${id}`, category: "reference_missing",
    disposition: "action", priority: "high", evidence: "引用文件不存在", impact: "工程无法使用",
    nextAction: "恢复引用素材", affectedPaths: ["projects/edit.kdenlive"], status: "open",
    firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
  };
}

test("initial baseline stays silent; a new episode reserves exactly one notification", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-notify-"));
  try {
    const row = suggestion("s1");
    await updateMonitorState(dir, (state) => { state.suggestions.push(row); return state; });
    let calls = 0;
    const sender = async () => { calls++; };
    await deliverNotifications(dir, [row], true, sender);
    assert.equal(calls, 0);
    await deliverNotifications(dir, [row], false, sender);
    await deliverNotifications(dir, [row], false, sender);
    const state = await loadMonitorState(dir);
    assert.equal(calls, 1);
    assert.equal(state.metrics.notificationAttempts, 1);
    assert.equal(state.metrics.notificationSent, 1);
    assert.equal(state.suggestions[0]?.notificationResult, "sent");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("desktop failure remains visible without discarding suggestion", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-notify-"));
  try {
    const row = suggestion("s2");
    await updateMonitorState(dir, (state) => { state.suggestions.push(row); return state; });
    await deliverNotifications(dir, [row], false, async () => { throw new Error("no desktop session"); });
    const state = await loadMonitorState(dir);
    assert.equal(state.suggestions[0]?.status, "open");
    assert.equal(state.suggestions[0]?.notificationResult, "failed");
    assert.match(state.suggestions[0]?.notificationError ?? "", /no desktop session/);
    assert.equal(state.metrics.notificationFailed, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

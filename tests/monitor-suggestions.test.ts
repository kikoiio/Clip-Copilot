import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSuggestion,
  notificationCandidates,
  reconcileSuggestions,
  recordNotificationResult,
  reserveNotificationAttempt,
} from "../src/monitor/suggestions.ts";
import { emptyMonitorState, type Finding } from "../src/monitor/types.ts";

const missing: Finding = {
  key: "reference_missing:projects/edit.kdenlive",
  category: "reference_missing",
  disposition: "action",
  priority: "high",
  evidence: "素材路径缺失",
  impact: "粗剪工程无法渲染",
  nextAction: "恢复素材或重开版本",
  affectedPaths: ["projects/edit.kdenlive", "assets/clip.mp4"],
};

test("重复发现合并，局部核对不误解决，消失后重现开启新轮", () => {
  const start = emptyMonitorState();
  const first = reconcileSuggestions(start, { findings: [missing], checkedKeys: [missing.key] }, true, "2026-10-03T00:00:00Z");
  assert.equal(first.newlyOpened.length, 1);
  assert.equal(first.next.suggestions.length, 1);
  const repeat = reconcileSuggestions(first.next, { findings: [{ ...missing, evidence: "仍然缺失" }], checkedKeys: [missing.key] }, false, "2026-10-03T00:01:00Z");
  assert.equal(repeat.newlyOpened.length, 0);
  assert.equal(repeat.next.suggestions[0]?.evidence, "仍然缺失");
  const unrelated = reconcileSuggestions(repeat.next, { findings: [], checkedKeys: ["asset_added:other"] }, false);
  assert.equal(unrelated.next.suggestions[0]?.status, "open");
  const gone = reconcileSuggestions(unrelated.next, { findings: [], checkedKeys: [missing.key] }, false);
  assert.equal(gone.next.suggestions[0]?.status, "resolved");
  assert.equal(gone.next.metrics.resolved, 1);
  const again = reconcileSuggestions(gone.next, { findings: [missing], checkedKeys: [missing.key] }, false);
  assert.equal(again.newlyOpened.length, 1);
  assert.equal(again.next.suggestions[1]?.episode, 2);
  assert.notEqual(again.next.suggestions[0]?.id, again.next.suggestions[1]?.id);
});

test("确认和忽略留痕；只有新的高优先级故障符合默认通知", () => {
  const first = reconcileSuggestions(emptyMonitorState(), { findings: [missing], checkedKeys: [missing.key] }, true);
  const record = first.newlyOpened[0]!;
  assert.equal(notificationCandidates([record], "important", true).length, 0);
  assert.equal(notificationCandidates([record], "important", false).length, 1);
  const acknowledged = decideSuggestion(first.next, record.id, "acknowledge");
  assert.equal(acknowledged.metrics.acknowledged, 1);
  assert.equal(notificationCandidates(acknowledged.suggestions, "important", false).length, 0);
  const ignored = decideSuggestion(acknowledged, record.id, "ignore");
  assert.equal(ignored.metrics.ignored, 1);
  assert.equal(ignored.suggestions[0]?.status, "ignored");
  assert.equal(notificationCandidates(ignored.suggestions, "all", false).length, 0);
  assert.throws(() => decideSuggestion(ignored, "missing", "ignore"), /不存在/);
});

test("通知先占位，结果只累计一次", () => {
  const first = reconcileSuggestions(emptyMonitorState(), { findings: [missing], checkedKeys: [missing.key] }, false);
  const id = first.newlyOpened[0]!.id;
  const reserved = reserveNotificationAttempt(first.next, id);
  assert.equal(reserved.metrics.notificationAttempts, 1);
  assert.equal(notificationCandidates(reserved.suggestions, "important", false).length, 0);
  const sent = recordNotificationResult(reserved, id, true);
  assert.equal(sent.metrics.notificationSent, 1);
  assert.equal(recordNotificationResult(sent, id, true).metrics.notificationSent, 1);
  assert.equal(reserveNotificationAttempt(sent, id).metrics.duplicateNotificationsSuppressed, 1);
});

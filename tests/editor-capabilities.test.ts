import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCapability,
  EDITOR_CAPABILITIES,
  getEditorCapabilities,
} from "../src/editor/capabilities.ts";
import type { EditorHealth } from "../src/editor/contracts.ts";

const online: EditorHealth = { state: "online", checkedAt: "2026-10-11T00:00:00.000Z" };
const offline: EditorHealth = {
  state: "offline",
  checkedAt: "2026-10-11T00:00:00.000Z",
  reason: "模拟适配器离线",
};

test("能力目录覆盖四阶段，且每项包含完整执行边界", () => {
  assert.deepEqual(new Set(EDITOR_CAPABILITIES.map(({ stage }) => stage)), new Set([
    "read", "edit", "render", "verify",
  ]));
  assert.equal(getEditorCapabilities(), EDITOR_CAPABILITIES);
  for (const capability of EDITOR_CAPABILITIES) {
    assert.ok(capability.id.length > 0);
    assert.ok(capability.prerequisites.length > 0, `${capability.id} 应列出前置条件`);
    assert.ok(capability.effect);
    assert.ok(capability.approval);
    assert.ok(capability.timeoutMs && capability.timeoutMs > 0, `${capability.id} 应有正超时`);
    assert.equal(typeof capability.idempotent, "boolean", `${capability.id} 应声明幂等性`);
    assert.ok(capability.degradation.length > 0, `${capability.id} 应说明降级行为`);
  }
  assert.equal(EDITOR_CAPABILITIES.find(({ id }) => id === "edit.timeline")?.support, "unsupported");
  assert.equal(EDITOR_CAPABILITIES.find(({ id }) => id === "render.output")?.support, "unsupported");
});

test("只读快照能力在在线且所有条件满足时可用", () => {
  const capability = EDITOR_CAPABILITIES.find(({ id }) => id === "read.project_snapshot")!;
  const result = assessCapability(capability.id, online, capability.prerequisites);
  assert.equal(result.available, true);
  if (result.available) assert.equal(result.capability.id, capability.id);
});

test("离线时明确不可用并返回连接原因", () => {
  const result = assessCapability("read.project_snapshot", offline);
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.reason, "offline");
    assert.equal(result.message, "模拟适配器离线");
    assert.deepEqual(result.missingPrerequisites, ["resolve_connected", "active_project", "active_timeline"]);
  }
});

test("编辑和渲染明确返回 unsupported，不会因满足条件而变为可执行", () => {
  for (const id of ["edit.timeline", "render.output"]) {
    const capability = EDITOR_CAPABILITIES.find((entry) => entry.id === id)!;
    const result = assessCapability(id, online, capability.prerequisites);
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.reason, "unsupported");
  }
});

test("条件不足、健康未知、未评估和未知能力均返回明确原因", () => {
  const missingCondition = assessCapability("verify.snapshot_mapping", online, ["snapshot_available"]);
  assert.equal(missingCondition.available, false);
  if (!missingCondition.available) {
    assert.equal(missingCondition.reason, "prerequisites_missing");
    assert.deepEqual(missingCondition.missingPrerequisites, ["mapping_rules_known"]);
  }

  const unknownHealth = assessCapability("read.health", { state: "unknown", checkedAt: "" });
  assert.equal(unknownHealth.available, false);
  if (!unknownHealth.available) assert.equal(unknownHealth.reason, "health_unknown");

  const unevaluated = assessCapability("verify.resolve_project", online);
  assert.equal(unevaluated.available, false);
  if (!unevaluated.available) assert.equal(unevaluated.reason, "unevaluated");

  const unknown = assessCapability("read.missing", online);
  assert.equal(unknown.available, false);
  if (!unknown.available) assert.equal(unknown.reason, "unknown_capability");
});

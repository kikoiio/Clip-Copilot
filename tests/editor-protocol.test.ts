import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  makeProbeRequest,
  parseResolveProbeResponse,
} from "../src/editor/resolve/protocol.ts";

const runtime = {
  version: "21.0.0-fixture",
  build: "21.0.0-fixture.001",
  edition: "free" as const,
  platform: "linux-x64" as const,
  compatibility: "supported" as const,
  checkedAt: "2026-10-11T00:00:00.000Z",
};

test("协议请求只允许健康和项目摘要操作", () => {
  assert.deepEqual(makeProbeRequest("health"), { protocolVersion: 1, operation: "health" });
  assert.deepEqual(makeProbeRequest("project_snapshot"), { protocolVersion: 1, operation: "project_snapshot" });
});

test("固定健康响应可解析且不含真实环境依赖", () => {
  const raw = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/resolve/runtime-health.json"), "utf8")) as unknown;
  const parsed = parseResolveProbeResponse(raw, "health");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.runtime.edition, "free");
});

test("项目摘要成功响应要求摘要对象", () => {
  const parsed = parseResolveProbeResponse({ ok: true, runtime, summary: { project: {}, timeline: {} } }, "project_snapshot");
  assert.equal(parsed.ok, true);
  assert.throws(() => parseResolveProbeResponse({ ok: true, runtime }, "project_snapshot"), /missing summary/);
});

test("错误响应保留分类和重试语义", () => {
  const parsed = parseResolveProbeResponse({
    ok: false,
    runtime,
    error: { kind: "offline", reason: "Resolve not running", retryable: true },
  }, "project_snapshot");
  assert.deepEqual(parsed, {
    ok: false,
    runtime,
    error: { kind: "offline", reason: "Resolve not running", retryable: true },
  });
});

test("非法响应和写操作语义被拒绝", () => {
  assert.equal(parseResolveProbeResponse({ ok: true, runtime }, "health").ok, true);
  assert.throws(() => parseResolveProbeResponse({ ok: true, runtime: { ...runtime, platform: "windows-x64" } }, "health"), /platform/);
  assert.throws(() => parseResolveProbeResponse({ ok: false, error: { kind: "write", reason: "no", retryable: false } }, "health"), /error kind/);
});

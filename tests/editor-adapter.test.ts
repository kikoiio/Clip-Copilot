import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createResolveAdapter,
  createResolveFixtureAdapter,
  RESOLVE_FIXTURE_TIMESTAMP,
} from "../src/editor/resolve/adapter.ts";
import { createResolveSupportPolicy } from "../src/editor/resolve/compatibility.ts";
import type { ResolveProbeRequest, ResolveProbeResponse } from "../src/editor/resolve/protocol.ts";

const call = { timeoutMs: 100 };

const summary = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/resolve/project-summary.json"), "utf8")) as Record<string, unknown>;

function realAdapter(response: ResolveProbeResponse): ReturnType<typeof createResolveAdapter> {
  return createResolveAdapter({
    bridge: {
      async request(request: ResolveProbeRequest): Promise<ResolveProbeResponse> {
        void request;
        return response;
      },
    },
    supportPolicy: createResolveSupportPolicy({ acceptedBuilds: ["21.0.0-fixture.001"] }),
    now: () => RESOLVE_FIXTURE_TIMESTAMP,
  });
}

test("固定夹具在线模式提供健康、能力声明和只读摘要", async () => {
  const adapter = createResolveFixtureAdapter();
  const health = await adapter.getHealth(call);
  assert.equal(health.state, "online");
  assert.equal(health.checkedAt, RESOLVE_FIXTURE_TIMESTAMP);
  assert.ok(adapter.getCapabilities().some(({ id }) => id === "read.project_snapshot"));

  const result = await adapter.readProjectSnapshot(call);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.identity.projectId, "fixture-project-001");
    assert.equal(result.value.timeBase.denominator, 1001);
    assert.equal(result.value.capturedAt, RESOLVE_FIXTURE_TIMESTAMP);
  }
});

test("在线固定输入重复读取产生相同快照", async () => {
  const adapter = createResolveFixtureAdapter();
  const first = await adapter.readProjectSnapshot(call);
  const second = await adapter.readProjectSnapshot(call);
  assert.deepEqual(second, first);
});

test("离线模式保留明确的可重试错误", async () => {
  const adapter = createResolveFixtureAdapter({ mode: "offline", offlineReason: "fixture disconnected" });
  assert.equal((await adapter.getHealth(call)).state, "offline");
  const result = await adapter.readProjectSnapshot(call);
  assert.deepEqual(result, {
    ok: false,
    error: {
      capabilityId: "read.project_snapshot",
      kind: "offline",
      reason: "fixture disconnected",
      retryable: true,
    },
  });
});

test("协议失败和不支持能力都不会进入成功路径", async () => {
  const protocol = await createResolveFixtureAdapter({ mode: "protocol", protocolReason: "fixture schema mismatch" }).readProjectSnapshot(call);
  assert.deepEqual(protocol, {
    ok: false,
    error: {
      capabilityId: "read.project_snapshot",
      kind: "protocol",
      reason: "fixture schema mismatch",
      retryable: false,
    },
  });

  const unsupported = await createResolveFixtureAdapter({ mode: "unsupported", unsupportedCapabilityId: "edit.timeline" }).readProjectSnapshot(call);
  assert.deepEqual(unsupported, {
    ok: false,
    error: {
      capabilityId: "edit.timeline",
      kind: "unsupported",
      reason: "Fixture does not support capability edit.timeline",
      retryable: false,
    },
  });
});

test("超时和取消均返回带能力标识的可重试结果", async () => {
  const slow = createResolveFixtureAdapter({ delayMs: 25 });
  const timedOut = await slow.readProjectSnapshot({ timeoutMs: 1 });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) {
    assert.equal(timedOut.error.capabilityId, "read.project_snapshot");
    assert.equal(timedOut.error.kind, "timeout");
    assert.equal(timedOut.error.retryable, true);
  }

  const controller = new AbortController();
  const pending = slow.readProjectSnapshot({ timeoutMs: 100, signal: controller.signal });
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) {
    assert.equal(cancelled.error.capabilityId, "read.project_snapshot");
    assert.equal(cancelled.error.kind, "timeout");
    assert.match(cancelled.error.reason, /cancelled/);
  }
});

test("不支持模式的能力评估不会误报为可用", () => {
  const adapter = createResolveFixtureAdapter({ mode: "unsupported" });
  const result = adapter.assess("edit.timeline");
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.reason, "unsupported");
});

test("真实适配器在兼容运行时映射只读摘要", async () => {
  const adapter = realAdapter({
    ok: true,
    runtime: {
      version: "21.0.0-fixture",
      build: "21.0.0-fixture.001",
      edition: "free",
      platform: "linux-x64",
      compatibility: "unknown",
      checkedAt: RESOLVE_FIXTURE_TIMESTAMP,
    },
    summary,
  });
  const health = await adapter.getHealth(call);
  assert.deepEqual(health, {
    state: "online",
    checkedAt: RESOLVE_FIXTURE_TIMESTAMP,
    version: "21.0.0-fixture",
    edition: "free",
  });
  const result = await adapter.readProjectSnapshot(call);
  assert.equal(result.ok, true);
  assert.equal(adapter.getRuntimeInfo()?.compatibility, "supported");
});

test("真实适配器拒绝未验证构建且不读取摘要成功", async () => {
  let snapshotCalls = 0;
  const adapter = createResolveAdapter({
    bridge: {
      async request(request: ResolveProbeRequest): Promise<ResolveProbeResponse> {
        if (request.operation === "project_snapshot") snapshotCalls += 1;
        return {
          ok: true,
          runtime: {
            version: "21.0.0-fixture",
            build: "21.0.0-unverified",
            edition: "free",
            platform: "linux-x64",
            compatibility: "unknown",
            checkedAt: RESOLVE_FIXTURE_TIMESTAMP,
          },
          ...(request.operation === "project_snapshot" ? { summary } : {}),
        };
      },
    },
    supportPolicy: createResolveSupportPolicy({ acceptedBuilds: ["21.0.0-fixture.001"] }),
  });
  const health = await adapter.getHealth(call);
  assert.equal(health.state, "unknown");
  const result = await adapter.readProjectSnapshot(call);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unsupported");
    assert.match(result.error.reason, /not been verified/);
  }
  assert.equal(snapshotCalls, 1);
});

test("真实适配器保留桥接错误分类", async () => {
  const adapter = realAdapter({
    ok: false,
    error: { kind: "offline", reason: "Resolve not running", retryable: true },
  });
  const health = await adapter.getHealth(call);
  assert.equal(health.state, "offline");
  const result = await adapter.readProjectSnapshot(call);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.error, {
    capabilityId: "read.project_snapshot",
    kind: "offline",
    reason: "Resolve not running",
    retryable: true,
  });
});

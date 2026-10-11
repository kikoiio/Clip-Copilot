import assert from "node:assert/strict";
import test from "node:test";
import type { ResolveRuntimeInfo } from "../src/editor/contracts.ts";
import {
  assessResolveRuntime,
  createResolveSupportPolicy,
  majorVersion,
} from "../src/editor/resolve/compatibility.ts";

const policy = createResolveSupportPolicy({ acceptedBuilds: ["21.0.0-fixture.001"] });

function runtime(overrides: Partial<ResolveRuntimeInfo> = {}): ResolveRuntimeInfo {
  return {
    version: "21.0.0-fixture",
    build: "21.0.0-fixture.001",
    edition: "free",
    platform: "linux-x64",
    compatibility: "unknown",
    checkedAt: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}

test("已记录的 Resolve 21.x Free Linux 构建受支持", () => {
  assert.equal(assessResolveRuntime(runtime(), policy), "supported");
  assert.equal(policy.assess(runtime()), "supported");
});

test("同主版本但未记录构建返回 unknown", () => {
  assert.equal(assessResolveRuntime(runtime({ build: "21.0.0-unverified" }), policy), "unknown");
});

test("主版本或平台不符返回 unsupported", () => {
  assert.equal(assessResolveRuntime(runtime({ version: "20.2.0" }), policy), "unsupported");
  assert.equal(assessResolveRuntime(runtime({ platform: "linux-arm64" as "linux-x64" }), policy), "unsupported");
});

test("Studio 和未知发行版不成为 Free 基线的成功条件", () => {
  assert.equal(assessResolveRuntime(runtime({ edition: "studio" }), policy), "unknown");
  assert.equal(assessResolveRuntime(runtime({ edition: "unknown" }), policy), "unknown");
});

test("版本主号解析不猜测非版本字符串", () => {
  assert.equal(majorVersion("v21.1.3"), 21);
  assert.equal(majorVersion("20"), 20);
  assert.equal(majorVersion("build-21"), null);
});

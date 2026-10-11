import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createResolveProcessBridge } from "../src/editor/resolve/bridge.ts";
import { makeProbeRequest } from "../src/editor/resolve/protocol.ts";

const runtime = {
  version: "21.0.0-fixture",
  build: "21.0.0-fixture.001",
  edition: "free",
  platform: "linux-x64",
  compatibility: "unknown",
  checkedAt: "2026-10-11T00:00:00.000Z",
};

async function fakeProbe(body: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "resolve-probe-"));
  const file = path.join(dir, "probe.mjs");
  await writeFile(file, body, "utf8");
  await chmod(file, 0o755);
  return { dir, file };
}

test("进程桥解析成功响应并传递请求操作", async () => {
  const fake = await fakeProbe(`
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({ ok: true, runtime: ${JSON.stringify(runtime)}, summary: { project: { name: request.operation } } }));
    });
  `);
  try {
    const result = await createResolveProcessBridge({ command: process.execPath, probePath: fake.file })
      .request(makeProbeRequest("project_snapshot"), { timeoutMs: 500 });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal((result.summary?.project as { name?: string }).name, "project_snapshot");
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("空输出和非零退出映射为可诊断失败", async () => {
  const fake = await fakeProbe("process.stderr.write('Resolve is not running'); process.exit(3);");
  try {
    const result = await createResolveProcessBridge({ command: process.execPath, probePath: fake.file })
      .request(makeProbeRequest("health"), { timeoutMs: 500 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, "offline");
      assert.match(result.error.reason, /not running/);
    }
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("超时和取消都会结束子进程", async () => {
  const fake = await fakeProbe("setTimeout(() => process.stdout.write('never'), 10_000);");
  try {
    const bridge = createResolveProcessBridge({ command: process.execPath, probePath: fake.file });
    const timedOut = await bridge.request(makeProbeRequest("health"), { timeoutMs: 20 });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) assert.equal(timedOut.error.kind, "timeout");

    const controller = new AbortController();
    const pending = bridge.request(makeProbeRequest("health"), { timeoutMs: 500, signal: controller.signal });
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.match(cancelled.error.reason, /cancelled/);
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("非法 JSON 映射为 protocol 错误", async () => {
  const fake = await fakeProbe("process.stdout.write('not-json');");
  try {
    const result = await createResolveProcessBridge({ command: process.execPath, probePath: fake.file })
      .request(makeProbeRequest("health"), { timeoutMs: 500 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "protocol");
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

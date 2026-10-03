import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { helperPathForModule, PythonSpiSource } from "../src/sense/atspi.ts";
import type { InstanceApp } from "../src/sense/atspi.ts";
import { openProjectInKdenlive } from "../src/sense/opener.ts";
import type { spawn } from "node:child_process";

test("Python SPI helper transport decodes NDJSON and tolerates malformed lines", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sense-spi-"));
  const helper = path.join(dir, "helper.py");
  writeFileSync(helper, [
    "import sys",
    "import json",
    "req = json.loads(sys.stdin.readline())",
    "if req.get('cmd') != 'watch' or req.get('intervalMs') != 1000:",
    "    print('{\"type\":\"error\",\"reason\":\"watch interval mismatch\"}', flush=True)",
    "    sys.exit(0)",
    "print('not-json', flush=True)",
    "print('{\"type\":\"instances\",\"apps\":[{\"pid\":41,\"title\":\"final / HD 1080p 30 fps — Kdenlive\",\"focused\":false}]}', flush=True)",
    "sys.stdin.read()",
  ].join("\n"));
  const source = new PythonSpiSource({ helperPath: helper });
  const seen: InstanceApp[][] = [];
  try {
    await source.start((apps) => seen.push(apps));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], [{ pid: 41, title: "final / HD 1080p 30 fps — Kdenlive", focused: false }]);
    assert.equal(source.degradedReason(), null);
  } finally {
    await source.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real SPI helper reports missing session bus as a clean degraded event", () => {
  const result = spawnSync("python3", [path.resolve("src/sense/spi-helper.py")], {
    input: '{"cmd":"poll"}\n',
    encoding: "utf8",
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "" },
  });
  assert.equal(result.status, 0);
  const event = JSON.parse(result.stdout.trim()) as { type: string; reason: string };
  assert.equal(event.type, "error");
  assert.match(event.reason, /DBUS_SESSION_BUS_ADDRESS/u);
});

test("compiled GUI locates the source helper even though tsc does not copy Python files", () => {
  const compiledModule = path.resolve("dist/src/sense/atspi.js");
  const helper = helperPathForModule(compiledModule);
  assert.equal(helper, path.resolve("src/sense/spi-helper.py"));
  assert.equal(existsSync(helper), true);
});

test("authorized opener handles existing, missing and successful project cases with evidence", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sense-open-"));
  const projects = path.join(dir, "projects");
  mkdirSync(projects);
  let spawnCalls = 0;
  const fakeSpawn = ((..._args: unknown[]) => {
    spawnCalls++;
    const child = new EventEmitter() as EventEmitter & { pid: number; unref(): void };
    child.pid = 999;
    child.unref = () => undefined;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof spawn;
  const failingSpawn = ((..._args: unknown[]) => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("ENOENT")));
    return child;
  }) as unknown as typeof spawn;
  try {
    const missing = await openProjectInKdenlive(dir, { runningInstances: [], appImagePath: "/fake/Kdenlive.AppImage", spawnImpl: fakeSpawn });
    assert.equal(missing.ok, false);
    assert.equal(spawnCalls, 0);

    writeFileSync(path.join(projects, "final.kdenlive"), "<project/>");
    const existing = await openProjectInKdenlive(dir, {
      runningInstances: [{ projectBasename: "final", projectPath: null }],
      appImagePath: "/fake/Kdenlive.AppImage", spawnImpl: fakeSpawn,
    });
    assert.match(existing.message, /未重复打开/u);
    assert.equal(spawnCalls, 0);

    const appMissing = await openProjectInKdenlive(dir, {
      runningInstances: [], appImagePath: "/missing/Kdenlive.AppImage", spawnImpl: failingSpawn,
    });
    assert.equal(appMissing.ok, false);
    assert.match(appMissing.message, /ENOENT/u);
    assert.equal(existsSync(path.join(dir, "evidence")), false);

    const opened = await openProjectInKdenlive(dir, {
      runningInstances: [], appImagePath: "/fake/Kdenlive.AppImage", spawnImpl: fakeSpawn,
      now: () => new Date("2026-10-03T00:00:00Z"),
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.pid, 999);
    const evidenceDir = path.join(dir, "evidence");
    const evidence = readFileSync(path.join(evidenceDir, readdirSync(evidenceDir)[0]!), "utf8");
    assert.match(evidence, /open_project/u);
    assert.match(evidence, /final\.kdenlive/u);
    assert.equal(spawnCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 阶段 5 标题解析与实例→工作区映射单测（task.md T4）。
 * 标题样本取自 2026-10-03 探针实测（plan.md 探针结论 2）。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapInstances, parseTitle } from "../src/sense/mapping.ts";
import type { SpiObservation } from "../src/sense/types.ts";

const obs = (over: Partial<SpiObservation> = {}): SpiObservation => ({
  pid: 100,
  title: "final */ HD 1080p 30 fps — Kdenlive",
  focused: false,
  cmdlineProjectPath: null,
  ...over,
});

test("parseTitle：探针实测标题 → basename 与脏标记", () => {
  assert.deepEqual(parseTitle("final */ HD 1080p 30 fps — Kdenlive"), { basename: "final", dirty: true });
  assert.deepEqual(parseTitle("final / HD 1080p 30 fps — Kdenlive"), { basename: "final", dirty: false });
  assert.deepEqual(parseTitle("edit-869f35105065b1ac-a1 / HD 1080p 30 fps — Kdenlive"), {
    basename: "edit-869f35105065b1ac-a1",
    dirty: false,
  });
});

test("parseTitle：占位帧与非 Kdenlive 标题返回 null", () => {
  assert.equal(parseTitle("Offscreen"), null);
  assert.equal(parseTitle(""), null);
  assert.equal(parseTitle("未保存的文档 — 文本编辑器"), null);
  assert.deepEqual(parseTitle("final — Kdenlive"), { basename: "final", dirty: null });
});

test("mapInstances：cmdline 路径优先绑定（basename 一致才可信）", () => {
  const root = mkWorkspace(["alpha", "beta"], ["final", "intro"]);
  const r = mapInstances(
    [obs({ title: "intro / HD 1080p 30 fps — Kdenlive", cmdlineProjectPath: path.join(root, "beta", "projects", "intro.kdenlive") })],
    root,
    basenames(root),
  );
  assert.equal(r[0]!.workspaceDir, path.join(root, "beta"));
  assert.equal(r[0]!.matchedBy, "cmdline");
  rmSync(root, { recursive: true, force: true });
});

test("mapInstances：cmdline 与标题不一致视为陈旧，回退 basename 匹配", () => {
  const root = mkWorkspace(["alpha", "beta"], ["final", "intro"]);
  const r = mapInstances(
    [obs({ cmdlineProjectPath: path.join(root, "beta", "projects", "intro.kdenlive") })],
    root,
    basenames(root),
  );
  assert.equal(r[0]!.workspaceDir, path.join(root, "alpha"));
  assert.equal(r[0]!.matchedBy, "basename");
  rmSync(root, { recursive: true, force: true });
});

test("mapInstances：cmdline 指向工作区外时回退 basename 匹配", () => {
  const root = mkWorkspace(["alpha"], ["final"]);
  const r = mapInstances([obs({ cmdlineProjectPath: "/home/neo/视频/final.kdenlive" })], root, basenames(root));
  assert.equal(r[0]!.workspaceDir, path.join(root, "alpha"));
  assert.equal(r[0]!.matchedBy, "basename");
  rmSync(root, { recursive: true, force: true });
});

test("mapInstances：basename 唯一匹配", () => {
  const root = mkWorkspace(["alpha", "beta"], ["final", "intro"]);
  const r = mapInstances([obs({ title: "intro / HD 1080p 30 fps — Kdenlive" })], root, basenames(root));
  assert.equal(r[0]!.workspaceDir, path.join(root, "beta"));
  assert.equal(r[0]!.matchedBy, "basename");
  rmSync(root, { recursive: true, force: true });
});

test("mapInstances：同名工程多义时不猜", () => {
  const root = mkWorkspace(["alpha", "beta"], ["final", "final"]);
  const r = mapInstances([obs({ title: "final / HD 1080p 30 fps — Kdenlive" })], root, basenames(root));
  assert.equal(r[0]!.workspaceDir, null);
  assert.equal(r[0]!.unresolvedReason, "ambiguous");
  rmSync(root, { recursive: true, force: true });
});

test("mapInstances：无匹配工程标记 unmatched", () => {
  const root = mkWorkspace(["alpha"], ["intro"]);
  const r = mapInstances([obs({ title: "other / HD 1080p 30 fps — Kdenlive" })], root, basenames(root));
  assert.equal(r[0]!.workspaceDir, null);
  assert.equal(r[0]!.unresolvedReason, "unmatched");
  rmSync(root, { recursive: true, force: true });
});

test("mapInstances：多实例各归各的工作区", () => {
  const root = mkWorkspace(["alpha", "beta"], ["final", "intro"]);
  const r = mapInstances(
    [
      obs({ pid: 1, cmdlineProjectPath: path.join(root, "alpha", "projects", "final.kdenlive") }),
      obs({ pid: 2, title: "intro / HD 1080p 30 fps — Kdenlive" }),
    ],
    root,
    basenames(root),
  );
  assert.equal(r[0]!.workspaceDir, path.join(root, "alpha"));
  assert.equal(r[1]!.workspaceDir, path.join(root, "beta"));
  rmSync(root, { recursive: true, force: true });
});

/* ---------- 测试脚手架 ---------- */

function mkWorkspace(dirs: string[], projects: string[]): string {
  const root = path.join(os.tmpdir(), `acc-p5-map-${Date.now()}-${process.pid}`);
  dirs.forEach((dir, i) => {
    const projectDir = path.join(root, dir, "projects");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, `${projects[i]}.kdenlive`), "<xml/>");
  });
  return root;
}

function basenames(root: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const dir of ["alpha", "beta"]) {
    try {
      const files = readdirSync(path.join(root, dir, "projects"));
      map.set(
        path.join(root, dir),
        new Set(files.filter((f) => f.endsWith(".kdenlive")).map((f) => f.slice(0, -".kdenlive".length))),
      );
    } catch {
      map.set(path.join(root, dir), new Set());
    }
  }
  return map;
}

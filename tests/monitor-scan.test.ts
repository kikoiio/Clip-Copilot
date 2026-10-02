import assert from "node:assert/strict";
import { open, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_MONITOR_CONFIG, type FileChange, type WorkspaceSnapshot } from "../src/monitor/types.ts";
import { MAX_SCAN_ENTRIES, diffSnapshots, scanWorkspace, watchWorkspace } from "../src/monitor/scan.ts";

async function fixture(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-scan-"));
  try { await run(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("等待监测变化超时")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("T6: only configured ordinary files and relevant evidence enter the snapshot", async () => {
  await fixture(async (dir) => {
    const outside = await mkdtemp(path.join(tmpdir(), "monitor-outside-"));
    try {
      for (const subdir of ["assets", "projects", "outputs", "evidence", "checkpoints", ".monitor"]) {
        await mkdir(path.join(dir, subdir));
      }
      await writeFile(path.join(dir, "state.json"), JSON.stringify({ revision: 7 }));
      await writeFile(path.join(dir, "handoff.md"), "derived");
      await writeFile(path.join(dir, "assets", "clip.mp4"), "clip");
      await writeFile(path.join(dir, "assets", ".clip.tmp-12"), "partial");
      await writeFile(path.join(dir, "projects", "score.mmp"), "project");
      await writeFile(path.join(dir, "projects", "notes.txt"), "ignore");
      await writeFile(path.join(dir, "outputs", "preview.mp4"), "render");
      await writeFile(path.join(dir, "evidence", "lmms-render-score.json"), "{}");
      await writeFile(path.join(dir, "evidence", "check-report-artifact-001-12.json"), "{}");
      await writeFile(path.join(dir, "evidence", "asset-sources.json"), "{}");
      await writeFile(path.join(dir, "checkpoints", "old.mp4"), "frozen");
      await writeFile(path.join(dir, ".monitor", "state.json"), "internal");
      await writeFile(path.join(outside, "secret.mp4"), "secret");
      await symlink(path.join(outside, "secret.mp4"), path.join(dir, "assets", "external.mp4"));
      await symlink(outside, path.join(dir, "assets", "external-directory"));
      const snapshot = await scanWorkspace(dir, DEFAULT_MONITOR_CONFIG);
      assert.deepEqual(Object.keys(snapshot.files).sort(), [
        "assets/clip.mp4",
        "evidence/check-report-artifact-001-12.json",
        "evidence/lmms-render-score.json",
        "outputs/preview.mp4",
        "projects/score.mmp",
        "state.json",
      ]);
      assert.equal(snapshot.stateRevision, 7);
      assert.ok(Object.values(snapshot.files).every((stamp) => stamp.sha256 === undefined));
      const assetsOnly = await scanWorkspace(dir, { ...DEFAULT_MONITOR_CONFIG, scopes: ["assets"] });
      assert.deepEqual(Object.keys(assetsOnly.files), ["assets/clip.mp4"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("T6: large media is represented by metadata without reading bytes", async () => {
  await fixture(async (dir) => {
    await mkdir(path.join(dir, "assets"));
    const file = await open(path.join(dir, "assets", "large.mp4"), "w");
    try { await file.truncate(192 * 1024 * 1024); }
    finally { await file.close(); }
    const before = process.memoryUsage().heapUsed;
    const first = await scanWorkspace(dir, DEFAULT_MONITOR_CONFIG);
    const second = await scanWorkspace(dir, DEFAULT_MONITOR_CONFIG, first);
    const growth = process.memoryUsage().heapUsed - before;
    assert.equal(first.files["assets/large.mp4"]?.size, 192 * 1024 * 1024);
    assert.deepEqual(diffSnapshots(first, second), []);
    assert.ok(growth < 32 * 1024 * 1024, `扫描堆增长过大：${growth}`);
  });
});

test("T6: bounded traversal fails before returning a partial snapshot", async () => {
  await fixture(async (dir) => {
    await mkdir(path.join(dir, "assets"));
    for (let i = 0; i <= MAX_SCAN_ENTRIES; i++) {
      await writeFile(path.join(dir, "assets", `file-${i}`), "");
    }
    await assert.rejects(
      () => scanWorkspace(dir, DEFAULT_MONITOR_CONFIG),
      new RegExp(`超过 ${MAX_SCAN_ENTRIES} 个目录项`),
    );
  });
});

test("T7: deterministic add/remove/modify diff; removal and later re-creation remain distinct", () => {
  const stamp = (size: number) => ({ size, mtimeMs: size });
  const snapshot = (files: WorkspaceSnapshot["files"]): WorkspaceSnapshot => ({
    scannedAt: "2026-10-03T00:00:00.000Z", stateRevision: 0, files,
  });
  const before = snapshot({ "assets/a.mp4": stamp(1), "assets/b.mp4": stamp(1) });
  const after = snapshot({ "assets/b.mp4": stamp(2), "assets/c.mp4": stamp(1) });
  assert.deepEqual(diffSnapshots(before, after).map((change) => [change.path, change.kind]), [
    ["assets/a.mp4", "removed"], ["assets/b.mp4", "modified"], ["assets/c.mp4", "added"],
  ]);
  assert.deepEqual(diffSnapshots(before, snapshot({ "assets/b.mp4": stamp(1) })).map((c) => c.kind), ["removed"]);
  assert.deepEqual(diffSnapshots(snapshot({ "assets/b.mp4": stamp(1) }), before).map((c) => c.kind), ["added"]);
});

test("T7/T8: file events merge consecutive writes and watcher closes cleanly", async () => {
  await fixture(async (dir) => {
    await mkdir(path.join(dir, "assets"));
    const baseline = await scanWorkspace(dir, DEFAULT_MONITOR_CONFIG);
    const seen: FileChange[][] = [];
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const handle = await watchWorkspace(dir, DEFAULT_MONITOR_CONFIG, baseline, async (changes) => {
      seen.push(changes);
      resolveFirst();
    }, { stableMs: 80, reconcileMs: 500 });
    try {
      const file = path.join(dir, "assets", "clip.mp4");
      await writeFile(file, "part one");
      await new Promise((resolve) => setTimeout(resolve, 35));
      await writeFile(file, "final version");
      await waitFor(first);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0]!.map((change) => [change.path, change.kind, change.after?.size]), [
        ["assets/clip.mp4", "added", Buffer.byteLength("final version")],
      ]);
    } finally { await handle.close(); }
    await writeFile(path.join(dir, "assets", "later.mp4"), "no watcher");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(seen.length, 1);
  });
});

test("T8: reconciliation finds a change made before watcher registration without any event", async () => {
  await fixture(async (dir) => {
    await mkdir(path.join(dir, "assets"));
    const baseline = await scanWorkspace(dir, DEFAULT_MONITOR_CONFIG);
    await writeFile(path.join(dir, "assets", "offline.mp4"), "after baseline");
    let resolveFirst!: (changes: FileChange[]) => void;
    const first = new Promise<FileChange[]>((resolve) => { resolveFirst = resolve; });
    const handle = await watchWorkspace(dir, DEFAULT_MONITOR_CONFIG, baseline, async (changes) => {
      resolveFirst(changes);
    }, { stableMs: 30, reconcileMs: 100 });
    try {
      const changes = await waitFor(first);
      assert.deepEqual(changes.map((change) => [change.path, change.kind]), [["assets/offline.mp4", "added"]]);
    } finally { await handle.close(); }
  });
});

test("T8: newly created nested directory is watched; removal and recreation are separate", async () => {
  await fixture(async (dir) => {
    await mkdir(path.join(dir, "assets"));
    const baseline = await scanWorkspace(dir, DEFAULT_MONITOR_CONFIG);
    const seen: FileChange[] = [];
    const handle = await watchWorkspace(dir, DEFAULT_MONITOR_CONFIG, baseline, async (changes) => {
      seen.push(...changes);
    }, { stableMs: 25, reconcileMs: 1_000 });
    try {
      const nested = path.join(dir, "assets", "new", "deep");
      await mkdir(nested, { recursive: true });
      const file = path.join(nested, "clip.mp4");
      await writeFile(file, "first");
      const until = Date.now() + 2_000;
      while (seen.length < 1 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(seen.map((change) => change.kind), ["added"]);
      await rm(file);
      while (seen.length < 2 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(seen.map((change) => change.kind), ["added", "removed"]);
      await writeFile(file, "second");
      while (seen.length < 3 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(seen.map((change) => change.kind), ["added", "removed", "added"]);
    } finally { await handle.close(); }
  });
});

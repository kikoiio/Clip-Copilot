import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssetRecord, ArtifactRecord, WorkspaceState } from "../src/domain.ts";
import { watchWorkspaces } from "../src/monitor/engine.ts";
import { loadMonitorState, updateMonitorState } from "../src/monitor/store.ts";
import { emptyState, saveState, sha256File } from "../src/workspace/store.ts";

async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("等待监测条件超时");
}

interface Fixture {
  dir: string;
  state: WorkspaceState;
  save: () => Promise<void>;
}

/** Empty workspace with directories, optional handoff.md and an unsaved creative state. */
async function fixture(prefix: string, withHandoff: boolean): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), `monitor-integration-${prefix}-`));
  for (const sub of ["assets", "projects", "outputs", "evidence"]) await mkdir(path.join(dir, sub));
  if (withHandoff) await writeFile(path.join(dir, "handoff.md"), "handoff\n");
  const state = emptyState({
    title: `集成演练 ${prefix}`, theme: "山间清晨", minFrames: 30, maxFrames: 300,
    outputSpec: { width: 1920, height: 1080, fps: 30 }, moodArc: [],
  });
  return {
    dir,
    state,
    save: async () => { await saveState(dir, state, 0); },
  };
}

function assetRecord(id: string, file: string, sha256: string, bytes: number): AssetRecord {
  return {
    id, localPath: file, sha256, bytes, sourceUrl: "https://example.com/source",
    licenseUrl: "https://example.com/license", licenseCheckedAt: "2026-01-01T00:00:00Z",
    media: { durationMs: 1000, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: false },
  };
}

function artifactRecord(id: string, kind: ArtifactRecord["kind"], file: string, sha256: string, basedOn: string[] = []): ArtifactRecord {
  return { id, kind, path: file, sha256, basedOn, status: "draft", createdAt: "2026-01-01T00:00:00Z" };
}

test("T26: per-workspace injections stay isolated and offline changes are found exactly once after restart", async () => {
  const a = await fixture("asset-side", true);
  const b = await fixture("project-side", true);
  try {
    // A: registered asset with a dependent preview artifact, both matching disk content.
    const drums = path.join(a.dir, "assets", "drums.wav");
    await writeFile(drums, "one");
    const preview = path.join(a.dir, "outputs", "preview.mp4");
    await writeFile(preview, "preview-bytes");
    a.state.assets.push(assetRecord("a1", "assets/drums.wav", await sha256File(drums), 3));
    a.state.artifacts.push(artifactRecord("out1", "video_preview", "outputs/preview.mp4", await sha256File(preview), ["a1"]));
    await a.save();
    await b.save();

    const stop = new AbortController();
    const run = watchWorkspaces([b.dir, a.dir], stop.signal, { stableMs: 30, reconcileMs: 100 });
    try {
      await eventually(async () => !!(await loadMonitorState(a.dir)).baseline && !!(await loadMonitorState(b.dir)).baseline);
      await writeFile(drums, "changed-audio");
      await writeFile(path.join(b.dir, "assets", "field-recording.mp4"), "unregistered");
      await writeFile(path.join(b.dir, "projects", "theme.mmp"), '<lmms-project version="1.2"></lmms-project>');
      await eventually(async () => {
        const sa = await loadMonitorState(a.dir);
        const sb = await loadMonitorState(b.dir);
        return sa.suggestions.some((s) => s.key === "asset_changed:a1")
          && sb.suggestions.some((s) => s.key === "asset_added:assets/field-recording.mp4")
          && sb.suggestions.some((s) => s.key === "project_changed:projects/theme.mmp");
      });
      const sa = await loadMonitorState(a.dir);
      const sb = await loadMonitorState(b.dir);
      assert.ok(sa.suggestions.some((s) => s.key === "asset_changed:a1" && s.priority === "high" && s.impact.includes("out1")));
      assert.ok(!sa.suggestions.some((s) => s.category === "asset_added" || s.category === "project_changed"));
      const added = sb.suggestions.find((s) => s.key === "asset_added:assets/field-recording.mp4");
      assert.equal(added?.disposition, "question");
      assert.match(added?.evidence ?? "", /field-recording\.mp4/);
      assert.ok(sb.suggestions.some((s) => s.key === "project_changed:projects/theme.mmp" && s.category === "project_changed"));
      assert.ok(!sb.suggestions.some((s) => s.category === "asset_changed" || s.category === "asset_missing"));
      assert.equal(sa.metrics.notificationAttempts, 0);
      assert.equal(sb.metrics.notificationAttempts, 0);
    } finally { stop.abort(); await run; }

    // Offline edit while no monitor runs; the next start must report it once.
    await writeFile(drums, "offline-edit");
    const restart = new AbortController();
    const rerun = watchWorkspaces([a.dir], restart.signal, { stableMs: 30, reconcileMs: 100 });
    try {
      await eventually(async () =>
        (await loadMonitorState(a.dir)).suggestions.some((s) => s.key === "asset_changed:a1" && s.evidence.includes("现 12 字节")));
      await new Promise((resolve) => setTimeout(resolve, 250)); // let extra reconcile cycles pass
      const after = await loadMonitorState(a.dir);
      assert.equal(after.suggestions.filter((s) => s.key === "asset_changed:a1").length, 1);
      assert.equal(after.metrics.notificationAttempts, 0);
      assert.equal(after.baseline?.files["assets/drums.wav"]?.size, 12);
      const untouched = await loadMonitorState(b.dir);
      assert.deepEqual(untouched.suggestions.map((s) => s.category).sort(), ["asset_added", "project_changed"]);
    } finally { restart.abort(); await rerun; }
  } finally {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  }
});

test("T27: offline reference loss notifies once and resolves after repair; authorized rebuild restores handoff", async () => {
  const w1 = await fixture("notify-side", true);
  const w2 = await fixture("repair-side", false);
  try {
    // W1: valid project whose only reference exists; registered asset + project artifact.
    const media = path.join(w1.dir, "assets", "gone.mp4");
    await writeFile(media, "media-bytes");
    const project = path.join(w1.dir, "projects", "song.kdenlive");
    await writeFile(project, '<mlt><property name="resource">../assets/gone.mp4</property></mlt>');
    w1.state.assets.push(assetRecord("a1", "assets/gone.mp4", await sha256File(media), 11));
    w1.state.artifacts.push(artifactRecord("p1", "kdenlive_project", "projects/song.kdenlive", await sha256File(project), ["a1"]));
    await w1.save();
    await w2.save();

    const calls: { title: string; body: string }[] = [];
    const sender = async (title: string, body: string): Promise<void> => { calls.push({ title, body }); };

    const firstStop = new AbortController();
    const firstRun = watchWorkspaces([w1.dir], firstStop.signal, { stableMs: 30, reconcileMs: 100, notificationSender: sender });
    try {
      await eventually(async () => !!(await loadMonitorState(w1.dir)).baseline);
      assert.equal((await loadMonitorState(w1.dir)).metrics.notificationAttempts, 0);
    } finally { firstStop.abort(); await firstRun; }

    await rm(media); // offline reference loss
    const stop = new AbortController();
    const run = watchWorkspaces([w2.dir, w1.dir], stop.signal, { stableMs: 30, reconcileMs: 100, notificationSender: sender });
    try {
      await eventually(async () => {
        const state = await loadMonitorState(w1.dir);
        return state.metrics.notificationSent === 2
          && state.suggestions.filter((s) => s.notificationResult === "sent").length === 2;
      });
      // Removing a required asset both breaks the project reference and blocks the
      // current "assets" stage — two independent high-priority notifications.
      const mid = await loadMonitorState(w1.dir);
      const reference = mid.suggestions.find((s) => s.key === "reference_missing:p1");
      assert.equal(reference?.notificationResult, "sent");
      assert.equal(reference?.priority, "high");
      assert.equal(mid.suggestions.find((s) => s.key === "stage_blocked:assets")?.notificationResult, "sent");
      assert.equal(calls.length, 2);
      assert.equal(mid.metrics.notificationAttempts, 2);
      assert.equal(mid.metrics.notificationSent, 2);
      // asset_missing is high priority but not a desktop-notification category.
      assert.ok(mid.suggestions.find((s) => s.key === "asset_missing:a1")?.notificationAttemptedAt === undefined);
      // W2 unauthorized: suggestion only, no silent rebuild.
      const unauthorized = await loadMonitorState(w2.dir);
      assert.equal(unauthorized.suggestions.find((s) => s.category === "handoff_missing")?.status, "open");
      assert.equal(await stat(path.join(w2.dir, "handoff.md")).then(() => true, () => false), false);

      // Authorize rebuild; the running monitor applies it on its next config poll.
      await updateMonitorState(w2.dir, (state) => { state.config.autoRepairHandoff = true; return state; });
      await eventually(async () => (await loadMonitorState(w2.dir)).repairs.length >= 1);
      const rebuilt = await loadMonitorState(w2.dir);
      assert.equal(rebuilt.repairs.length, 1);
      assert.equal(rebuilt.repairs[0]?.result, "verified");
      const content = await readFile(path.join(w2.dir, "handoff.md"), "utf8");
      assert.match(content, /revision 1/);
      assert.match(content, /主动建议/);
      assert.equal(rebuilt.suggestions.find((s) => s.category === "handoff_missing")?.status, "resolved");
      assert.equal(rebuilt.metrics.notificationAttempts, 0);

      // Repair the reference; both related suggestions resolve without a second notification.
      await writeFile(media, "media-bytes");
      await eventually(async () =>
        (await loadMonitorState(w1.dir)).suggestions.find((s) => s.key === "reference_missing:p1")?.status === "resolved");
      const fixed = await loadMonitorState(w1.dir);
      assert.equal(fixed.suggestions.find((s) => s.key === "reference_missing:p1")?.status, "resolved");
      assert.equal(fixed.suggestions.find((s) => s.key === "asset_missing:a1")?.status, "resolved");
      assert.ok(fixed.metrics.resolved >= 3);
      assert.equal(fixed.metrics.notificationAttempts, 2);
      assert.equal(calls.length, 2);
    } finally { stop.abort(); await run; }

    // Restart after resolution: no duplicate suggestions, no repeated notification.
    const restart = new AbortController();
    const rerun = watchWorkspaces([w1.dir], restart.signal, { stableMs: 20, reconcileMs: 80, notificationSender: sender });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = await loadMonitorState(w1.dir);
      assert.equal(after.suggestions.filter((s) => s.key === "reference_missing:p1").length, 1);
      assert.equal(after.suggestions.find((s) => s.key === "reference_missing:p1")?.status, "resolved");
      assert.equal(after.metrics.notificationAttempts, 2);
      assert.equal(calls.length, 2);
    } finally { restart.abort(); await rerun; }
  } finally {
    await rm(w1.dir, { recursive: true, force: true });
    await rm(w2.dir, { recursive: true, force: true });
  }
});
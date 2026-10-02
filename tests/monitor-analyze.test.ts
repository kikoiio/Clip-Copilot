import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ArtifactRecord, AssetRecord, WorkspaceState } from "../src/domain.ts";
import { analyzeChanges } from "../src/monitor/analyze.ts";
import type { FileChange, WorkspaceSnapshot } from "../src/monitor/types.ts";
import { emptyState, sha256File } from "../src/workspace/store.ts";

async function workspace(): Promise<{ dir: string; state: WorkspaceState; close: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-analyze-"));
  for (const sub of ["assets", "projects", "outputs", "evidence"]) await mkdir(path.join(dir, sub));
  await writeFile(path.join(dir, "handoff.md"), "handoff\n");
  const state = emptyState({
    title: "test", theme: "test", minFrames: 30, maxFrames: 300,
    outputSpec: { width: 1920, height: 1080, fps: 30 }, moodArc: [],
  });
  return { dir, state, close: () => rm(dir, { recursive: true, force: true }) };
}

async function snapshot(dir: string, files: string[], revision = 0): Promise<WorkspaceSnapshot> {
  const stamps: WorkspaceSnapshot["files"] = {};
  for (const file of files) {
    const info = await stat(path.join(dir, file));
    stamps[file] = { size: info.size, mtimeMs: info.mtimeMs };
  }
  return { scannedAt: new Date().toISOString(), stateRevision: revision, files: stamps };
}

function change(file: string, kind: FileChange["kind"] = "modified"): FileChange {
  return { path: file, kind };
}

function asset(id: string, file: string, sha256: string): AssetRecord {
  return { id, localPath: file, sha256, bytes: 4, sourceUrl: "https://example.com/source",
    licenseUrl: "https://example.com/license", licenseCheckedAt: "2026-01-01T00:00:00Z",
    media: { durationMs: 1000, width: 1920, height: 1080, fps: 30, hasAudio: false, hasVideo: true } };
}

function artifact(id: string, kind: ArtifactRecord["kind"], file: string, sha256: string, basedOn: string[] = []): ArtifactRecord {
  return { id, kind, path: file, sha256, basedOn, status: "draft", createdAt: "2026-01-01T00:00:00Z" };
}

test("new, missing and modified assets include stable keys and dependent artifact impact", async () => {
  const ws = await workspace();
  try {
    await writeFile(path.join(ws.dir, "assets/new.bin"), "new");
    await writeFile(path.join(ws.dir, "assets/used.bin"), "changed");
    ws.state.assets.push(asset("a1", "assets/missing.bin", "old"), asset("a2", "assets/used.bin", "old"));
    ws.state.artifacts.push(artifact("out1", "video_preview", "outputs/preview.mp4", "old", ["a1", "a2"]));
    const snap = await snapshot(ws.dir, ["assets/new.bin", "assets/used.bin"]);
    const result = await analyzeChanges(ws.dir, ws.state, snap, [change("assets/new.bin", "added"), change("assets/missing.bin", "removed"), change("assets/used.bin")], false);
    assert.equal(result.findings.find((f) => f.key === "asset_added:assets/new.bin")?.disposition, "question");
    const missing = result.findings.find((f) => f.key === "asset_missing:a1");
    assert.equal(missing?.priority, "high");
    assert.match(missing?.impact ?? "", /out1/);
    assert.equal(result.findings.find((f) => f.key === "asset_changed:a2")?.priority, "high");
    assert.ok(result.checkedKeys.includes("asset_missing:a2"));
    assert.ok(!result.checkedKeys.includes("asset_missing:unrelated"));
  } finally { await ws.close(); }
});

test("project edit, broken reference and malformed XML classify independently without modifying project", async () => {
  const ws = await workspace();
  try {
    const file = "projects/edit.kdenlive";
    const project = '<mlt><property name="resource">../assets/lost.mp4</property></mlt>';
    await writeFile(path.join(ws.dir, file), project);
    ws.state.artifacts.push(artifact("p1", "kdenlive_project", file, "old"));
    let result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [file]), [change(file)], false);
    assert.ok(result.findings.some((f) => f.key === "project_changed:p1"));
    assert.equal(result.findings.find((f) => f.key === "reference_missing:p1")?.priority, "high");
    assert.equal(await readFile(path.join(ws.dir, file), "utf8"), project);
    await writeFile(path.join(ws.dir, "assets/lost.mp4"), "restored");
    result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [file, "assets/lost.mp4"]), [change(file)], false);
    assert.ok(result.checkedKeys.includes("reference_missing:p1"));
    assert.ok(!result.findings.some((f) => f.key === "reference_missing:p1"));
    await writeFile(path.join(ws.dir, file), "<mlt><bad></mlt>");
    result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [file]), [change(file)], false);
    assert.equal(result.findings.find((f) => f.key === "project_invalid:p1")?.disposition, "question");
  } finally { await ws.close(); }
});

test("registered output and render evidence distinguish changed, failed, absent, malformed and oversized", async () => {
  const ws = await workspace();
  try {
    const output = "outputs/preview.wav";
    const runFile = "evidence/lmms-render-preview.json";
    await writeFile(path.join(ws.dir, output), "different");
    ws.state.artifacts.push(artifact("audio1", "audio_preview", output, "old"));
    let result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [output]), [change(output)], false);
    assert.ok(result.findings.some((f) => f.key === "artifact_changed:audio1"));
    await writeFile(path.join(ws.dir, runFile), JSON.stringify({ args: ["render", "projects/song.mmp", "-o", path.join(ws.dir, output)], exitCode: 1, timedOut: false, stderr: "failed" }));
    result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [runFile]), [change(runFile, "added")], false);
    assert.equal(result.findings.find((f) => f.key === `render_failed:${runFile}`)?.priority, "high");
    await writeFile(path.join(ws.dir, runFile), JSON.stringify({ args: ["render", "projects/song.mmp", "-o", path.join(ws.dir, "outputs/absent.wav")], exitCode: 0, timedOut: false }));
    result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [runFile]), [change(runFile)], false);
    assert.ok(result.findings.some((f) => f.key === `render_failed:${runFile}`));
    await writeFile(path.join(ws.dir, runFile), "{broken");
    result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [runFile]), [change(runFile)], false);
    assert.equal(result.findings.find((f) => f.key === `analysis_error:render:${runFile}`)?.disposition, "question");
    await writeFile(path.join(ws.dir, runFile), " ".repeat(2 * 1024 * 1024 + 1));
    result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [runFile]), [change(runFile)], false);
    assert.match(result.findings.find((f) => f.key === `analysis_error:render:${runFile}`)?.evidence ?? "", /超过分析上限/);
  } finally { await ws.close(); }
});

test("only current unwaived report blocks stage; waiver and pending review clear it", async () => {
  const ws = await workspace();
  try {
    ws.state.phase = "score_review";
    ws.state.issues.push({ at: "2025-01-01", kind: "old", evidence: "old fail", action: "old", result: "old" });
    ws.state.checkpoints.push({ id: "cp1", phase: "score_review", createdAt: "2026-01-01", artifactIds: ["audio1"], summary: "test", nextAction: "review", review: "pending" });
    const output = "outputs/preview.wav";
    await writeFile(path.join(ws.dir, output), "data");
    ws.state.artifacts.push(artifact("audio1", "audio_preview", output, await sha256File(path.join(ws.dir, output))));
    const reportFile = "evidence/check-report-audio1-1760000000000.json";
    await writeFile(path.join(ws.dir, reportFile), JSON.stringify({ results: [{ id: "deep:audio:clip", status: "fail", evidence: "clipping" }] }));
    let result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [output, reportFile]), [change(reportFile)], false);
    assert.equal(result.findings.find((f) => f.key === "stage_blocked:score_review")?.priority, "high");
    ws.state.waivers = [{ at: "2026-01-01", checkId: "deep:audio:clip", artifactId: "audio1", reason: "accepted" }];
    result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, [output, reportFile]), [change("state.json")], false);
    assert.ok(result.checkedKeys.includes("stage_blocked:score_review"));
    assert.ok(!result.findings.some((f) => f.category === "stage_blocked"));
    assert.ok(!result.findings.some((f) => f.evidence.includes("old fail")));
  } finally { await ws.close(); }
});

test("healthy recheck includes prior candidate keys, while unrelated findings remain unchecked", async () => {
  const ws = await workspace();
  try {
    await writeFile(path.join(ws.dir, "assets/used.bin"), "okay");
    ws.state.assets.push(asset("a1", "assets/used.bin", await sha256File(path.join(ws.dir, "assets/used.bin"))));
    const result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, ["assets/used.bin"]), [change("assets/used.bin")], false);
    assert.ok(result.checkedKeys.includes("asset_missing:a1"));
    assert.ok(result.checkedKeys.includes("asset_changed:a1"));
    assert.ok(!result.findings.some((f) => f.key === "asset_missing:a1" || f.key === "asset_changed:a1"));
    assert.ok(!result.checkedKeys.includes("project_changed:unrelated"));
  } finally { await ws.close(); }
});

test("historical reports and disabled scan scopes do not create a current stage blocker", async () => {
  const ws = await workspace();
  try {
    ws.state.phase = "video_review";
    await writeFile(path.join(ws.dir, "outputs/current.mp4"), "current");
    ws.state.artifacts.push(
      { ...artifact("old", "video_preview", "outputs/old.mp4", "old"), createdAt: "2025-01-01T00:00:00Z" },
      { ...artifact("current", "video_preview", "outputs/current.mp4", await sha256File(path.join(ws.dir, "outputs/current.mp4"))), createdAt: "2026-01-01T00:00:00Z" },
    );
    await writeFile(path.join(ws.dir, "evidence/check-report-old-1760000000000.json"), JSON.stringify({ results: [{ id: "deep:old", status: "fail", evidence: "historical fail" }] }));
    const result = await analyzeChanges(ws.dir, ws.state, await snapshot(ws.dir, ["evidence/check-report-old-1760000000000.json"]), [change("state.json")], false);
    assert.ok(!result.findings.some((f) => f.category === "stage_blocked"));
    assert.ok(result.checkedKeys.includes("stage_blocked:video_review"));
  } finally { await ws.close(); }
});

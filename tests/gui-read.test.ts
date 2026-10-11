import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getWorkspaceDetail, listWorkspaces } from "../src/gui/read.ts";
import { taskConfigToGoal, type TaskConfig } from "../src/workflow/taskConfig.ts";
import { emptyState, loadState, registerArtifact, saveState } from "../src/workspace/store.ts";

function sampleTaskConfig(): TaskConfig {
  return {
    schemaVersion: 1,
    title: "读层测试样板",
    theme: "临时工作区",
    moodArc: [{ name: "平静", energy: 0 }],
    duration: { minSeconds: 30, maxSeconds: 60 },
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    assets: [
      { sourceUrl: "https://www.pexels.com/video/read-test/", licenseUrl: "https://www.pexels.com/license/" },
    ],
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gui-read-"));
  await saveState(dir, emptyState(taskConfigToGoal(sampleTaskConfig())), 0);
  return dir;
}

test("T3：listWorkspaces 只列出已初始化工作区且排序稳定", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gui-read-root-"));
  try {
    const wsB = path.join(root, "beta-区");
    const wsA = path.join(root, "alpha-区");
    await mkdir(wsB, { recursive: true });
    await saveState(wsB, emptyState(taskConfigToGoal(sampleTaskConfig())), 0);
    await mkdir(wsA, { recursive: true });
    await saveState(wsA, emptyState(taskConfigToGoal(sampleTaskConfig())), 0);
    await mkdir(path.join(root, "not-a-workspace"), { recursive: true });
    await mkdir(path.join(root, ".monitor-cache"), { recursive: true });

    const listed = await listWorkspaces(root);
    assert.deepEqual(listed.map((item) => item.name), ["alpha-区", "beta-区"]);
    assert.ok(listed.every((item) => item.state !== undefined));
    assert.equal((await listWorkspaces(path.join(root, "不存在"))).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T3：空工作区摘要计数为零且深度检查为 null", async () => {
  const dir = await makeWorkspace();
  try {
    const detail = await getWorkspaceDetail(dir);
    assert.equal(detail.state.phase, "assets");
    assert.deepEqual(detail.state.counts, { assets: 0, artifacts: 0, checkpoints: 0 });
    assert.equal(detail.state.deepCheck, null);
    assert.deepEqual(detail.artifacts, []);
    assert.deepEqual(detail.checkpoints, []);
    assert.deepEqual(detail.suggestions, []);
    // 无监测记录时 loadMonitorState 返回零值默认态，metrics 应为零值而非 null。
    assert.equal(detail.metrics?.notificationAttempts, 0);
    assert.equal(detail.metrics?.notificationSent, 0);
    assert.equal(detail.handoff, null);
    assert.deepEqual(detail.reports, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3：产物对账能发现磁盘缺失与恢复", async () => {
  const dir = await makeWorkspace();
  try {
    await mkdir(path.join(dir, "outputs"), { recursive: true });
    const artifactFile = path.join(dir, "outputs", "preview.mp4");
    await writeFile(artifactFile, "fake-video-bytes");
    let loaded = await loadState(dir);
    const record = await registerArtifact(loaded, {
      kind: "video_preview",
      file: "outputs/preview.mp4",
      basedOn: [],
    });
    loaded.state.artifacts.push(record);
    await saveState(dir, loaded.state, loaded.state.revision);

    const withFile = await getWorkspaceDetail(dir);
    assert.equal(withFile.artifacts.length, 1);
    assert.equal(withFile.artifacts[0]!.onDisk, true);
    assert.equal(withFile.artifacts[0]!.bytes, Buffer.byteLength("fake-video-bytes"));

    await rm(artifactFile);
    const withoutFile = await getWorkspaceDetail(dir);
    assert.equal(withoutFile.artifacts[0]!.onDisk, false);
    assert.equal(withoutFile.artifacts[0]!.bytes, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3：检查点 manifest 读取与缺失降级", async () => {
  const dir = await makeWorkspace();
  try {
    const loaded = await loadState(dir);
    loaded.state.checkpoints.push({
      id: "checkpoint-001",
      phase: "score_review",
      createdAt: "2026-10-03T00:00:00.000Z",
      artifactIds: [],
      summary: "配乐初稿 v1",
      nextAction: "等待审阅",
      review: "pending",
    });
    await saveState(dir, loaded.state, loaded.state.revision);

    const missingManifest = await getWorkspaceDetail(dir);
    assert.equal(missingManifest.checkpoints[0]!.manifest, null);

    const manifest = {
      checkpoint: { id: "checkpoint-001" },
      artifacts: [{ id: "artifact-001", kind: "audio_preview", file: "score.wav", sha256: "abc123" }],
      reports: [{ file: "check-report-artifact-001-1.json", sha256: "def456" }],
    };
    const cpDir = path.join(dir, "checkpoints", "checkpoint-001");
    await mkdir(cpDir, { recursive: true });
    await writeFile(path.join(cpDir, "manifest.json"), JSON.stringify(manifest));
    const withManifest = await getWorkspaceDetail(dir);
    assert.deepEqual(withManifest.checkpoints[0]!.manifest, {
      artifacts: manifest.artifacts,
      reports: manifest.reports,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3：未初始化目录抛出与 CLI 一致的错误", async () => {
  await assert.rejects(
    () => getWorkspaceDetail(path.join(tmpdir(), "gui-read-未初始化")),
    /还没有初始化/,
  );
});

test("T3：既有样板工作区摘要与 CLI status 口径一致", async (t) => {
  const dir = path.resolve("workspaces", "mountain-morning");
  if (!existsSync(path.join(dir, "state.json"))) {
    t.skip("本机未提供被 gitignore 的 mountain-morning 样板工作区");
    return;
  }
  const detail = await getWorkspaceDetail(dir);
  assert.equal(detail.name, "mountain-morning");
  assert.equal(detail.state.phase, "done");
  // 与 CLI `status` 输出一致：素材 4 段 / 产物 20 件 / 检查点 3 个；
  // 深度检查 pass 43 / warn 0 / fail 5（未豁免）/ 待人工 3（报告 13 份）。
  assert.deepEqual(detail.state.counts, { assets: 4, artifacts: 20, checkpoints: 3 });
  assert.deepEqual(detail.state.deepCheck, { pass: 43, warn: 0, fail: 5, needsHuman: 3 });
  assert.equal(detail.handoff !== null, true);
  assert.ok(detail.handoff!.includes("山间清晨"));
  const reports = detail.reports;
  assert.equal(reports.length, 13);
  assert.ok(reports.every((report) => Array.isArray(report.results)));
  const total = reports.reduce((sum, report) => sum + report.results.length, 0);
  assert.ok(total > 0, "报告应包含逐项检查结果");
  await readFile(path.join(dir, "state.json"), "utf8"); // 只读访问，确认路径有效
});

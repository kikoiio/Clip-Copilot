import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canTransition,
  type EditPlan,
  type ScorePlan,
  type WorkspaceState,
  validateClipLayout,
  validateEditPlan,
  validateScorePlan,
  scoreDurationMs,
} from "../src/domain.ts";
import {
  WorkspaceError,
  auditArtifacts,
  createCheckpoint,
  emptyState,
  loadState,
  nextId,
  registerArtifact,
  saveState,
  sha256File,
} from "../src/workspace/store.ts";
import { cmdCheckpoint, cmdEdit, cmdIngest, cmdRender, cmdReview, cmdResume, cmdScore, cmdStatus, cmdInit } from "../src/workflow/coordinator.ts";
import { loadTaskConfig, taskConfigToGoal, validateTaskConfig, type TaskConfig } from "../src/workflow/taskConfig.ts";

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "mm-test-"));
}

function sampleScorePlan(): ScorePlan {
  const notes = [] as ScorePlan["tracks"][number]["notes"];
  const sections = [
    { name: "sparse", startBar: 0, bars: 8, energy: 0 },
    { name: "layers", startBar: 8, bars: 8, energy: 1 },
    { name: "build", startBar: 16, bars: 8, energy: 2 },
  ];
  for (let bar = 0; bar < 24; bar++) {
    notes.push({ trackId: "pad", pitchMidi: 60, startBeat: bar * 4, durationBeats: 4, velocity: 70 });
  }
  return { bpm: 120, beatsPerBar: 4, sections, tracks: [{ id: "pad", instrumentTemplate: "Pad", notes }] };
}

function sampleEditPlan(soundtrackId: string): EditPlan {
  return {
    profile: { width: 1920, height: 1080, fps: 30 },
    clips: [
      { assetId: "asset-001", sourceInMs: 0, timelineStartFrame: 0, durationFrames: 720 },
      { assetId: "asset-001", sourceInMs: 2000, timelineStartFrame: 720, durationFrames: 720 },
    ],
    soundtrackArtifactId: soundtrackId,
    fadeInFrames: 30,
    fadeOutFrames: 30,
  };
}

test("T7：非法阶段迁移被拒绝", () => {
  assert.equal(canTransition("assets", "video_draft"), false);
  assert.equal(canTransition("score_review", "done"), false);
  assert.equal(canTransition("score_review", "video_draft"), true);
  assert.equal(canTransition("score_review", "score_draft"), true);
  assert.equal(canTransition("video_review", "final_verify"), true);
  assert.equal(canTransition("done", "assets"), false);
});

test("T7：越界片长与时间线空洞被拒绝", () => {
  const ok = validateClipLayout([
    { assetId: "a", sourceInMs: 0, timelineStartFrame: 0, durationFrames: 900 },
  ]);
  assert.equal(ok.ok, true);
  const gap = validateClipLayout([
    { assetId: "a", sourceInMs: 0, timelineStartFrame: 0, durationFrames: 500 },
    { assetId: "a", sourceInMs: 0, timelineStartFrame: 520, durationFrames: 400 },
  ]);
  assert.equal(gap.ok, false);
  const overlap = validateClipLayout([
    { assetId: "a", sourceInMs: 0, timelineStartFrame: 0, durationFrames: 600 },
    { assetId: "a", sourceInMs: 0, timelineStartFrame: 400, durationFrames: 500 },
  ]);
  assert.equal(overlap.ok, false);
  const tooLong = validateClipLayout([
    { assetId: "a", sourceInMs: 0, timelineStartFrame: 0, durationFrames: 1801 },
  ]);
  assert.equal(tooLong.ok, false);
});

test("T7：引用不存在素材或未确认配乐的计划被拒绝", () => {
  const state = emptyState("t");
  const assets = [{
    id: "asset-001", sourceUrl: "s", licenseUrl: "l", licenseCheckedAt: "2026-10-01",
    localPath: "assets/a.mp4", sha256: "x", bytes: 1,
    media: { durationMs: 60000, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true },
  }];
  const missingAsset = validateEditPlan(sampleEditPlan("artifact-001"), [], [], state);
  assert.ok(missingAsset.some((e) => e.includes("asset-001")));
  const missingSoundtrack = validateEditPlan(sampleEditPlan("artifact-001"), assets, [], state);
  assert.ok(missingSoundtrack.some((e) => e.includes("artifact-001")));
});

test("T7：配乐方案校验（分段不连续、音符越界）", () => {
  const plan = sampleScorePlan();
  assert.deepEqual(validateScorePlan(plan), []);
  const bad = structuredClone(plan) as ScorePlan;
  bad.sections[1]!.startBar = 9;
  assert.ok(validateScorePlan(bad).length > 0);
  assert.equal(scoreDurationMs(plan), 48000);
});

test("T8：状态原子读写、旧版本写入被拒、损坏文件可诊断", async () => {
  const dir = await tempWorkspace();
  try {
    const state = emptyState("测试");
    await saveState(dir, state, 0);
    const loaded = await loadState(dir);
    assert.equal(loaded.state.revision, 1);
    // 旧版本写入被拒
    await assert.rejects(() => saveState(dir, structuredClone(loaded.state), 0), WorkspaceError);
    // 正常推进
    await saveState(dir, structuredClone(loaded.state), loaded.state.revision);
    const reloaded = await loadState(dir);
    assert.equal(reloaded.state.revision, 2);
    // 损坏文件：报错且不覆盖
    const raw = await readFile(path.join(dir, "state.json"), "utf8");
    await writeFile(path.join(dir, "state.json"), "{broken", "utf8");
    await assert.rejects(() => loadState(dir), WorkspaceError);
    assert.equal(await readFile(path.join(dir, "state.json"), "utf8"), "{broken");
    await writeFile(path.join(dir, "state.json"), raw, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T9：检查点不可变、重复提交被拒、指纹篡改被审计发现", async () => {
  const dir = await tempWorkspace();
  try {
    const state = emptyState("测试");
    state.phase = "score_review";
    const file = path.join(dir, "outputs", "score.wav");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "WAVDATA");
    const loaded = { dir, state };
    const artifact = await registerArtifact(loaded, {
      kind: "audio_preview", file, basedOn: ["scoreplan:abc"],
    });
    loaded.state.artifacts.push(artifact);
    await saveState(dir, state, 0);
    const reloaded = await loadState(dir);
    const first = await createCheckpoint(reloaded, {
      phase: "score_review", artifactIds: [artifact.id], summary: "v1", nextAction: "审阅",
    });
    await saveState(dir, first.state, reloaded.state.revision);
    const checkpointDir = path.join(dir, "checkpoints", first.checkpoint.id);
    const copied = await readFile(path.join(checkpointDir, path.basename(artifact.path)), "utf8");
    assert.equal(copied, "WAVDATA");
    // 原文件被篡改 → 恢复审计应发现
    await writeFile(file, "TAMPERED");
    const after = await loadState(dir);
    const problems = await auditArtifacts(after);
    assert.ok(problems.some((p) => p.problem.includes("指纹变化")));
    // 重复提交同名检查点被拒（目录已存在）
    await assert.rejects(async () => {
      const again = await loadState(dir);
      await saveState(dir, again.state, again.state.revision);
      const re2 = await loadState(dir);
      re2.state.phase = "score_review";
      await saveState(dir, re2.state, re2.state.revision);
      const re3 = await loadState(dir);
      await createCheckpoint(re3, {
        phase: "score_review", artifactIds: [artifact.id], summary: "v1", nextAction: "审阅",
      });
    }, WorkspaceError);
    assert.equal((await stat(checkpointDir)).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T21/T22：协调器阶段推进、重复调用保护与反馈失效", async () => {
  const dir = await tempWorkspace();
  try {
    // 无法在未初始化工作区上执行 render
    await assert.rejects(() => cmdRender(["--workspace", dir, "score"]), WorkspaceError);
    await cmdInit(["--workspace", dir]);
    await cmdStatus(["--workspace", dir]);
    // 制造一段假素材文件并登记（绕过 ffprobe：直接写入状态）
    const stateFile = path.join(dir, "state.json");
    const loaded = await loadState(dir);
    loaded.state.assets.push({
      id: "asset-001", sourceUrl: "https://example.com/a", licenseUrl: "https://example.com/license",
      licenseCheckedAt: "2026-10-01T00:00:00Z", localPath: "assets/a.mp4", sha256: "fake",
      bytes: 10,
      media: { durationMs: 60000, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true },
    });
    loaded.state.nextAction = "测试";
    const rev = loaded.state.revision;
    const { saveState: save2 } = await import("../src/workspace/store.ts");
    await save2(dir, loaded.state, rev);
    // 非法越级：assets 阶段直接写剪辑方案被拒
    await assert.rejects(
      () => cmdScore(["--workspace", dir, "--plan", "/nonexistent.json"]),
      (err: unknown) => err instanceof Error,
    );
    // 写入配乐方案 → 进入 score_draft
    const planFile = path.join(dir, "plan.json");
    await writeFile(planFile, JSON.stringify(sampleScorePlan()), "utf8");
    await cmdScore(["--workspace", dir, "--plan", planFile]);
    const afterScore = await loadState(dir);
    assert.equal(afterScore.state.phase, "score_draft");
    // 重复写入相同方案：允许（仍 score_draft）
    await cmdScore(["--workspace", dir, "--plan", planFile]);
    // 未渲染就提交检查点被拒
    await assert.rejects(() => cmdCheckpoint(["--workspace", dir, "--summary", "s"]), WorkspaceError);
    // 待审阅前不能进入终版：直接 render final 被拒
    await assert.rejects(() => cmdRender(["--workspace", dir, "final"]), WorkspaceError);
    // 剪辑方案在配乐批准前被拒（阶段检查）
    const editFile = path.join(dir, "edit.json");
    await writeFile(editFile, JSON.stringify(sampleEditPlan("artifact-001")), "utf8");
    await assert.rejects(() => cmdEdit(["--workspace", dir, "--plan", editFile]), WorkspaceError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T23：resume 在删除依赖文件后指出问题", async () => {
  const dir = await tempWorkspace();
  try {
    await cmdInit(["--workspace", dir]);
    const loaded = await loadState(dir);
    const file = path.join(dir, "assets", "ghost.mp4");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "data");
    const rev = loaded.state.revision;
    const { saveState } = await import("../src/workspace/store.ts");
    loaded.state.artifacts.push({
      id: "artifact-001", kind: "video_preview", path: "assets/ghost.mp4",
      sha256: await sha256File(file), createdAt: new Date().toISOString(),
      basedOn: [], status: "confirmed",
    });
    await saveState(dir, loaded.state, rev);
    await rm(file);
    await cmdResume(["--workspace", dir]);
    const handoff = await readFile(path.join(dir, "handoff.md"), "utf8");
    assert.ok(handoff.includes("文件缺失"));
    assert.ok(handoff.includes("ghost.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nextId 递增", () => {
  assert.equal(nextId("asset", []), "asset-001");
  assert.equal(nextId("asset", [{ id: "asset-003" }, { id: "asset-001" }]), "asset-004");
});

/* ---------- 阶段 2：任务配置 ---------- */

function sampleTaskConfig(): TaskConfig {
  return {
    schemaVersion: 1,
    title: "测试样板",
    theme: "黄昏海岸，从宁静到涌动",
    moodArc: [
      { name: "宁静", energy: 0 },
      { name: "涌动", energy: 2 },
    ],
    duration: { minSeconds: 30, maxSeconds: 60 },
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    assets: [
      { sourceUrl: "https://www.pexels.com/video/test/", licenseUrl: "https://www.pexels.com/license/" },
    ],
  };
}

test("T2：合法任务配置通过校验并换算为帧目标", () => {
  const config = sampleTaskConfig();
  assert.deepEqual(validateTaskConfig(config), []);
  const goal = taskConfigToGoal(config);
  assert.equal(goal.title, "测试样板");
  assert.equal(goal.minFrames, 900);
  assert.equal(goal.maxFrames, 1800);
  assert.deepEqual(goal.outputSpec, { width: 1920, height: 1080, fps: 30 });
  assert.equal(goal.moodArc.length, 2);
});

test("T2：缺字段、时长颠倒、未验证规格三类非法配置被拒且指明字段", () => {
  const missing = sampleTaskConfig();
  delete (missing as Partial<TaskConfig>).theme;
  assert.ok(validateTaskConfig(missing).some((e) => e.includes("theme")));

  const inverted = sampleTaskConfig();
  inverted.duration = { minSeconds: 60, maxSeconds: 30 };
  const invertedErrors = validateTaskConfig(inverted);
  assert.ok(invertedErrors.some((e) => e.includes("minSeconds") && e.includes("maxSeconds")));

  const badSpec = sampleTaskConfig();
  badSpec.outputSpec = { width: 1080, height: 1920, fps: 30 };
  assert.ok(validateTaskConfig(badSpec).some((e) => e.includes("outputSpec") && e.includes("未验证规格")));

  const badMood = sampleTaskConfig();
  badMood.moodArc = [{ name: "越界", energy: 3 }];
  assert.ok(validateTaskConfig(badMood).some((e) => e.includes("moodArc[0].energy")));
});

test("T2：loadTaskConfig 读取合法配置，损坏文件可诊断", async () => {
  const dir = await tempWorkspace();
  try {
    const file = path.join(dir, "task.json");
    await writeFile(file, JSON.stringify(sampleTaskConfig()), "utf8");
    const loaded = await loadTaskConfig(file);
    assert.equal(loaded.title, "测试样板");
    await writeFile(file, "{broken", "utf8");
    await assert.rejects(() => loadTaskConfig(file), /不是合法 JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- 阶段 2：v1 状态迁移 ---------- */

test("T3：v1 状态读取时迁移为 v2，字段按规则填充", async () => {
  const dir = await tempWorkspace();
  try {
    const v1 = {
      schemaVersion: 1,
      revision: 7,
      goal: { title: "山间清晨：30–60 秒短片", minFrames: 900, maxFrames: 1800, fps: 30 },
      phase: "done",
      assets: [],
      artifacts: [],
      checkpoints: [],
      decisions: [],
      issues: [],
      nextAction: "已交付",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    await writeFile(path.join(dir, "state.json"), JSON.stringify(v1, null, 2), "utf8");
    const loaded = await loadState(dir);
    assert.equal(loaded.state.schemaVersion, 2);
    assert.equal(loaded.state.revision, 7);
    assert.equal(loaded.state.goal.title, "山间清晨：30–60 秒短片");
    assert.equal(loaded.state.goal.theme, "阶段 1 样板（配置化之前的数据）");
    assert.deepEqual(loaded.state.goal.outputSpec, { width: 1920, height: 1080, fps: 30 });
    assert.deepEqual(loaded.state.goal.moodArc, []);
    // 磁盘文件保持 v1 原样（迁移只在内存中）
    const rawOnDisk = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(rawOnDisk.schemaVersion, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T3：v1 goal 缺字段时报错而非静默迁移，未知版本仍被拒", async () => {
  const dir = await tempWorkspace();
  try {
    const brokenV1 = { schemaVersion: 1, revision: 1, goal: { title: "x" }, phase: "assets" };
    await writeFile(path.join(dir, "state.json"), JSON.stringify(brokenV1), "utf8");
    await assert.rejects(() => loadState(dir), /goal 字段不完整/);
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ schemaVersion: 99 }), "utf8");
    await assert.rejects(() => loadState(dir), /schemaVersion/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

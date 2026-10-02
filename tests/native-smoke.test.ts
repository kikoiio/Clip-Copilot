import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  LMMS_APPIMAGE,
  KDENLIVE_APPIMAGE,
  runLmms,
  runKdenlive,
  runFfprobe,
  type RunResult,
} from "../src/infra/process.ts";
import { probeMedia, checkMediaBasics, detectBlackSegments, detectSilenceSegments } from "../src/verification/media.ts";
import { checkProjectReferences, recordObservation } from "../src/verification/native.ts";
import { ingestAsset, checkAsset } from "../src/assets/catalog.ts";
import { loadLmmsTemplate, renderScoreWav, scorePlanFingerprint, writeScoreProject } from "../src/score/lmms.ts";
import { writeEditProject } from "../src/video/kdenlive.ts";
import type { AssetRecord, EditPlan, Goal, ScorePlan } from "../src/domain.ts";

const exec = promisify(execFile);

const APPIMAGES_PRESENT =
  (await stat(LMMS_APPIMAGE).then(() => true).catch(() => false)) &&
  (await stat(KDENLIVE_APPIMAGE).then(() => true).catch(() => false));

async function ffmpeg(args: string[]): Promise<void> {
  await exec("ffmpeg", ["-v", "error", "-y", ...args]);
}

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

function assertRenderedOk(run: RunResult, what: string): void {
  assert.equal(run.timedOut, false, `${what} 超时`);
  assert.equal(run.exitCode, 0, `${what} 退出码 ${run.exitCode}：${run.stderr.slice(-400)}`);
}

test("T2：两款 AppImage 帮助命令与 ffprobe 可运行", { skip: !APPIMAGES_PRESENT }, async () => {
  const lmms = await runLmms(["--help"], { timeoutMs: 5 * 60_000 });
  assertRenderedOk(lmms, "lmms --help");
  assert.ok(lmms.stdout.includes("render"), "LMMS 帮助应包含 render 命令");
  const kdenlive = await runKdenlive(["--help"], { timeoutMs: 5 * 60_000 });
  assertRenderedOk(kdenlive, "kdenlive --help");
  assert.ok(kdenlive.stdout.includes("--render"), "Kdenlive 帮助应包含 --render");
  const ffprobe = await runFfprobe(["-version"]);
  assertRenderedOk(ffprobe, "ffprobe -version");
  assert.ok(ffprobe.stdout.includes("ffprobe"));
});

test("T10：素材登记与缺失报告", async () => {
  const dir = await tempDir("mm-asset-");
  try {
    await mkdir(path.join(dir, "assets"), { recursive: true });
    const clip = path.join(dir, "assets", "clip.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "2", "-pix_fmt", "yuv420p", clip]);
    const record = await ingestAsset(dir, path.join(dir, "assets"), [], {
      file: path.join(dir, "assets", "clip.mp4"),
      sourceUrl: "https://example.com/source",
      licenseUrl: "https://example.com/license",
      totalBytesSoFar: 0,
    });
    assert.ok(record.sha256.length === 64);
    assert.equal(record.media.width, 640);
    assert.equal(record.media.fps, 30);
    assert.ok(Math.abs(record.media.durationMs - 2000) < 300);
    const checks = await checkAsset(dir, record);
    assert.ok(checks.every((c) => c.status === "pass"));
    await assert.rejects(
      () => ingestAsset(dir, path.join(dir, "assets"), [record], {
        file: path.join(dir, "assets", "missing.mp4"),
        sourceUrl: "s", licenseUrl: "l", totalBytesSoFar: 0,
      }),
      (err: Error) => err.message.includes("不存在"),
    );
    // 不在 assets 目录内的文件必须拒绝登记
    const outside = path.join(dir, "outside.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-t", "1", "-pix_fmt", "yuv420p", outside]);
    await assert.rejects(
      () => ingestAsset(dir, path.join(dir, "assets"), [record], {
        file: outside,
        sourceUrl: "s", licenseUrl: "l", totalBytesSoFar: 0,
      }),
      (err: Error) => err.message.includes("先放入"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T11：LMMS 模板校验与必需节点检查", async () => {
  const templateXml = await readFile(path.join("templates", "lmms", "base.mmp"), "utf8");
  const template = loadLmmsTemplate(templateXml, "base.mmp");
  assert.equal(template.creatorVersion, "1.2.2");
  assert.ok(template.trackNames.includes("Pad"));
  // 删除 head 节点后必须给出明确错误
  const broken = templateXml.replace(/<head[^/]*\/>/, "");
  assert.throws(() => loadLmmsTemplate(broken, "broken.mmp"), /head/);
  // 删除 trackcontainer 后必须报错
  const noContainer = templateXml.replace(/<trackcontainer[\s\S]*<\/trackcontainer>/, "");
  assert.throws(() => loadLmmsTemplate(noContainer, "broken.mmp"), /trackcontainer/);
});

function twoBarPlan(trackTemplate: string): ScorePlan {
  const notes: ScorePlan["tracks"][number]["notes"] = [];
  for (let bar = 0; bar < 2; bar++) {
    notes.push({ trackId: "pad", pitchMidi: 60, startBeat: bar * 4, durationBeats: 4, velocity: 70 });
  }
  return {
    bpm: 120, beatsPerBar: 4,
    sections: [{ name: "s", startBar: 0, bars: 2, energy: 1 }],
    tracks: [{ id: "pad", instrumentTemplate: trackTemplate, notes }],
  };
}

test("T12/T13：两份计划渲染出不同音频，模板不变；无效输出路径报错", { skip: !APPIMAGES_PRESENT }, async () => {
  const dir = await tempDir("mm-lmms-");
  try {
    const templatePath = path.join("templates", "lmms", "base.mmp");
    const templateShaBefore = await (await import("../src/workspace/store.ts")).sha256File(templatePath);
    const planA = twoBarPlan("Pad");
    const planB = twoBarPlan("Pad");
    planB.tracks[0]!.notes = [{ trackId: "pad", pitchMidi: 65, startBeat: 0, durationBeats: 8, velocity: 100 }];
    const pathA = path.join(dir, "a.mmp");
    const pathB = path.join(dir, "b.mmp");
    await writeScoreProject(planA, templatePath, pathA);
    await writeScoreProject(planB, templatePath, pathB);
    assert.notEqual(scorePlanFingerprint(planA), scorePlanFingerprint(planB));
    const wavA = path.join(dir, "a.wav");
    const wavB = path.join(dir, "b.wav");
    const renderA = await renderScoreWav(pathA, wavA);
    const renderB = await renderScoreWav(pathB, wavB);
    assert.notEqual(renderA.sha256, renderB.sha256, "不同乐谱应产生不同音频");
    const media = await probeMedia(wavA);
    assert.ok(Math.abs(media.durationMs - 4000) < 300, `2 小节@120bpm 应为 4s，实际 ${media.durationMs}ms`);
    const templateShaAfter = await (await import("../src/workspace/store.ts")).sha256File(templatePath);
    assert.equal(templateShaAfter, templateShaBefore, "模板指纹不得改变");
    await assert.rejects(
      () => renderScoreWav(pathA, path.join(dir, "no-such-dir", "x.wav"), undefined, 60_000),
      (err: Error) => err.message.includes("渲染失败"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function sampleAssets(dir: string): Promise<AssetRecord[]> {
  const clipA = path.join(dir, "a.mp4");
  const clipB = path.join(dir, "b.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "15", "-pix_fmt", "yuv420p", clipA]);
  await ffmpeg(["-f", "lavfi", "-i", "smptebars=size=1920x1080:rate=30", "-t", "15", "-pix_fmt", "yuv420p", clipB]);
  const mediaA = await probeMedia(clipA);
  const mediaB = await probeMedia(clipB);
  const base = {
    sourceUrl: "https://example.com/s", licenseUrl: "https://example.com/l",
    licenseCheckedAt: "2026-10-01T00:00:00Z", sha256: "0".repeat(64),
    bytes: 1, hasAudioPlace: undefined,
  };
  void base;
  return [
    { id: "asset-001", sourceUrl: "https://example.com/s1", licenseUrl: "https://example.com/l1", licenseCheckedAt: "2026-10-01T00:00:00Z", localPath: clipA, sha256: "0".repeat(64), bytes: 1, media: mediaA },
    { id: "asset-002", sourceUrl: "https://example.com/s2", licenseUrl: "https://example.com/l2", licenseCheckedAt: "2026-10-01T00:00:00Z", localPath: clipB, sha256: "0".repeat(64), bytes: 1, media: mediaB },
  ];
}

function editPlan30s(assets: Awaited<ReturnType<typeof sampleAssets>>, soundtrackId: string): EditPlan {
  return {
    profile: { width: 1920, height: 1080, fps: 30 },
    clips: [
      { assetId: assets[0]!.id, sourceInMs: 0, timelineStartFrame: 0, durationFrames: 450 },
      { assetId: assets[1]!.id, sourceInMs: 0, timelineStartFrame: 450, durationFrames: 450 },
    ],
    soundtrackArtifactId: soundtrackId,
    fadeInFrames: 30,
    fadeOutFrames: 45,
  };
}

function smokeGoal(): Goal {
  return {
    title: "原生冒烟测试",
    theme: "生成的测试画面与正弦音，不进入任何成片",
    minFrames: 450,
    maxFrames: 1350,
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    moodArc: [],
  };
}

test("T14-T17：Kdenlive 工程生成、时间线与 MP4 导出", { skip: !APPIMAGES_PRESENT }, async () => {
  const dir = await tempDir("mm-kdenlive-");
  try {
    const assets = await sampleAssets(dir);
    const mapped = assets.map((a) => ({ ...a, media: { ...a.media, hasAudio: false, hasVideo: true } }));
    // 30 秒测试 WAV
    const wav = path.join(dir, "tone.wav");
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "30", wav]);
    const wavMedia = await probeMedia(wav);
    const templatePath = path.join("templates", "kdenlive", "base.kdenlive");
    const { sha256File } = await import("../src/workspace/store.ts");
    const templateShaBefore = await sha256File(templatePath);

    const plan = editPlan30s(mapped, "artifact-001");
    const projectPath = path.join(dir, "edit-test.kdenlive");
    await writeEditProject(plan, dir, mapped, wav, wavMedia.durationMs, templatePath, projectPath, smokeGoal());
    // 生成的工程必须引用每个素材的现存路径
    const xml = await readFile(projectPath, "utf8");
    for (const asset of mapped) {
      assert.ok(xml.includes(path.resolve(asset.localPath)), `缺少素材引用 ${asset.localPath}`);
    }
    // 重叠计划被拒
    const badPlan = structuredClone(plan);
    badPlan.clips[1]!.timelineStartFrame = 400;
    await assert.rejects(
      () => writeEditProject(badPlan, dir, mapped, wav, wavMedia.durationMs, templatePath, path.join(dir, "bad.kdenlive"), smokeGoal()),
      /空洞|重叠/,
    );
    // 超出 1s 容差的 WAV 被拒
    await assert.rejects(
      () => writeEditProject(plan, dir, mapped, wav, wavMedia.durationMs + 5000, templatePath, path.join(dir, "bad2.kdenlive"), smokeGoal()),
      /容差/,
    );
    // 素材文件删除后拒绝生成
    await rm(mapped[0]!.localPath);
    await assert.rejects(
      () => writeEditProject(plan, dir, mapped, wav, wavMedia.durationMs, templatePath, path.join(dir, "bad3.kdenlive"), smokeGoal()),
      /缺失/,
    );
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "15", "-pix_fmt", "yuv420p", mapped[0]!.localPath]);
    // T17/T15：导出 MP4
    const mp4 = path.join(dir, "out.mp4");
    const rendered = await import("../src/video/kdenlive.ts").then((m) => m.renderVideoMp4(projectPath, mp4, undefined, undefined, 10 * 60_000));
    assert.ok(rendered.outputBytes > 0);
    const outMedia = await probeMedia(mp4);
    assert.equal(outMedia.width, 1920);
    assert.equal(outMedia.height, 1080);
    assert.ok(Math.abs(outMedia.fps - 30) < 0.01);
    assert.ok(Math.abs(outMedia.durationMs - 30000) < 1500, `导出应约 30s，实际 ${outMedia.durationMs}ms`);
    // T20：工程引用检查（素材齐全 → pass；删除 → fail）
    const refsOk = await checkProjectReferences(projectPath);
    assert.ok(refsOk.every((r) => r.status !== "fail"));
    await rm(mapped[0]!.localPath);
    const refsBad = await checkProjectReferences(projectPath);
    assert.ok(refsBad.some((r) => r.status === "fail" && r.evidence.includes("缺失")));
    const templateShaAfter = await sha256File(templatePath);
    assert.equal(templateShaAfter, templateShaBefore);
    // 无效输出路径 → 可诊断失败
    await assert.rejects(
      () => import("../src/video/kdenlive.ts").then((m) => m.renderVideoMp4(projectPath, path.join(dir, "no-dir", "x.mp4"), undefined, undefined, 5 * 60_000)),
      (err: Error) => err.message.includes("导出失败"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T18/T19：元数据、完整解码、黑帧、静音与音量检查", async () => {
  const dir = await tempDir("mm-media-");
  try {
    const wav = path.join(dir, "tone.wav");
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3", wav]);
    const wavChecks = await checkMediaBasics(wav, { hasVideo: false, hasAudio: true, minDurationMs: 3000 });
    assert.ok(wavChecks.every((c) => c.status === "pass"));

    const clip = path.join(dir, "ok.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "2", "-pix_fmt", "yuv420p", clip]);
    const clipChecks = await checkMediaBasics(clip, { hasVideo: true, width: 640, height: 360, fps: 30 });
    assert.ok(clipChecks.every((c) => c.status === "pass"));
    // 正常片段不应被误报黑帧
    assert.equal((await detectBlackSegments(clip)).length, 0);

    // 截断文件（moov 丢失）：元数据读取必须失败
    const truncated = path.join(dir, "trunc.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "2", "-pix_fmt", "yuv420p", truncated]);
    const full = await readFile(truncated);
    await writeFile(truncated, full.subarray(0, Math.floor(full.length / 2)));
    const truncChecks = await checkMediaBasics(truncated, { hasVideo: true });
    assert.ok(truncChecks.some((c) => c.status === "fail"), "截断文件必须报失败");
    // mdat 中段损坏：元数据可读，但完整解码必须失败并带证据
    const corrupted = path.join(dir, "corrupt.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "2", "-pix_fmt", "yuv420p", corrupted]);
    const raw = await readFile(corrupted);
    raw[raw.length >> 1] = 0xff;
    raw[(raw.length >> 1) + 1] = 0x00;
    await writeFile(corrupted, raw);
    const corruptChecks = await checkMediaBasics(corrupted, { hasVideo: true });
    assert.equal(corruptChecks[0]?.status, "pass", "损坏文件的元数据仍可读");
    assert.ok(
      corruptChecks.some((c) => c.id === "media:decode" && c.status === "fail"),
      `中段损坏必须解码失败：${JSON.stringify(corruptChecks)}`,
    );

    // 1 秒黑段 (0.5-1.5s) 必须被标记
    const withBlack = path.join(dir, "black.mp4");
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=0.5",
      "-f", "lavfi", "-i", "color=black:size=320x240:rate=30:duration=1",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=0.5",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0",
      "-pix_fmt", "yuv420p", withBlack,
    ]);
    const blacks = await detectBlackSegments(withBlack);
    assert.ok(blacks.some((b) => b.durationSec >= 0.4), `应检出黑段，实际 ${JSON.stringify(blacks)}`);

    // 1 秒静音段必须被标记
    const withSilence = path.join(dir, "silence.wav");
    await ffmpeg([
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1",
      "-f", "lavfi", "-i", "anullsrc=sample_rate=44100:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1",
      "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1",
      withSilence,
    ]);
    const silences = await detectSilenceSegments(withSilence);
    assert.ok(silences.some((s) => s.durationSec >= 0.9), `应检出静音段，实际 ${JSON.stringify(silences)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T20：无 GUI 观察时保持 needs_observation", async () => {
  const dir = await tempDir("mm-obs-");
  try {
    const result = await recordObservation(dir, "lmms-edit", "LMMS 工程", undefined);
    assert.equal(result.status, "needs_observation");
    const withObs = await recordObservation(dir, "lmms-edit", "LMMS 工程", {
      action: "移动音符并保存",
      observedResult: "副本重开后音符位置已变化",
      projectCopyPath: "/tmp/copy.mmp",
      observer: "创作者",
    });
    assert.equal(withObs.status, "pass");
    assert.ok(await stat(path.join(dir, "observation-lmms-edit.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

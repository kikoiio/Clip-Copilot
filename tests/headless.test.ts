/**
 * T6：两款软件对交付工程的无界面「打开并处理」验证（阶段 3 模块 B，spec F3）。
 *
 * 真实 AppImage 慢速测试，与 native-smoke 的渲染测试同级别：AppImage 每次启动
 * 5–15s，Kdenlive 渲染正例可能 30–60s，整体预期 2–3 分钟；进程内部超时由
 * DEEP_CHECK_DEFAULTS.headlessTimeoutMs 把关，这里不另设更紧的限制。
 * 任一 AppImage 缺失时按既有惯例跳过对应用例。
 *
 * 工程验证的语义是「原位读取、输出写临时区、用后删除」：正例断言 pass 与
 * command/tool/threshold 证据，反例用截断工程断言 fail，两类用例都检查临时
 * 输出确实被 finally 清理。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { AssetRecord, EditPlan, Goal, ScorePlan } from "../src/domain.ts";
import { KDENLIVE_APPIMAGE, LMMS_APPIMAGE } from "../src/infra/process.ts";
import { writeScoreProject } from "../src/score/lmms.ts";
import {
  headlessValidateKdenliveProject,
  headlessValidateLmmsProject,
} from "../src/verification/headless.ts";
import { DEEP_CHECK_DEFAULTS } from "../src/verification/deep.ts";
import { probeMedia } from "../src/verification/media.ts";
import { writeEditProject } from "../src/video/kdenlive.ts";
import { sha256File } from "../src/workspace/store.ts";

const exec = promisify(execFile);

const LMMS_PRESENT = await stat(LMMS_APPIMAGE).then(() => true).catch(() => false);
const KDENLIVE_PRESENT = await stat(KDENLIVE_APPIMAGE).then(() => true).catch(() => false);

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

async function ffmpeg(args: string[]): Promise<void> {
  await exec("ffmpeg", ["-v", "error", "-y", ...args]);
}

// 模板路径相对测试文件目录解析，不依赖进程 cwd。
const LMMS_TEMPLATE = path.resolve(import.meta.dirname, "..", "templates", "lmms", "base.mmp");
const KDENLIVE_TEMPLATE = path.resolve(import.meta.dirname, "..", "templates", "kdenlive", "base.kdenlive");

/** 最小配乐方案：120 BPM、单段 2 小节、每小节一个全音符（参照 recovery.test.ts 的构造）。 */
function minimalScorePlan(): ScorePlan {
  const notes: ScorePlan["tracks"][number]["notes"] = [];
  for (let bar = 0; bar < 2; bar++) {
    notes.push({ trackId: "pad", pitchMidi: 60, startBeat: bar * 4, durationBeats: 4, velocity: 70 });
  }
  return {
    bpm: 120,
    beatsPerBar: 4,
    sections: [{ name: "minimal", startBar: 0, bars: 2, energy: 1 }],
    tracks: [{ id: "pad", instrumentTemplate: "Pad", notes }],
  };
}

/** 把文件截断到一半字节另存，用于「损坏工程必须 fail」的反例。 */
async function writeTruncatedCopy(source: string, target: string): Promise<void> {
  const full = await readFile(source);
  await writeFile(target, full.subarray(0, Math.floor(full.length / 2)));
}

/** 目录里不得残留任何 headless 验证的临时输出（finally 清理的证据）。 */
function assertNoHeadlessOutput(dir: string, marker: string, files: string[]): void {
  const leftovers = files.filter((f) => f.includes(marker));
  assert.deepEqual(leftovers, [], `临时输出应被清理，实际残留 ${JSON.stringify(leftovers)}`);
}

/**
 * 在临时「工作区」里生成最小可渲染的 .kdenlive：6s 1080p 测试画面 + 3s 正弦配乐
 * 都放在 assets/ 下，工程写到 projects/ 下，适配器 v2 的相对引用 ../assets/...
 * 可解析。单片段铺满 90 帧（3s@30fps），与配乐时长零漂移，fadeIn/fadeOut 为 0。
 * AssetRecord 手工构造（probeMedia 取 media、sha256File 取指纹、localPath 相对
 * 工作区）；writeEditProject 只用 plan 与文件路径，不查 artifact 注册表，故
 * soundtrackArtifactId 给任意 ID 即可。
 */
async function buildMinimalKdenliveProject(dir: string): Promise<string> {
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await mkdir(path.join(dir, "projects"), { recursive: true });
  const clip = path.join(dir, "assets", "a.mp4");
  await ffmpeg([
    "-f", "lavfi", "-i", "testsrc=duration=6:size=1920x1080:rate=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", clip,
  ]);
  const wav = path.join(dir, "assets", "score.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3", "-c:a", "pcm_s16le", wav]);
  const asset: AssetRecord = {
    id: "asset-001",
    sourceUrl: "https://example.com/s",
    licenseUrl: "https://example.com/l",
    licenseCheckedAt: "2026-10-01T00:00:00Z",
    localPath: "assets/a.mp4",
    sha256: await sha256File(clip),
    bytes: (await stat(clip)).size,
    media: await probeMedia(clip),
  };
  const plan: EditPlan = {
    profile: { width: 1920, height: 1080, fps: 30 },
    clips: [{ assetId: "asset-001", sourceInMs: 0, timelineStartFrame: 0, durationFrames: 90 }],
    soundtrackArtifactId: "artifact-001",
    fadeInFrames: 0,
    fadeOutFrames: 0,
  };
  const goal: Goal = {
    title: "无界面验证测试",
    theme: "合成素材，不进入任何成片",
    minFrames: 90,
    maxFrames: 900,
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    moodArc: [],
  };
  const project = path.join(dir, "projects", "e.kdenlive");
  const wavMedia = await probeMedia(wav);
  await writeEditProject(plan, dir, [asset], wav, wavMedia.durationMs, KDENLIVE_TEMPLATE, project, goal);
  return project;
}

test("T6：LMMS 无界面打开并渲染最小工程 → pass", { skip: !LMMS_PRESENT }, async () => {
  const dir = await tempDir("mm-headless-lmms-");
  try {
    const project = path.join(dir, "score.mmp");
    await writeScoreProject(minimalScorePlan(), LMMS_TEMPLATE, project);
    const result = await headlessValidateLmmsProject(project, dir);
    assert.equal(result.id, "headless:lmms");
    assert.equal(result.status, "pass");
    // pass 证据：输出字节数与耗时
    assert.ok(/\d+B/.test(result.evidence), `证据应含输出字节数：${result.evidence}`);
    assert.ok(result.evidence.includes("耗时"), `证据应含耗时：${result.evidence}`);
    // 可复现性字段：命令、工具、阈值
    assert.ok(result.command?.includes(" render "), `命令应含 render 子命令：${result.command}`);
    assert.ok(result.tool?.includes("LMMS"), result.tool);
    assert.equal(result.threshold, `退出码 0 且 ${DEEP_CHECK_DEFAULTS.headlessTimeoutMs}ms 内完成、输出 WAV 大于 44 字节`);
    // finally 清理：临时输出不得残留
    assertNoHeadlessOutput(dir, "lmms-headless-", await readdir(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T6：LMMS 截断工程 → fail（fail 也带 command/tool）", { skip: !LMMS_PRESENT }, async () => {
  const dir = await tempDir("mm-headless-lmms-bad-");
  try {
    const project = path.join(dir, "score.mmp");
    await writeScoreProject(minimalScorePlan(), LMMS_TEMPLATE, project);
    const truncated = path.join(dir, "truncated.mmp");
    await writeTruncatedCopy(project, truncated);
    const result = await headlessValidateLmmsProject(truncated, dir);
    assert.equal(result.id, "headless:lmms");
    assert.equal(result.status, "fail");
    // fail 证据：退出码（以及命令、工具、阈值俱全）
    assert.ok(result.evidence.includes("退出码"), `证据应含退出码：${result.evidence}`);
    assert.ok(result.command?.includes(" render "), result.command);
    assert.ok(result.tool?.includes("LMMS"), result.tool);
    assert.ok(result.threshold, result.threshold);
    // 失败时同样不残留临时输出
    assertNoHeadlessOutput(dir, "lmms-headless-", await readdir(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T6：Kdenlive 无界面打开并渲染最小工程 → pass", { skip: !KDENLIVE_PRESENT }, async () => {
  const dir = await tempDir("mm-headless-kdenlive-");
  try {
    const project = await buildMinimalKdenliveProject(dir);
    const result = await headlessValidateKdenliveProject(project, dir);
    assert.equal(result.id, "headless:kdenlive");
    assert.equal(result.status, "pass");
    // pass 证据：输出字节数与耗时
    assert.ok(/\d+B/.test(result.evidence), `证据应含输出字节数：${result.evidence}`);
    assert.ok(result.evidence.includes("耗时"), `证据应含耗时：${result.evidence}`);
    // 可复现性字段：命令、工具、阈值
    assert.ok(result.command?.includes(" --render"), `命令应含 --render：${result.command}`);
    assert.ok(result.tool?.includes("Kdenlive"), result.tool);
    assert.equal(result.threshold, `退出码 0 且 ${DEEP_CHECK_DEFAULTS.headlessTimeoutMs}ms 内完成、输出 MP4 非空`);
    // finally 清理：临时输出不得残留
    assertNoHeadlessOutput(dir, "kdenlive-headless-", await readdir(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T6：Kdenlive 截断工程 → fail（fail 也带 command/tool）", { skip: !KDENLIVE_PRESENT }, async () => {
  const dir = await tempDir("mm-headless-kdenlive-bad-");
  try {
    const project = await buildMinimalKdenliveProject(dir);
    const truncated = path.join(dir, "projects", "truncated.kdenlive");
    await writeTruncatedCopy(project, truncated);
    const result = await headlessValidateKdenliveProject(truncated, dir);
    assert.equal(result.id, "headless:kdenlive");
    assert.equal(result.status, "fail");
    // fail 证据：退出码（以及命令、工具、阈值俱全）
    assert.ok(result.evidence.includes("退出码"), `证据应含退出码：${result.evidence}`);
    assert.ok(result.command?.includes(" --render"), result.command);
    assert.ok(result.tool?.includes("Kdenlive"), result.tool);
    assert.ok(result.threshold, result.threshold);
    // 失败时同样不残留临时输出
    assertNoHeadlessOutput(dir, "kdenlive-headless-", await readdir(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

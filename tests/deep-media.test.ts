/**
 * 深度检查媒体检测测试（阶段 3 T4）：削波游程纯函数、detectClipping 与
 * measureLoudness 的 ffmpeg 集成。合成媒体来自 lavfi 正弦源，产物写入
 * os.tmpdir 临时目录并在测后递归清理，不触碰工作区状态。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runFfmpeg } from "../src/infra/process.ts";
import {
  DEEP_CHECK_DEFAULTS,
  countClippedRuns,
  detectClipping,
  measureLoudness,
} from "../src/verification/deep.ts";

/** 每个用例独立的临时目录，测后清理。 */
async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "deep-media-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 用 lavfi 正弦源生成 2s 的 s16le wav；audioFilter 为完整的 -af 值。 */
async function makeSineWav(dir: string, name: string, audioFilter: string): Promise<string> {
  const file = path.join(dir, name);
  const result = await runFfmpeg(
    [
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-af", audioFilter,
      "-c:a", "pcm_s16le",
      "-y", file,
    ],
    { timeoutMs: 2 * 60_000 },
  );
  assert.equal(result.exitCode, 0, `生成测试音频失败：${result.stderr.slice(-500)}`);
  return file;
}

// ── countClippedRuns（纯函数）──────────────────────────────────────────────

test("countClippedRuns：3 个连续 32767 → maxConsecutive=3、clippedSamples=3", () => {
  const samples = new Int16Array([100, 32767, 32767, 32767, 200, 0, -500]);
  const report = countClippedRuns(samples, DEEP_CHECK_DEFAULTS.minConsecutiveClippedSamples);
  assert.equal(report.maxConsecutive, 3);
  assert.equal(report.clippedSamples, 3);
});

test("countClippedRuns：负向满幅 -32768 同样计入满幅游程", () => {
  const samples = new Int16Array([-32768, -32768, 5, -32768, -32768, -32768]);
  const report = countClippedRuns(samples, 2);
  assert.equal(report.maxConsecutive, 3);
  assert.equal(report.clippedSamples, 5);
});

test("countClippedRuns：孤立单个 32767 两侧为较小值 → 游程长度 1，不构成连续削波", () => {
  // 两个孤立满幅样本，另用 32766（差一格）验证会打断游程
  const samples = new Int16Array([0, 1000, 32767, -1000, 0, 32767, 32766, 32767]);
  const report = countClippedRuns(samples, DEEP_CHECK_DEFAULTS.minConsecutiveClippedSamples);
  assert.equal(report.maxConsecutive, 1);
  assert.equal(report.clippedSamples, 3);
});

test("countClippedRuns：全零样本 → { maxConsecutive: 0, clippedSamples: 0 }", () => {
  assert.deepEqual(countClippedRuns(new Int16Array(1000), 3), {
    maxConsecutive: 0,
    clippedSamples: 0,
  });
});

// ── detectClipping（ffmpeg 集成）───────────────────────────────────────────

test("detectClipping：volume=20 的削波正弦 → maxConsecutive ≥ 3 且 clippedSamples > 0", async () => {
  await withTempDir(async (dir) => {
    // 先增益再 pan 上混成立体声（gain 1 拷贝）：detectClipping 的 -ac 2 在
    // mono→stereo 时走 swr 重矩阵、每声道衰减 1/√2，会把单声道削波峰拉离满幅；
    // 立体声→立体声为恒等变换，与真实立体声交付产物一致。
    const file = await makeSineWav(dir, "clip.wav", "volume=20,pan=stereo|c0=c0|c1=c0");
    const report = await detectClipping(file, DEEP_CHECK_DEFAULTS.minConsecutiveClippedSamples);
    assert.ok(report.maxConsecutive >= 3, `maxConsecutive=${report.maxConsecutive}`);
    assert.ok(report.clippedSamples > 0, `clippedSamples=${report.clippedSamples}`);
  });
});

test("detectClipping：volume=0.5 的干净正弦 → maxConsecutive=0、clippedSamples=0", async () => {
  await withTempDir(async (dir) => {
    const file = await makeSineWav(dir, "clean.wav", "volume=0.5");
    const report = await detectClipping(file, DEEP_CHECK_DEFAULTS.minConsecutiveClippedSamples);
    assert.equal(report.maxConsecutive, 0);
    assert.equal(report.clippedSamples, 0);
  });
});

// ── measureLoudness（ffmpeg 集成）──────────────────────────────────────────

test("measureLoudness：volume=0.5 正弦 → LUFS 在 (-60, 0)，truePeak < 0，LRA ≥ 0", async () => {
  await withTempDir(async (dir) => {
    const file = await makeSineWav(dir, "normal.wav", "volume=0.5");
    const report = await measureLoudness(file);
    assert.ok(
      report.integratedLufs > -60 && report.integratedLufs < 0,
      `integratedLufs=${report.integratedLufs}`,
    );
    assert.ok(report.truePeakDb < 0, `truePeakDb=${report.truePeakDb}`);
    assert.ok(report.lra >= 0, `lra=${report.lra}`);
  });
});

test("measureLoudness：极安静音频（volume=0.005）→ integratedLufs < -30", async () => {
  await withTempDir(async (dir) => {
    const file = await makeSineWav(dir, "quiet.wav", "volume=0.005");
    const report = await measureLoudness(file);
    assert.ok(report.integratedLufs < -30, `integratedLufs=${report.integratedLufs}`);
  });
});

test("measureLoudness：不存在的文件 → 抛错", async () => {
  await withTempDir(async (dir) => {
    const missing = path.join(dir, "no-such-file.wav");
    await assert.rejects(() => measureLoudness(missing));
  });
});

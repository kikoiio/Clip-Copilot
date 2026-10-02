/**
 * 深度检查组合入口测试（阶段 3 T5）：applyWaivers 纯函数、deepVideoChecks 与
 * deepAudioChecks 的 ffmpeg 集成。合成媒体来自 lavfi 源，小尺寸/短时长保证快；
 * 产物写入 os.tmpdir 临时目录并在测后递归清理，不触碰工作区状态。
 *
 * 已实测锚定的 ffmpeg 行为（8.0.1）：sine 源振幅 -18dBFS（无削波、LUFS 约 -22）；
 * 文件头静音 silencedetect 报 silence_start: 0；concat 后时间戳为精确帧位。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CheckResult, EditPlan, ScorePlan } from "../src/domain.ts";
import { runFfmpeg } from "../src/infra/process.ts";
import { applyWaivers, deepAudioChecks, deepVideoChecks } from "../src/verification/deep.ts";

/** 每个用例独立的临时目录，测后清理。 */
async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "deep-combined-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 合成 wav：args 为完整 ffmpeg 参数（编码器、输出文件与 -y 由本函数追加）。 */
async function makeWav(dir: string, name: string, args: string[]): Promise<string> {
  const file = path.join(dir, name);
  const result = await runFfmpeg([...args, "-c:a", "pcm_s16le", "-y", file], {
    timeoutMs: 2 * 60_000,
  });
  assert.equal(result.exitCode, 0, `生成测试音频失败：${result.stderr.slice(-500)}`);
  return file;
}

/** 合成带音轨的小尺寸 mp4：args 为完整 ffmpeg 参数（编码器、输出文件与 -y 由本函数追加）。 */
async function makeMp4(dir: string, name: string, args: string[]): Promise<string> {
  const file = path.join(dir, name);
  const result = await runFfmpeg(
    [
      ...args,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-y", file,
    ],
    { timeoutMs: 2 * 60_000 },
  );
  assert.equal(result.exitCode, 0, `生成测试视频失败：${result.stderr.slice(-500)}`);
  return file;
}

/** 按 id 取检查结果；缺项即断言失败并打印实际 id 清单。 */
function byId(results: CheckResult[], id: string): CheckResult {
  const result = results.find((r) => r.id === id);
  assert.ok(result, `缺少检查项 ${id}（实际：${results.map((r) => r.id).join("、")}）`);
  return result;
}

/** 每条深度检查结果都必须带 threshold/command/tool（N3 可追溯）。 */
function assertReportFields(results: CheckResult[]): void {
  for (const r of results) {
    assert.ok(r.threshold, `${r.id} 缺 threshold`);
    assert.ok(r.command, `${r.id} 缺 command`);
    assert.ok(r.tool, `${r.id} 缺 tool`);
  }
}

/** 8s 配乐方案：bpm120、4 段各 1 小节（每小节 4 拍 = 2s）。 */
function scorePlan8s(): ScorePlan {
  return {
    bpm: 120,
    beatsPerBar: 4,
    sections: [
      { name: "起", startBar: 0, bars: 1, energy: 0 },
      { name: "承", startBar: 1, bars: 1, energy: 1 },
      { name: "转", startBar: 2, bars: 1, energy: 1 },
      { name: "合", startBar: 3, bars: 1, energy: 2 },
    ],
    tracks: [],
  };
}

/** 4s 视频剪辑方案：120 帧 @30fps、无淡变、单片段。 */
function editPlan4s(fadeInFrames = 0): EditPlan {
  return {
    profile: { width: 320, height: 240, fps: 30 },
    clips: [{ assetId: "asset-a", sourceInMs: 0, timelineStartFrame: 0, durationFrames: 120 }],
    soundtrackArtifactId: "art-score",
    fadeInFrames,
    fadeOutFrames: 0,
  };
}

// ── applyWaivers（纯函数）──────────────────────────────────────────────────

test("applyWaivers：命中豁免的 fail → warn，evidence 追加「已豁免」与原因", () => {
  const results: CheckResult[] = [
    {
      id: "deep:video:black",
      status: "fail",
      evidence: "意外黑帧 1 段：1.00s–2.50s（1.50s）",
      threshold: "淡入 0 帧/淡出 0 帧之外的黑帧判为意外",
      command: "ffmpeg …",
      tool: "ffmpeg + blackdetect",
    },
  ];
  const out = applyWaivers(
    results,
    [{ at: "2026-10-02T00:00:00Z", checkId: "deep:video:black", reason: "转场黑场属设计意图" }],
    "art-video-1",
  );
  assert.equal(out[0]?.status, "warn");
  assert.equal(out[0]?.evidence, "意外黑帧 1 段：1.00s–2.50s（1.50s）；已豁免：转场黑场属设计意图");
  assert.equal(out[0]?.tool, "ffmpeg + blackdetect");
  // 纯函数：不修改入参数组
  assert.equal(results[0]?.status, "fail");
});

test("applyWaivers：checkId 不匹配的豁免不生效，fail 原样", () => {
  const results: CheckResult[] = [{ id: "deep:video:black", status: "fail", evidence: "意外黑帧" }];
  const out = applyWaivers(
    results,
    [{ at: "t", checkId: "deep:video:silence", reason: "豁免的是静音项" }],
    "art-1",
  );
  assert.equal(out[0]?.status, "fail");
  assert.equal(out[0]?.evidence, "意外黑帧");
});

test("applyWaivers：artifactId 限定——限定其他产物不生效，缺省产物对任意 artifactId 生效", () => {
  const results: CheckResult[] = [{ id: "deep:video:clip", status: "fail", evidence: "检测到削波" }];
  // 限定到其他产物：本产物不命中
  const limited = applyWaivers(
    results,
    [{ at: "t", checkId: "deep:video:clip", artifactId: "art-other", reason: "只豁免其他产物" }],
    "art-mine",
  );
  assert.equal(limited[0]?.status, "fail");

  // artifactId 缺省：对任意产物（含参数缺省）生效
  const globalOnNamed = applyWaivers(
    results,
    [{ at: "t", checkId: "deep:video:clip", reason: "全产物豁免" }],
    "art-mine",
  );
  assert.equal(globalOnNamed[0]?.status, "warn");
  assert.match(globalOnNamed[0]?.evidence ?? "", /已豁免：全产物豁免/);

  const globalOnUnnamed = applyWaivers(results, [
    { at: "t", checkId: "deep:video:clip", reason: "全产物豁免" },
  ]);
  assert.equal(globalOnUnnamed[0]?.status, "warn");

  // artifactId 精确相等也命中
  const exact = applyWaivers(
    results,
    [{ at: "t", checkId: "deep:video:clip", artifactId: "art-mine", reason: "定点豁免" }],
    "art-mine",
  );
  assert.equal(exact[0]?.status, "warn");
});

test("applyWaivers：warn/pass/needs_human 原样返回，不追加豁免文案", () => {
  const results: CheckResult[] = [
    { id: "deep:audio:loudness", status: "warn", evidence: "LUFS 越界" },
    { id: "deep:video:align", status: "pass", evidence: "边界全命中" },
    { id: "deep:video:align", status: "needs_human", evidence: "缺少配乐方案数据，无法自动对照" },
  ];
  const waivers = [
    { at: "t", checkId: "deep:audio:loudness", reason: "r1" },
    { at: "t", checkId: "deep:video:align", reason: "r2" },
  ];
  const out = applyWaivers(results, waivers, "art-1");
  assert.deepEqual(out, results);
});

// ── deepAudioChecks ────────────────────────────────────────────────────────

test("deepAudioChecks：8s 纯正弦配 8s 方案 → duration/silence/clip pass、loudness 非 fail", async () => {
  await withTempDir(async (dir) => {
    const file = await makeWav(dir, "clean.wav", [
      "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    ]);
    const results = await deepAudioChecks(file, scorePlan8s(), [], "art-audio-clean");
    assertReportFields(results);
    assert.deepEqual(
      results.map((r) => r.id),
      ["deep:audio:duration", "deep:audio:silence", "deep:audio:clip", "deep:audio:loudness"],
    );
    assert.equal(byId(results, "deep:audio:duration").status, "pass");
    assert.equal(byId(results, "deep:audio:silence").status, "pass");
    assert.equal(byId(results, "deep:audio:clip").status, "pass");
    const loudness = byId(results, "deep:audio:loudness");
    assert.ok(loudness.status === "pass" || loudness.status === "warn", `loudness=${loudness.status}`);
    assert.match(loudness.evidence, /LUFS/);
    assert.match(loudness.evidence, /true peak/);
    assert.match(loudness.evidence, /LRA/);
    for (const r of results) assert.notEqual(r.status, "fail");
  });
});

test("deepAudioChecks：中段拼 2s 静音 → silence fail 且 evidence 指明中段时段", async () => {
  await withTempDir(async (dir) => {
    const file = await makeWav(dir, "mid-silence.wav", [
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
      "-map", "[out]",
    ]);
    const results = await deepAudioChecks(file, scorePlan8s(), []);
    const silence = byId(results, "deep:audio:silence");
    assert.equal(silence.status, "fail");
    // 中段静音约 3s–5s（头尾 1 小节=2s @bpm120 才算有意），时段写入 evidence
    assert.match(silence.evidence, /3\.0\d*s–5\.0\d*s/);
    // 拼接后总长仍 8s：确认 fail 只来自静音而非时长
    assert.equal(byId(results, "deep:audio:duration").status, "pass");
  });
});

test("deepAudioChecks：头部 2s 静音（恰 1 小节 @bpm120）判有意 → silence pass", async () => {
  await withTempDir(async (dir) => {
    const file = await makeWav(dir, "head-silence.wav", [
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]",
      "-map", "[out]",
    ]);
    const results = await deepAudioChecks(file, scorePlan8s(), []);
    const silence = byId(results, "deep:audio:silence");
    assert.equal(silence.status, "pass");
    // 头部静音被归类为有意（而非「根本没检测到」的空洞 pass）
    assert.match(silence.evidence, /有意静音 1 段：0\.00s–2\.0\d*s/);
  });
});

test("deepAudioChecks：实际 8s 配期望 20s 方案 → duration fail（driftMs 负值）", async () => {
  await withTempDir(async (dir) => {
    const file = await makeWav(dir, "short.wav", [
      "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    ]);
    const plan20s: ScorePlan = {
      bpm: 120,
      beatsPerBar: 4,
      sections: [{ name: "长曲", startBar: 0, bars: 10, energy: 1 }],
      tracks: [],
    };
    const results = await deepAudioChecks(file, plan20s, []);
    const duration = byId(results, "deep:audio:duration");
    assert.equal(duration.status, "fail");
    assert.match(duration.evidence, /-12000ms/);
  });
});

// ── deepVideoChecks ────────────────────────────────────────────────────────

test("deepVideoChecks：4s testsrc+正弦、120帧@30fps、单段 ScorePlan → 全部非 fail", async () => {
  await withTempDir(async (dir) => {
    const file = await makeMp4(dir, "ok.mp4", [
      "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    ]);
    const scorePlan: ScorePlan = {
      bpm: 120,
      beatsPerBar: 4,
      sections: [{ name: "全曲", startBar: 0, bars: 2, energy: 1 }],
      tracks: [],
    };
    const results = await deepVideoChecks(file, editPlan4s(), scorePlan, [], "art-video-ok");
    assertReportFields(results);
    assert.deepEqual(
      results.map((r) => r.id),
      [
        "deep:video:duration",
        "deep:video:black",
        "deep:video:silence",
        "deep:video:clip",
        "deep:video:loudness",
        "deep:video:align",
      ],
    );
    assert.equal(byId(results, "deep:video:duration").status, "pass");
    assert.equal(byId(results, "deep:video:black").status, "pass");
    assert.equal(byId(results, "deep:video:silence").status, "pass");
    assert.equal(byId(results, "deep:video:clip").status, "pass");
    assert.equal(byId(results, "deep:video:align").status, "pass");
    assert.match(byId(results, "deep:video:align").evidence, /无段落间边界/);
    for (const r of results) assert.notEqual(r.status, "fail");
  });
});

test("deepVideoChecks：中段 1.5s 黑场 → black fail 指明时段；头部黑场+fadeInFrames=45 → pass", async () => {
  await withTempDir(async (dir) => {
    // 中段黑场：1s testsrc + 1.5s 纯黑 + 1.5s testsrc = 4s，黑场在 [1, 2.5]
    const midFile = await makeMp4(dir, "mid-black.mp4", [
      "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
      "-f", "lavfi", "-i", "color=black:size=320x240:rate=30:duration=1.5",
      "-f", "lavfi", "-i", "testsrc=duration=1.5:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a",
    ]);
    const midResults = await deepVideoChecks(midFile, editPlan4s(), undefined, []);
    const black = byId(midResults, "deep:video:black");
    assert.equal(black.status, "fail");
    assert.match(black.evidence, /1\.0\d*s–2\.5\d*s/);

    // 头部黑场：1.5s 纯黑 + 2.5s testsrc = 4s，黑场在 [0, 1.5] = 淡入区间（45 帧 @30fps）
    const headFile = await makeMp4(dir, "head-black.mp4", [
      "-f", "lavfi", "-i", "color=black:size=320x240:rate=30:duration=1.5",
      "-f", "lavfi", "-i", "testsrc=duration=2.5:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-map", "2:a",
    ]);
    const headResults = await deepVideoChecks(headFile, editPlan4s(45), undefined, []);
    const headBlack = byId(headResults, "deep:video:black");
    assert.equal(headBlack.status, "pass");
    assert.match(headBlack.evidence, /有意黑帧 1 段：0\.00s–1\.5\d*s/);
  });
});

test("deepVideoChecks：ScorePlan 两段（bpm60 边界 4s）+ 切点 2s → align fail 列出偏差", async () => {
  await withTempDir(async (dir) => {
    const file = await makeMp4(dir, "align.mp4", [
      "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    ]);
    const editPlan: EditPlan = {
      profile: { width: 320, height: 240, fps: 30 },
      clips: [
        { assetId: "asset-a", sourceInMs: 0, timelineStartFrame: 0, durationFrames: 60 },
        { assetId: "asset-b", sourceInMs: 0, timelineStartFrame: 60, durationFrames: 60 },
      ],
      soundtrackArtifactId: "art-score",
      fadeInFrames: 0,
      fadeOutFrames: 0,
    };
    const scorePlan: ScorePlan = {
      bpm: 60,
      beatsPerBar: 4,
      sections: [
        { name: "上半", startBar: 0, bars: 1, energy: 0 },
        { name: "下半", startBar: 1, bars: 1, energy: 2 },
      ],
      tracks: [],
    };
    const results = await deepVideoChecks(file, editPlan, scorePlan, []);
    const align = byId(results, "deep:video:align");
    assert.equal(align.status, "fail");
    assert.match(align.evidence, /段落「下半」/);
    assert.match(align.evidence, /边界 4\.00s/);
    assert.match(align.evidence, /最近切点 2\.00s/);
    assert.match(align.evidence, /偏差 -2000ms/);
  });
});

test("deepVideoChecks：scorePlan=undefined → align needs_human（缺少配乐方案数据）", async () => {
  await withTempDir(async (dir) => {
    const file = await makeMp4(dir, "no-score.mp4", [
      "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    ]);
    const results = await deepVideoChecks(file, editPlan4s(), undefined, []);
    const align = byId(results, "deep:video:align");
    assert.equal(align.status, "needs_human");
    assert.match(align.evidence, /缺少配乐方案数据/);
  });
});

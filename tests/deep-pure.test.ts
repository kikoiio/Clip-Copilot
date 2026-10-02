/**
 * 深度检查纯函数单测（阶段 3 T3）：黑帧/静音分类、时长偏差、声画对齐。
 * 只测纯函数，不需要 ffmpeg 与临时文件；媒体检测的组合行为由后续任务补集成用例。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { EditPlan, EditPlanClip, ScorePlan, ScoreSection } from "../src/domain.ts";
import type { TimeSegment } from "../src/verification/media.ts";
import {
  DEEP_CHECK_DEFAULTS,
  checkDurationDeviation,
  checkSectionAlignment,
  classifyBlackSegments,
  classifySilenceSegments,
} from "../src/verification/deep.ts";

/** 便捷构造 TimeSegment。 */
function seg(startSec: number, endSec: number): TimeSegment {
  return { startSec, endSec, durationSec: endSec - startSec };
}

// ── 分类 ──────────────────────────────────────────────────────────────────

test("黑帧分类：淡入/淡出内为 intentional，段中与跨界为 unexpected", () => {
  const segments = [
    seg(0, 0.8), // 完全在头淡入 [0,1] 内
    seg(0.2, 1.0005), // 终点贴住淡入边界，落在 1ms 容差内
    seg(10, 11), // 段中
    seg(0, 1.5), // 起点在淡入内但终点超出 → 跨界
    seg(29, 30), // 完全在尾淡出 [29,30] 内
    seg(28.5, 30), // 起点早于尾淡出区间起点 → 跨界
  ];
  const result = classifyBlackSegments(segments, 1, 1, 30);
  assert.deepEqual(result.intentional, [segments[0], segments[1], segments[4]]);
  assert.deepEqual(result.unexpected, [segments[2], segments[3], segments[5]]);
});

test("黑帧分类：fadeOutSec=0 时尾段 unexpected；fadeIn/fadeOut 均为 0 时全部 unexpected", () => {
  const tailOnly = [seg(28.5, 30)];
  const withFadeOut = classifyBlackSegments(tailOnly, 1, 0, 30);
  assert.deepEqual(withFadeOut.intentional, []);
  assert.deepEqual(withFadeOut.unexpected, tailOnly);

  const mixed = [seg(0, 0.5), seg(15, 16), seg(29, 30)];
  const noFades = classifyBlackSegments(mixed, 0, 0, 30);
  assert.deepEqual(noFades.intentional, []);
  assert.deepEqual(noFades.unexpected, mixed);
});

test("静音分类：与黑帧共用同一判定规则", () => {
  const segments = [
    seg(0, 1), // 恰好铺满头淡入
    seg(0.9, 1.2), // 跨淡入边界
    seg(5, 7), // 段中
    seg(29.5, 30), // 尾淡出内
  ];
  const result = classifySilenceSegments(segments, 1, 1, 30);
  assert.deepEqual(result.intentional, [segments[0], segments[3]]);
  assert.deepEqual(result.unexpected, [segments[1], segments[2]]);
});

// ── 时长偏差 ──────────────────────────────────────────────────────────────

test("时长偏差：driftMs 带符号，|drift| ≤ 容差为 ok（恰等于容差也算命中）", () => {
  assert.deepEqual(checkDurationDeviation(10499, 10000, 500), { ok: true, driftMs: 499 });
  assert.deepEqual(checkDurationDeviation(9501, 10000, 500), { ok: true, driftMs: -499 });
  assert.deepEqual(checkDurationDeviation(10600, 10000, 500), { ok: false, driftMs: 600 });
  assert.deepEqual(checkDurationDeviation(9400, 10000, 500), { ok: false, driftMs: -600 });
  assert.equal(checkDurationDeviation(10500, 10000, 500).ok, true);
});

// ── 声画对齐 ──────────────────────────────────────────────────────────────

const FPS = 30;

/** 3 段配乐方案：bpm120、4 拍/小节 → 每小节 2s，段落间边界在 24s / 48s。 */
function scorePlan3Sections(): ScorePlan {
  const sections: ScoreSection[] = [
    { name: "开头", startBar: 0, bars: 12, energy: 0 },
    { name: "推进", startBar: 12, bars: 12, energy: 1 },
    { name: "高潮", startBar: 24, bars: 8, energy: 2 },
  ];
  return { bpm: 120, beatsPerBar: 4, sections, tracks: [] };
}

/** 构造切点落在给定秒数（按 30fps 取整帧）的剪辑方案；首段固定从 0 帧开始。 */
function editPlanWithCuts(cutSecs: number[]): EditPlan {
  const starts = [0, ...cutSecs.map((s) => Math.round(s * FPS))];
  const clips: EditPlanClip[] = starts.map((start, i) => ({
    assetId: `clip-${i}`,
    sourceInMs: 0,
    timelineStartFrame: start,
    durationFrames: (starts[i + 1] ?? start + FPS) - start,
  }));
  return {
    profile: { width: 1920, height: 1080, fps: FPS },
    clips,
    soundtrackArtifactId: "art-score",
    fadeInFrames: 0,
    fadeOutFrames: 0,
  };
}

test("对齐：切点恰在段落边界（24s/48s）→ 无 mismatch", () => {
  const mismatches = checkSectionAlignment(
    editPlanWithCuts([24, 48]),
    scorePlan3Sections(),
    DEEP_CHECK_DEFAULTS.alignmentToleranceMs,
  );
  assert.deepEqual(mismatches, []);
});

test("对齐：切点 23.4s（偏差 600ms > 容差）→ 1 条 mismatch，diffMs 带符号", () => {
  // 切点早于边界 600ms：偏差为负
  const early = checkSectionAlignment(editPlanWithCuts([23.4, 48]), scorePlan3Sections(), 500);
  assert.equal(early.length, 1);
  assert.deepEqual(early[0], {
    sectionName: "推进",
    sectionTimeSec: 24,
    nearestCutSec: 23.4,
    diffMs: -600,
  });

  // 切点晚于边界 600ms：偏差为正
  const late = checkSectionAlignment(editPlanWithCuts([24.6, 48]), scorePlan3Sections(), 500);
  assert.equal(late.length, 1);
  assert.deepEqual(late[0], {
    sectionName: "推进",
    sectionTimeSec: 24,
    nearestCutSec: 24.6,
    diffMs: 600,
  });
});

test("对齐：配乐只有 1 段（无段落间边界）→ []", () => {
  const score: ScorePlan = {
    bpm: 120,
    beatsPerBar: 4,
    sections: [{ name: "全曲", startBar: 0, bars: 32, energy: 1 }],
    tracks: [],
  };
  assert.deepEqual(checkSectionAlignment(editPlanWithCuts([10, 20]), score, 500), []);
});

test("对齐：剪辑只有 1 个片段（无切点可用）→ mismatch 的 nearestCutSec/diffMs 为 null", () => {
  const mismatches = checkSectionAlignment(editPlanWithCuts([]), scorePlan3Sections(), 500);
  assert.deepEqual(mismatches, [
    { sectionName: "推进", sectionTimeSec: 24, nearestCutSec: null, diffMs: null },
    { sectionName: "高潮", sectionTimeSec: 48, nearestCutSec: null, diffMs: null },
  ]);
});

// ── 常量 ──────────────────────────────────────────────────────────────────

test("DEEP_CHECK_DEFAULTS 与 plan.md 固定阈值一致", () => {
  assert.deepEqual(DEEP_CHECK_DEFAULTS, {
    blackMinDurationSec: 0.5,
    silenceNoiseDb: -50,
    silenceMinDurationSec: 1,
    minConsecutiveClippedSamples: 3,
    durationToleranceMs: 500,
    alignmentToleranceMs: 500,
    loudnessRangeLufs: [-30, -6],
    headlessTimeoutMs: 5 * 60_000,
  });
});

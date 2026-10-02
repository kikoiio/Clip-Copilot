/**
 * 深度检查层（阶段 3 模块 A）。
 *
 * 五类检查：黑帧/静音「有意/意外」分类、连续满幅样本削波、EBU R128 响度、
 * 产物时长 vs 计划偏差、配乐段落边界 vs 剪辑切点对齐。接口契约见
 * docs/spec_docs/phase-3/plan.md 的「核心数据结构」「模块 A」两节。
 *
 * 本文件当前只实现纯函数与常量；ffmpeg 媒体检测与组合入口
 * （detectClipping / measureLoudness / deepVideoChecks / deepAudioChecks）
 * 由后续任务在文末预留分节处追加，勿打乱既有分节顺序。
 *
 * 分类依据单一来源：计划声明的 fade 参数与段落结构（spec F4）；本模块除类型外
 * 不读工作区状态，检查只读产物，输出一律进 evidence/ 或临时目录。
 */

import type { EditPlan, ScorePlan } from "../domain.ts";
import type { TimeSegment } from "./media.ts";

// ───────────────────────────────────────────────────────────────────────────
// 常量
// ───────────────────────────────────────────────────────────────────────────

/**
 * 深度检查默认阈值（plan.md「核心数据结构」）。
 * 逐项写入 CheckResult.threshold，复核时无需读源码（N3/N4）。
 */
export const DEEP_CHECK_DEFAULTS = {
  /** blackdetect d=，沿用现有。 */
  blackMinDurationSec: 0.5,
  /** silencedetect noise=，沿用现有。 */
  silenceNoiseDb: -50,
  /** silencedetect d=，沿用现有。 */
  silenceMinDurationSec: 1,
  /** 削波：连续满幅样本数下限。 */
  minConsecutiveClippedSamples: 3,
  /** 产物时长 vs 计划时长容差（毫秒）。 */
  durationToleranceMs: 500,
  /** 配乐段落边界 vs 剪辑切点容差（毫秒）。 */
  alignmentToleranceMs: 500,
  /** integrated LUFS 异常范围（越界=warn）。 */
  loudnessRangeLufs: [-30, -6] as const,
  /** 单个无界面渲染验证超时（毫秒）。 */
  headlessTimeoutMs: 5 * 60_000,
};

// ───────────────────────────────────────────────────────────────────────────
// 分类（纯函数）：黑帧 / 静音候选 → 有意 / 意外
// ───────────────────────────────────────────────────────────────────────────

/** 分类结果：intentional=计划声明区间内的有意段；unexpected=其余意外段。 */
export interface ClassifiedSegments {
  intentional: TimeSegment[];
  unexpected: TimeSegment[];
}

/** 淡变边界比较的浮点容差：1ms。 */
const FADE_EDGE_TOLERANCE_SEC = 0.001;

/**
 * 统一分类规则（spec F4）：候选段完全落在头淡入 [0, fadeInSec] 或
 * 尾淡出 [totalSec − fadeOutSec, totalSec] 内 = 有意，其余 = 意外。
 * 端点比较带 1ms 浮点容差（如 startSec ≥ −0.001 且 endSec ≤ 区间端 + 0.001）；
 * fade 长度 ≤ 0 视为对应区间不存在（fadeOutSec=0 时尾部段一律意外，fadeInSec 同理）。
 * 黑帧与静音共用本实现，避免两套判定漂移。
 */
function classifyByFade(
  segments: TimeSegment[],
  fadeInSec: number,
  fadeOutSec: number,
  totalSec: number,
): ClassifiedSegments {
  // 长度 ≤ 0 的淡变区间视为不存在。
  const headEndSec = fadeInSec > 0 ? fadeInSec : null;
  const tailStartSec = fadeOutSec > 0 ? totalSec - fadeOutSec : null;
  const intentional: TimeSegment[] = [];
  const unexpected: TimeSegment[] = [];
  for (const segment of segments) {
    const inHead =
      headEndSec !== null &&
      segment.startSec >= -FADE_EDGE_TOLERANCE_SEC &&
      segment.endSec <= headEndSec + FADE_EDGE_TOLERANCE_SEC;
    const inTail =
      tailStartSec !== null &&
      segment.startSec >= tailStartSec - FADE_EDGE_TOLERANCE_SEC &&
      segment.endSec <= totalSec + FADE_EDGE_TOLERANCE_SEC;
    (inHead || inTail ? intentional : unexpected).push(segment);
  }
  return { intentional, unexpected };
}

/** 黑帧候选分类：入参为 detectBlackSegments 的输出。 */
export function classifyBlackSegments(
  segments: TimeSegment[],
  fadeInSec: number,
  fadeOutSec: number,
  totalSec: number,
): ClassifiedSegments {
  return classifyByFade(segments, fadeInSec, fadeOutSec, totalSec);
}

/** 静音候选分类：入参为 detectSilenceSegments 的输出。 */
export function classifySilenceSegments(
  segments: TimeSegment[],
  fadeInSec: number,
  fadeOutSec: number,
  totalSec: number,
): ClassifiedSegments {
  return classifyByFade(segments, fadeInSec, fadeOutSec, totalSec);
}

// ───────────────────────────────────────────────────────────────────────────
// 纯函数对照：时长偏差 / 声画段落对齐
// ───────────────────────────────────────────────────────────────────────────

/** 微秒级取整：消除二进制浮点噪声；精度远高于帧/毫秒量级，不影响任何判定。 */
function roundMicro(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 产物实际时长 vs 计划时长：driftMs = actualMs − expectedMs（带符号），
 * |driftMs| ≤ toleranceMs 视为 ok。
 */
export function checkDurationDeviation(
  actualMs: number,
  expectedMs: number,
  toleranceMs: number,
): { ok: boolean; driftMs: number } {
  const driftMs = roundMicro(actualMs - expectedMs);
  return { ok: Math.abs(driftMs) <= toleranceMs, driftMs };
}

/** 单条对齐失配：段落边界未命中任何剪辑切点（或无切点可用）。 */
export interface AlignmentMismatch {
  /** 段落名。 */
  sectionName: string;
  /** 段落边界时刻（秒）。 */
  sectionTimeSec: number;
  /** 距边界最近的切点（秒）；剪辑无切点可用时为 null。 */
  nearestCutSec: number | null;
  /** 切点 − 边界 的带符号毫秒差（早为负、晚为正）；无切点时为 null。 */
  diffMs: number | null;
}

/**
 * 声画节奏点对齐（纯计划对照，不分析媒体内容，spec F4）：
 * 段落间边界 = sections[1..] 的 startBar 换算秒（bar × beatsPerBar × 60 / bpm）；
 * 剪辑切点 = clips[1..] 的 timelineStartFrame / profile.fps（首段从 0 起，不算切点）。
 * 每个边界取最近切点，|diff| ≤ toleranceMs/1000 秒为命中；全部命中返回 []，
 * 未命中的逐条返回。sections 只有 1 段时无段落间边界，返回 []。
 */
export function checkSectionAlignment(
  editPlan: EditPlan,
  scorePlan: ScorePlan,
  toleranceMs: number,
): AlignmentMismatch[] {
  const boundaries = scorePlan.sections.slice(1).map((section) => ({
    name: section.name,
    timeSec: roundMicro((section.startBar * scorePlan.beatsPerBar * 60) / scorePlan.bpm),
  }));
  const cuts = editPlan.clips
    .slice(1)
    .map((clip) => roundMicro(clip.timelineStartFrame / editPlan.profile.fps));
  const mismatches: AlignmentMismatch[] = [];
  for (const boundary of boundaries) {
    let nearestCutSec: number | null = null;
    let nearestDiffSec = Number.POSITIVE_INFINITY;
    for (const cut of cuts) {
      const diffSec = Math.abs(cut - boundary.timeSec);
      if (diffSec < nearestDiffSec) {
        nearestDiffSec = diffSec;
        nearestCutSec = cut;
      }
    }
    // 有切点且落在容差内 = 命中；否则（超容差或无切点）逐条记失配。
    if (nearestCutSec !== null && nearestDiffSec <= toleranceMs / 1000) continue;
    mismatches.push({
      sectionName: boundary.name,
      sectionTimeSec: boundary.timeSec,
      nearestCutSec,
      diffMs: nearestCutSec === null ? null : roundMicro((nearestCutSec - boundary.timeSec) * 1000),
    });
  }
  return mismatches;
}

// ───────────────────────────────────────────────────────────────────────────
// 削波检测（detectClipping）：ffmpeg s16le PCM 连续满幅游程扫描——后续任务追加
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// 响度检测（measureLoudness）：ffmpeg ebur128 统计解析——后续任务追加
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// 组合入口（deepVideoChecks / deepAudioChecks）：渲染流程与 verify 共用——后续任务追加
// ───────────────────────────────────────────────────────────────────────────

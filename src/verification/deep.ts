/**
 * 深度检查层（阶段 3 模块 A）。
 *
 * 五类检查：黑帧/静音「有意/意外」分类、连续满幅样本削波、EBU R128 响度、
 * 产物时长 vs 计划偏差、配乐段落边界 vs 剪辑切点对齐。接口契约见
 * docs/spec_docs/phase-3/plan.md 的「核心数据结构」「模块 A」两节。
 *
 * ffmpeg 媒体检测（detectClipping / measureLoudness）在文末对应分节实现；
 * 组合入口（deepVideoChecks / deepAudioChecks）由后续任务追加，勿打乱既有分节顺序。
 *
 * 分类依据单一来源：计划声明的 fade 参数与段落结构（spec F4）；本模块除类型外
 * 不读工作区状态，检查只读产物，输出一律进 evidence/ 或临时目录。
 */

import { spawn } from "node:child_process";

import type { EditPlan, ScorePlan } from "../domain.ts";
import type { TimeSegment } from "./media.ts";
import { runFfmpeg } from "../infra/process.ts";

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
// 削波检测（detectClipping）：ffmpeg s16le PCM 连续满幅游程扫描
// ───────────────────────────────────────────────────────────────────────────

/** 削波扫描结果。 */
export interface ClippingReport {
  /** 最长连续满幅游程长度（样本数）。 */
  maxConsecutive: number;
  /** 满幅样本总数。 */
  clippedSamples: number;
}

/** s16le 满幅判定阈值：|sample| ≥ 32767（正向满幅 32767，负向满幅 -32768）。 */
const S16_FULLSCALE_THRESHOLD = 32767;

/**
 * 纯函数：对解码后的 s16le 样本流扫描满幅（|sample| ≥ 32767）连续游程。
 * maxConsecutive = 最长连续满幅游程长度；clippedSamples = 满幅样本总数。
 * 双声道交织流按样本流直接扫描，左右声道连续计数可接受，不分离声道。
 * minConsecutive 不改变统计值——组合入口以 maxConsecutive ≥ minConsecutive
 * 判削波（阈值 DEEP_CHECK_DEFAULTS.minConsecutiveClippedSamples），
 * 入参保留以对齐 plan.md 的接口契约。
 */
export function countClippedRuns(samples: Int16Array, minConsecutive: number): ClippingReport {
  let maxConsecutive = 0;
  let clippedSamples = 0;
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    if (sample >= S16_FULLSCALE_THRESHOLD || sample <= -S16_FULLSCALE_THRESHOLD) {
      run += 1;
      clippedSamples += 1;
      if (run > maxConsecutive) maxConsecutive = run;
    } else {
      run = 0;
    }
  }
  return { maxConsecutive, clippedSamples };
}

/** 媒体分析统一超时，与 media.ts 各检测的 10 分钟一致。 */
const MEDIA_ANALYSIS_TIMEOUT_MS = 10 * 60_000;

/**
 * 削波检测：ffmpeg 把音频解码为 48kHz 双声道 s16le PCM（-vn 丢视频），
 * 逐样本扫描满幅游程。不能复用 runProcess——其 stdout 按 utf8 文本捕获，
 * 二进制 PCM 会损坏；这里用 spawn 以 Buffer 块累积 stdout，结束再转 Int16Array。
 * 解码失败 / 超时 / 无音频流一律抛错，不返回部分结果。
 */
export async function detectClipping(
  file: string,
  minConsecutive: number,
): Promise<ClippingReport> {
  const args = ["-v", "error", "-i", file, "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "-"];
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, MEDIA_ANALYSIS_TIMEOUT_MS);
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${message}${stderr ? `\nstderr: ${stderr.slice(-500)}` : ""}`));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => fail(`ffmpeg 启动失败：${String(err)}`));
    child.on("close", (code) => {
      if (settled) return;
      if (timedOut) {
        fail(`detectClipping 超时（>${MEDIA_ANALYSIS_TIMEOUT_MS / 1000}s）`);
        return;
      }
      if (code !== 0) {
        fail(`detectClipping 失败：退出码 ${code}`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
  // 尾部不足 2 字节的残缺字节丢弃；Buffer 底层偏移不对齐时回退逐样本读取。
  const sampleCount = Math.floor(pcm.byteLength / 2);
  const samples =
    pcm.byteOffset % 2 === 0
      ? new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount)
      : Int16Array.from({ length: sampleCount }, (_, i) => pcm.readInt16LE(i * 2));
  return countClippedRuns(samples, minConsecutive);
}

// ───────────────────────────────────────────────────────────────────────────
// 响度检测（measureLoudness）：ffmpeg ebur128 统计解析
// ───────────────────────────────────────────────────────────────────────────

/** EBU R128 响度统计（ITU-R BS.1770）。 */
export interface LoudnessReport {
  /** integrated loudness（LUFS）。 */
  integratedLufs: number;
  /** true peak（dBFS）。 */
  truePeakDb: number;
  /** loudness range（LU）。 */
  lra: number;
}

/**
 * 响度测量：ffmpeg ebur128 过滤器（peak=true 含 true peak）。
 * 过程行逐帧输出非常吵，Summary 块固定在结尾；runProcess 的 stderr 保留头尾
 * （超长时中段省略）但结尾不丢，故取 stderr 最后一次出现的 Summary 块解析，
 * 避免误读过程行里的 I / LRA 数值。任一值解析不到即抛错，不返回部分结果。
 */
export async function measureLoudness(file: string): Promise<LoudnessReport> {
  const result = await runFfmpeg(
    ["-v", "info", "-i", file, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
    { timeoutMs: MEDIA_ANALYSIS_TIMEOUT_MS },
  );
  if (result.timedOut) {
    throw new Error(`measureLoudness 超时（>${MEDIA_ANALYSIS_TIMEOUT_MS / 1000}s）：${file}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `measureLoudness 失败：退出码 ${result.exitCode}\nstderr: ${result.stderr.slice(-500)}`,
    );
  }
  const summaryStart = result.stderr.lastIndexOf("Summary:");
  if (summaryStart < 0) {
    throw new Error(`ebur128 未输出 Summary 块：${file}\nstderr: ${result.stderr.slice(-500)}`);
  }
  const summary = result.stderr.slice(summaryStart);
  const i = /I:\s+(-?[\d.]+)\s+LUFS/.exec(summary);
  const peak = /Peak:\s+(-?[\d.]+)\s+dBFS/.exec(summary);
  const lra = /LRA:\s+(-?[\d.]+)\s+LU/.exec(summary);
  if (!i || !peak || !lra) {
    throw new Error(`ebur128 Summary 解析失败（缺 I/Peak/LRA）：${file}\n${summary.slice(-500)}`);
  }
  return {
    integratedLufs: Number(i[1]),
    truePeakDb: Number(peak[1]),
    lra: Number(lra[1]),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 组合入口（deepVideoChecks / deepAudioChecks）：渲染流程与 verify 共用——后续任务追加
// ───────────────────────────────────────────────────────────────────────────

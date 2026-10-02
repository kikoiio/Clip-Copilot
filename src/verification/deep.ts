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
 * 淡变区间外缘的测量容差（0.15s ≈ 4.5 帧 @30fps）：编码压缩会让淡变结束后的
 * 暗帧滞留 1-2 帧仍低于 blackdetect 阈值（实测城市入夜 2s 淡入检出 2.03s 黑场），
 * 淡入淡出声明范围内的检出段略超范围的部分视为「有意」，否则计划内淡入会被误报。
 * 超出该容差仍判意外，真实缺陷不受影响。
 */
const FADE_OVERSHOOT_SEC = 0.15;

/**
 * 统一分类规则（spec F4）：候选段完全落在头淡入 [0, fadeInSec] 或
 * 尾淡出 [totalSec − fadeOutSec, totalSec] 内 = 有意，其余 = 意外。
 * 端点比较带 1ms 浮点容差，区间外缘另放宽 FADE_OVERSHOOT_SEC 测量容差；
 * fade 长度 ≤ 0 视为对应区间不存在（fadeOutSec=0 时尾部段一律意外，fadeInSec 同理）。
 * 黑帧与静音共用本实现，避免两套判定漂移。
 */
function classifyByFade(
  segments: TimeSegment[],
  fadeInSec: number,
  fadeOutSec: number,
  totalSec: number,
): ClassifiedSegments {
  // 长度 ≤ 0 的淡变区间视为不存在；外缘按测量容差放宽。
  const headEndSec = fadeInSec > 0 ? fadeInSec + FADE_OVERSHOOT_SEC : null;
  const tailStartSec = fadeOutSec > 0 ? totalSec - fadeOutSec - FADE_OVERSHOOT_SEC : null;
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
// 组合入口（deepVideoChecks / deepAudioChecks）：渲染流程与 verify 共用
// ───────────────────────────────────────────────────────────────────────────

// 组合入口的依赖随本分节追加于文末，保持上方既有 import 块不动（import 声明会被提升）。
import type { CheckResult, CheckStatus, MediaInfo, WaiverRecord } from "../domain.ts";
import { scoreDurationMs } from "../domain.ts";
import {
  BLACKDETECT_FILTER,
  detectBlackSegments,
  detectSilenceSegments,
  probeMedia,
} from "./media.ts";

/**
 * 纯函数：豁免降级（plan.md「WaiverRecord」）。命中豁免的 fail → status "warn"，
 * evidence 追加「；已豁免：<原因>」，原证据与 threshold/command/tool 保留。
 * 匹配规则：waiver.checkId === result.id，且 waiver.artifactId 缺省（该检查项在
 * 所有产物上豁免）或等于 artifactId 参数。只影响 fail；pass/warn/needs_* 原样返回。
 * 多条豁免同时命中时按豁免记录顺序取第一条；不修改入参数组。
 */
export function applyWaivers(
  results: CheckResult[],
  waivers: WaiverRecord[],
  artifactId?: string,
): CheckResult[] {
  return results.map((result) => {
    if (result.status !== "fail") return result;
    const waiver = waivers.find(
      (w) =>
        w.checkId === result.id &&
        (w.artifactId === undefined || w.artifactId === artifactId),
    );
    if (!waiver) return result;
    return {
      ...result,
      status: "warn",
      evidence: `${result.evidence}；已豁免：${waiver.reason}`,
    };
  });
}

/** 检查项静态描述：id 与报告要求的 threshold/command/tool（N3 可追溯）。 */
interface CheckSpec {
  id: string;
  threshold?: string;
  command?: string;
  tool?: string;
}

/**
 * 单项执行包装：深度检查自身异常按 fail 处理，不得静默跳过——渲染闸门、
 * checkpoint 门禁与 verify 退出码都只消费 fail/warn，静默跳过会让坏产物流过。
 * run() 正常返回判定；抛错时该项整体降为 fail，错误信息写入 evidence，
 * 静态字段（threshold/command/tool）照常保留。
 */
async function runGuarded(
  spec: CheckSpec,
  run: () => Promise<{ status: CheckStatus; evidence: string }>,
): Promise<CheckResult> {
  try {
    const { status, evidence } = await run();
    return { ...spec, status, evidence };
  } catch (err) {
    return {
      ...spec,
      status: "fail",
      evidence: `深度检查执行异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 共享 ffprobe：时长/黑帧/静音三项都需要实际总时长，探测一次即可；
 * 失败时缓存错误，依赖它的各检查项分别拿到同一失败原因并各自 fail。
 */
function createLazyProbe(file: string): () => Promise<MediaInfo> {
  let cache: MediaInfo | null = null;
  let error: Error | null = null;
  return async () => {
    if (cache !== null) return cache;
    if (error !== null) throw error;
    try {
      cache = await probeMedia(file);
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      throw error;
    }
    return cache;
  };
}

/** 段落 evidence 文案：如「3.00s–5.00s（2.00s）」。 */
function formatSegment(segment: TimeSegment): string {
  return `${segment.startSec.toFixed(2)}s–${segment.endSec.toFixed(2)}s（${segment.durationSec.toFixed(2)}s）`;
}

/** 分类结果 evidence：意外段与有意段都列出（intentional/pass 项也要给证据）。 */
function describeClassified(kind: string, classified: ClassifiedSegments): string {
  const unexpected =
    classified.unexpected.length > 0
      ? `意外${kind} ${classified.unexpected.length} 段：${classified.unexpected.map(formatSegment).join("、")}`
      : `无意外${kind}`;
  const intentional =
    classified.intentional.length > 0
      ? `有意${kind} ${classified.intentional.length} 段：${classified.intentional.map(formatSegment).join("、")}`
      : `无有意${kind}`;
  return `${unexpected}；${intentional}`;
}

/** 时长检查：期望毫秒由调用方给出（视频=计划总帧数换算，音频=scoreDurationMs）。 */
function durationCheck(
  id: string,
  file: string,
  expectedMs: number,
  probe: () => Promise<MediaInfo>,
): Promise<CheckResult> {
  const toleranceMs = DEEP_CHECK_DEFAULTS.durationToleranceMs;
  return runGuarded(
    {
      id,
      threshold: `|实际时长−期望时长| ≤ ${toleranceMs}ms（durationToleranceMs）`,
      command: `ffprobe -v error -print_format json -show_format -show_streams ${file}`,
      tool: "ffprobe",
    },
    async () => {
      const info = await probe();
      const { ok, driftMs } = checkDurationDeviation(info.durationMs, expectedMs, toleranceMs);
      const detail =
        `期望 ${(expectedMs / 1000).toFixed(2)}s（计划），实际 ${(info.durationMs / 1000).toFixed(2)}s，` +
        `偏差 ${driftMs > 0 ? "+" : ""}${driftMs}ms`;
      return {
        status: ok ? "pass" : "fail",
        evidence: ok ? `时长在容差内：${detail}` : `时长超差：${detail}`,
      };
    },
  );
}

/** 分类函数的通用形参形态（classifyBlackSegments / classifySilenceSegments 共用）。 */
type SegmentClassifier = (
  segments: TimeSegment[],
  fadeInSec: number,
  fadeOutSec: number,
  totalSec: number,
) => ClassifiedSegments;

/** 黑帧/静音检查共用骨架：detect 候选 → 按有意区间分类 → 有意外段即 fail。 */
interface SegmentCheckArgs {
  id: string;
  /** 「黑帧」/「静音」，用于 evidence 文案。 */
  kind: string;
  file: string;
  detect: (file: string) => Promise<TimeSegment[]>;
  classify: SegmentClassifier;
  /** 有意区间的头/尾长度（秒）。 */
  fadeInSec: number;
  fadeOutSec: number;
  probe: () => Promise<MediaInfo>;
  threshold: string;
  command: string;
  tool: string;
}

function segmentCheck(args: SegmentCheckArgs): Promise<CheckResult> {
  return runGuarded(
    { id: args.id, threshold: args.threshold, command: args.command, tool: args.tool },
    async () => {
      // totalSec 用实际文件时长：淡出区间锚定在实际文件结尾，而非计划值。
      const info = await args.probe();
      const totalSec = info.durationMs / 1000;
      const classified = args.classify(
        await args.detect(args.file),
        args.fadeInSec,
        args.fadeOutSec,
        totalSec,
      );
      const ranges: string[] = [];
      if (args.fadeInSec > 0) ranges.push(`头部 [0, ${args.fadeInSec.toFixed(3)}s]`);
      if (args.fadeOutSec > 0) {
        ranges.push(`尾部 [${(totalSec - args.fadeOutSec).toFixed(3)}s, ${totalSec.toFixed(3)}s]`);
      }
      const scope =
        ranges.length > 0
          ? `有意区间（计划声明）：${ranges.join("、")}`
          : "计划未声明有意区间，候选一律判为意外";
      return {
        status: classified.unexpected.length > 0 ? "fail" : "pass",
        evidence:
          `${scope}；${describeClassified(args.kind, classified)}（实际总时长 ${totalSec.toFixed(3)}s）`,
      };
    },
  );
}

/** 削波检查：最长连续满幅游程 ≥ 阈值即 fail（detectClipping 抛错由 runGuarded 接住）。 */
function clipCheck(id: string, file: string): Promise<CheckResult> {
  const minConsecutive = DEEP_CHECK_DEFAULTS.minConsecutiveClippedSamples;
  return runGuarded(
    {
      id,
      threshold: `≥${minConsecutive} 个连续满幅样本（s16le |sample| ≥ 32767）判削波`,
      command: `ffmpeg -v error -i ${file} -vn -ac 2 -ar 48000 -f s16le -`,
      tool: "ffmpeg + s16le PCM 游程扫描",
    },
    async () => {
      const report = await detectClipping(file, minConsecutive);
      const detail =
        `最长连续满幅游程 ${report.maxConsecutive} 个样本，满幅样本总数 ${report.clippedSamples}`;
      return {
        status: report.maxConsecutive >= minConsecutive ? "fail" : "pass",
        evidence:
          report.maxConsecutive >= minConsecutive
            ? `检测到削波：${detail}`
            : `未检测到削波：${detail}`,
      };
    },
  );
}

/** 响度检查：integrated LUFS 越界只判 warn（不 fail），避免风格性响度误伤（spec F1）。 */
function loudnessCheck(id: string, file: string): Promise<CheckResult> {
  const [minLufs, maxLufs] = DEEP_CHECK_DEFAULTS.loudnessRangeLufs;
  return runGuarded(
    {
      id,
      threshold: `integrated LUFS 在 [${minLufs}, ${maxLufs}] 内为 pass，越界判 warn（loudnessRangeLufs）`,
      command: `ffmpeg -v info -i ${file} -filter_complex ebur128=peak=true -f null -`,
      tool: "ffmpeg + ebur128",
    },
    async () => {
      const report = await measureLoudness(file);
      const inRange = report.integratedLufs >= minLufs && report.integratedLufs <= maxLufs;
      return {
        status: inRange ? "pass" : "warn",
        evidence:
          `integrated ${report.integratedLufs} LUFS，true peak ${report.truePeakDb} dBFS，LRA ${report.lra} LU` +
          (inRange ? "（在判定范围内）" : "（越界：响度异常判 warn，不阻塞）"),
      };
    },
  );
}

/** 声画对齐检查：scorePlan 缺失 → needs_human；纯计划对照，不分析媒体内容（spec F4）。 */
function alignCheck(editPlan: EditPlan, scorePlan: ScorePlan | undefined): Promise<CheckResult> {
  const toleranceMs = DEEP_CHECK_DEFAULTS.alignmentToleranceMs;
  return runGuarded(
    {
      id: "deep:video:align",
      threshold: `配乐段落边界与最近剪辑切点偏差 ≤ ${toleranceMs}ms（alignmentToleranceMs）`,
      command: "（无外部命令：checkSectionAlignment 纯计划对照）",
      tool: "deep.checkSectionAlignment（纯函数）",
    },
    async () => {
      if (scorePlan === undefined) {
        return { status: "needs_human", evidence: "缺少配乐方案数据，无法自动对照" };
      }
      const mismatches = checkSectionAlignment(editPlan, scorePlan, toleranceMs);
      if (mismatches.length === 0) {
        return {
          status: "pass",
          evidence:
            scorePlan.sections.length <= 1
              ? `配乐仅 ${scorePlan.sections.length} 段，无段落间边界需对照（剪辑 ${editPlan.clips.length} 个片段）`
              : `配乐 ${scorePlan.sections.length} 段的段落间边界全部命中剪辑切点`,
        };
      }
      const detail = mismatches
        .map((m) => {
          const cut =
            m.nearestCutSec === null
              ? "无切点可用"
              : `最近切点 ${m.nearestCutSec.toFixed(2)}s，偏差 ${m.diffMs}ms`;
          return `段落「${m.sectionName}」边界 ${m.sectionTimeSec.toFixed(2)}s，${cut}`;
        })
        .join("；");
      return {
        status: "fail",
        evidence: `${mismatches.length} 个段落边界未命中剪辑切点：${detail}`,
      };
    },
  );
}

/**
 * 视频深度检查组合入口：时长/黑帧/静音/削波/响度/声画对齐各一条 CheckResult，
 * 函数末尾对全部结果 applyWaivers 后返回（渲染流程与 verify 共用，plan.md 模块 A）。
 * totalSec 用 probeMedia 实际时长，淡出区间锚定在实际文件结尾；单项异常按 fail
 * 处理不中断其余检查项。
 */
export async function deepVideoChecks(
  file: string,
  editPlan: EditPlan,
  scorePlan: ScorePlan | undefined,
  waivers: WaiverRecord[],
  artifactId?: string,
): Promise<CheckResult[]> {
  const probe = createLazyProbe(file);
  const fps = editPlan.profile.fps;
  const totalFrames = editPlan.clips.reduce((sum, clip) => sum + clip.durationFrames, 0);
  const expectedMs = (totalFrames / fps) * 1000;
  const fadeInSec = editPlan.fadeInFrames / fps;
  const fadeOutSec = editPlan.fadeOutFrames / fps;
  const results: CheckResult[] = [];

  // 1. 时长：计划总帧数 / fps 换算期望，对照 ffprobe 实际时长。
  results.push(await durationCheck("deep:video:duration", file, expectedMs, probe));

  // 2. 黑帧：blackdetect 候选 → 计划淡入/淡出范围分类，有意外段即 fail。
  results.push(
    await segmentCheck({
      id: "deep:video:black",
      kind: "黑帧",
      file,
      detect: detectBlackSegments,
      classify: classifyBlackSegments,
      fadeInSec,
      fadeOutSec,
      probe,
      threshold: `淡入 ${editPlan.fadeInFrames} 帧/淡出 ${editPlan.fadeOutFrames} 帧之外的黑帧判为意外（blackdetect d=${DEEP_CHECK_DEFAULTS.blackMinDurationSec}s:pix_th=0.10）`,
      command: `ffmpeg -v info -i ${file} -vf ${BLACKDETECT_FILTER} -an -f null -`,
      tool: "ffmpeg + blackdetect",
    }),
  );

  // 3. 静音：silencedetect 候选 → 同一淡入/淡出范围分类。
  results.push(
    await segmentCheck({
      id: "deep:video:silence",
      kind: "静音",
      file,
      detect: detectSilenceSegments,
      classify: classifySilenceSegments,
      fadeInSec,
      fadeOutSec,
      probe,
      threshold: `淡入 ${editPlan.fadeInFrames} 帧/淡出 ${editPlan.fadeOutFrames} 帧之外、时长 ≥ ${DEEP_CHECK_DEFAULTS.silenceMinDurationSec}s 且低于 ${DEEP_CHECK_DEFAULTS.silenceNoiseDb}dB 的静音判为意外`,
      command: `ffmpeg -v info -i ${file} -af silencedetect=noise=${DEEP_CHECK_DEFAULTS.silenceNoiseDb}dB:d=${DEEP_CHECK_DEFAULTS.silenceMinDurationSec} -f null -`,
      tool: "ffmpeg + silencedetect",
    }),
  );

  // 4. 削波 / 5. 响度（越界 warn）/ 6. 声画对齐（计划缺失 → needs_human）。
  results.push(await clipCheck("deep:video:clip", file));
  results.push(await loudnessCheck("deep:video:loudness", file));
  results.push(await alignCheck(editPlan, scorePlan));

  return applyWaivers(results, waivers, artifactId);
}

/**
 * 音频深度检查组合入口：时长/静音/削波/响度各一条 CheckResult，末尾统一豁免降级。
 *
 * 静音有意范围（spec F2「头尾按配乐方案首尾段落解释」的实现约定）：spec 未给出
 * 「首尾段落」的可计算边界，这里约定为**头尾各一个小节时长**（barSec =
 * beatsPerBar × 60 / bpm），即 [0, barSec] 与 [totalSec − barSec, totalSec] 内的
 * 静音判为有意——与视频淡入/淡出共用同一分类规则（classifySilenceSegments）。
 */
export async function deepAudioChecks(
  file: string,
  scorePlan: ScorePlan,
  waivers: WaiverRecord[],
  artifactId?: string,
): Promise<CheckResult[]> {
  const probe = createLazyProbe(file);
  const results: CheckResult[] = [];

  // 1. 时长：期望 = scoreDurationMs(scorePlan)。
  results.push(await durationCheck("deep:audio:duration", file, scoreDurationMs(scorePlan), probe));

  // 2. 静音：头尾各 1 小节判有意（F2 实现约定，见函数注释）。
  const barSec = (scorePlan.beatsPerBar * 60) / scorePlan.bpm;
  results.push(
    await segmentCheck({
      id: "deep:audio:silence",
      kind: "静音",
      file,
      detect: detectSilenceSegments,
      classify: classifySilenceSegments,
      fadeInSec: barSec,
      fadeOutSec: barSec,
      probe,
      threshold: `头尾各 1 小节（${barSec.toFixed(3)}s = ${scorePlan.beatsPerBar} 拍 @ ${scorePlan.bpm}bpm）之外、时长 ≥ ${DEEP_CHECK_DEFAULTS.silenceMinDurationSec}s 且低于 ${DEEP_CHECK_DEFAULTS.silenceNoiseDb}dB 的静音判为意外`,
      command: `ffmpeg -v info -i ${file} -af silencedetect=noise=${DEEP_CHECK_DEFAULTS.silenceNoiseDb}dB:d=${DEEP_CHECK_DEFAULTS.silenceMinDurationSec} -f null -`,
      tool: "ffmpeg + silencedetect",
    }),
  );

  // 3. 削波 / 4. 响度（越界 warn）。
  results.push(await clipCheck("deep:audio:clip", file));
  results.push(await loudnessCheck("deep:audio:loudness", file));

  return applyWaivers(results, waivers, artifactId);
}

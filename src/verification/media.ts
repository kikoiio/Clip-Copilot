import type { CheckResult, MediaInfo } from "../domain.ts";
import { runFfmpeg, runFfprobe, type RunResult } from "../infra/process.ts";

export class MediaError extends Error {}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: {
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    codec_name?: string;
  }[];
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num || den === undefined || Number.isNaN(den) || den === 0) return 0;
  return num / den;
}

/** 用 ffprobe 读取媒体元数据；无法解析时抛错，不返回部分结果。 */
export async function probeMedia(file: string): Promise<MediaInfo> {
  const result = await runFfprobe([
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (result.exitCode !== 0) {
    throw new MediaError(`ffprobe 无法读取 ${file}：${result.stderr.slice(-500)}`);
  }
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeOutput;
  } catch {
    throw new MediaError(`ffprobe 输出无法解析：${file}`);
  }
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new MediaError(`${file} 时长无法确定`);
  }
  return {
    durationMs,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: parseFps(video?.avg_frame_rate ?? video?.r_frame_rate),
    hasAudio: audio !== undefined,
    hasVideo: video !== undefined,
  };
}

/**
 * 完整解码：只有 ffmpeg 逐帧解完且无错误输出才算通过。
 * 不把「进程没崩」以外的信息当成功证据。
 */
export async function checkFullDecode(file: string): Promise<CheckResult> {
  const result = await runFfmpeg(["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], {
    timeoutMs: 10 * 60_000,
  });
  const clean = result.exitCode === 0 && !result.timedOut && result.stderr.trim() === "";
  return {
    id: "media:decode",
    status: clean ? "pass" : "fail",
    evidence: clean
      ? "完整解码无错误输出"
      : `退出码 ${result.exitCode}${result.timedOut ? "（超时）" : ""}，stderr: ${result.stderr.slice(-600) || "（空）"}`,
  };
}

export interface TimeSegment {
  startSec: number;
  endSec: number;
  durationSec: number;
}

/** 黑帧候选区间（blackdetect）。阈值记录在常量中，便于复核。 */
export const BLACKDETECT_FILTER = "blackdetect=d=0.5:pix_th=0.10";

export async function detectBlackSegments(file: string): Promise<TimeSegment[]> {
  const result = await runFfmpeg([
    "-v", "info",
    "-i", file,
    "-vf", BLACKDETECT_FILTER,
    "-an",
    "-f", "null",
    "-",
  ], { timeoutMs: 10 * 60_000 });
  const segments: TimeSegment[] = [];
  const re = /black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g;
  for (const match of result.stderr.matchAll(re)) {
    segments.push({
      startSec: Number(match[1]),
      endSec: Number(match[2]),
      durationSec: Number(match[3]),
    });
  }
  return segments;
}

/** 静音候选区间（silencedetect，-50dB、至少 1 秒）。 */
export async function detectSilenceSegments(file: string): Promise<TimeSegment[]> {
  const result = await runFfmpeg([
    "-v", "info",
    "-i", file,
    "-af", "silencedetect=noise=-50dB:d=1",
    "-f", "null",
    "-",
  ], { timeoutMs: 10 * 60_000 });
  const segments: TimeSegment[] = [];
  const starts = [...result.stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...result.stderr.matchAll(/silence_end: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  for (let i = 0; i < starts.length; i++) {
    const end = ends[i] ?? Number((await probeMedia(file)).durationMs / 1000);
    segments.push({ startSec: starts[i] ?? 0, endSec: end, durationSec: Math.max(0, end - (starts[i] ?? 0)) });
  }
  return segments;
}

/** 峰值音量（volumedetect），用于破音候选判断：max_volume ≥ -0.1dB 视为削波候选。 */
export async function measurePeakVolume(file: string): Promise<{ maxVolumeDb: number; meanVolumeDb: number }> {
  const result = await runFfmpeg(["-v", "info", "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
    timeoutMs: 10 * 60_000,
  });
  const max = /max_volume: (-?[\d.]+) dB/.exec(result.stderr);
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(result.stderr);
  return {
    maxVolumeDb: max ? Number(max[1]) : 0,
    meanVolumeDb: mean ? Number(mean[1]) : -Infinity,
  };
}

/** 组合检查：元数据 + 完整解码，供渲染流程调用。 */
export async function checkMediaBasics(
  file: string,
  expect?: Partial<MediaInfo & { minDurationMs?: number; maxDurationMs?: number }>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let info: MediaInfo;
  try {
    info = await probeMedia(file);
    results.push({
      id: "media:metadata",
      status: "pass",
      evidence: `${info.width}×${info.height} @${info.fps.toFixed(2)}fps，视频流=${info.hasVideo}，音频流=${info.hasAudio}，${(info.durationMs / 1000).toFixed(2)}s`,
    });
  } catch (err) {
    results.push({
      id: "media:metadata",
      status: "fail",
      evidence: err instanceof Error ? err.message : String(err),
    });
    return results;
  }
  if (expect?.hasVideo !== undefined) {
    results.push({
      id: "media:has_video",
      status: info.hasVideo === expect.hasVideo ? "pass" : "fail",
      evidence: `视频流=${info.hasVideo}，期望=${expect.hasVideo}`,
    });
  }
  if (expect?.hasAudio !== undefined) {
    results.push({
      id: "media:has_audio",
      status: info.hasAudio === expect.hasAudio ? "pass" : "fail",
      evidence: `音频流=${info.hasAudio}，期望=${expect.hasAudio}`,
    });
  }
  if (expect?.width !== undefined || expect?.height !== undefined) {
    const ok = info.width === expect.width && info.height === expect.height;
    results.push({
      id: "media:resolution",
      status: ok ? "pass" : "fail",
      evidence: `${info.width}×${info.height}，期望 ${expect.width}×${expect.height}`,
    });
  }
  if (expect?.fps !== undefined) {
    const ok = Math.abs(info.fps - expect.fps) < 0.01;
    results.push({
      id: "media:fps",
      status: ok ? "pass" : "fail",
      evidence: `${info.fps.toFixed(2)}fps，期望 ${expect.fps}`,
    });
  }
  if (expect?.minDurationMs !== undefined) {
    results.push({
      id: "media:min_duration",
      status: info.durationMs >= expect.minDurationMs - 5 ? "pass" : "fail",
      evidence: `${info.durationMs}ms，下限 ${expect.minDurationMs}ms`,
    });
  }
  results.push(await checkFullDecode(file));
  return results;
}

export function evidenceOf(result: RunResult): string {
  return `退出码=${result.exitCode}${result.timedOut ? "（超时）" : ""}，耗时 ${(result.durationMs / 1000).toFixed(1)}s`;
}

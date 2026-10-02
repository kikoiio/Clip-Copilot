/**
 * 深度检查报告的标准化结构、落盘、汇总与检索。对应 plan.md 模块 C。
 * 报告落盘为 evidence/check-report-<artifactId>-<时间戳ms>.json，保留历史不覆盖；
 * 按 artifactId 取最新一份只看文件名时间戳，不依赖 mtime。
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckResult } from "../domain.ts";

/** 一次深度检查（渲染流程或 verify）产出的标准化报告。 */
export interface DeepCheckReport {
  checkedAt: string;
  /** 产物 ID（渲染流程/verify 中已知）；缺省表示目标尚未登记为产物。 */
  targetArtifactId?: string;
  /** 相对工作区路径。 */
  targetFile: string;
  /** ArtifactKind。 */
  targetKind: string;
  results: CheckResult[];
  /** { ffmpeg, lmms, kdenlive } 等，尽力采集。 */
  toolVersions: Record<string, string>;
  summary: { pass: number; warn: number; fail: number; needsHuman: number };
}

/** 文件名固定前缀/后缀，与 latestCheckReport 的解析规则配套。 */
const FILE_PREFIX = "check-report-";
const FILE_SUFFIX = ".json";

/**
 * 按 status 计数汇总：needs_observation 与 needs_human 都计入 needsHuman
 * （verify 输出统一按「待人工」归类，见 plan.md 核心数据结构）。
 */
export function summarize(results: CheckResult[]): DeepCheckReport["summary"] {
  const summary = { pass: 0, warn: 0, fail: 0, needsHuman: 0 };
  for (const result of results) {
    if (result.status === "pass") summary.pass += 1;
    else if (result.status === "warn") summary.warn += 1;
    else if (result.status === "fail") summary.fail += 1;
    else summary.needsHuman += 1;
  }
  return summary;
}

/** 组装报告：填充 checkedAt 并调用 summarize，调用方只提供目标与结果。 */
export function buildReport(
  target: { targetArtifactId?: string; targetFile: string; targetKind: string },
  results: CheckResult[],
  toolVersions: Record<string, string>,
): DeepCheckReport {
  return {
    checkedAt: new Date().toISOString(),
    targetArtifactId: target.targetArtifactId,
    targetFile: target.targetFile,
    targetKind: target.targetKind,
    results,
    toolVersions,
    summary: summarize(results),
  };
}

/** 解析报告文件名 check-report-<artifactId>-<时间戳ms>.json；不符合模式返回 null。 */
function parseReportFileName(name: string): { artifactId: string; ts: number } | null {
  if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) return null;
  const rest = name.slice(FILE_PREFIX.length, name.length - FILE_SUFFIX.length);
  const lastDash = rest.lastIndexOf("-");
  if (lastDash <= 0) return null;
  const ts = Number(rest.slice(lastDash + 1));
  if (!Number.isSafeInteger(ts) || ts <= 0) return null;
  return { artifactId: rest.slice(0, lastDash), ts };
}

/**
 * 把报告写入 evidenceDir 并返回完整路径。文件名带当前毫秒时间戳；
 * 无 artifactId 时用 unknown 占位。目录不存在则递归创建，不覆盖已有文件。
 */
export async function writeCheckReport(evidenceDir: string, report: DeepCheckReport): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const id = report.targetArtifactId ?? "unknown";
  const file = path.join(evidenceDir, `${FILE_PREFIX}${id}-${Date.now()}${FILE_SUFFIX}`);
  await writeFile(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

/**
 * 取某产物最新一份检查报告：按文件名时间戳取最大，不依赖 mtime。
 * 目录不存在、无匹配文件或最新文件损坏（JSON 解析失败）一律返回 null，不抛异常。
 */
export async function latestCheckReport(
  evidenceDir: string,
  artifactId: string,
): Promise<DeepCheckReport | null> {
  let best: { file: string; ts: number } | null = null;
  try {
    const entries = await readdir(evidenceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parsed = parseReportFileName(entry.name);
      if (!parsed || parsed.artifactId !== artifactId) continue;
      if (!best || parsed.ts > best.ts) {
        best = { file: path.join(evidenceDir, entry.name), ts: parsed.ts };
      }
    }
  } catch (err) {
    // 目录不存在视为无报告；其他文件系统错误照常抛出。
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!best) return null;
  try {
    const text = await readFile(best.file, "utf8");
    return JSON.parse(text) as DeepCheckReport;
  } catch {
    // 损坏的报告按「无报告」处理，不阻塞调用方（门禁另做提示）。
    return null;
  }
}

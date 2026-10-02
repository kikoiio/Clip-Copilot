/**
 * 任务配置：一部新作品的要求（对应阶段 2 spec F1/F2）。
 * 配置以"秒"为单位给人编写；换算为 Goal 后状态内部全用帧。
 */
import { readFile } from "node:fs/promises";
import { isVerifiedSpec, type AssetCandidate, type Goal, type MoodNode } from "../domain.ts";

export type { AssetCandidate };

export interface TaskConfig {
  schemaVersion: 1;
  title: string;
  theme: string;
  moodArc: MoodNode[];
  duration: { minSeconds: number; maxSeconds: number };
  outputSpec: { width: number; height: number; fps: number };
  assets: AssetCandidate[];
}

type FieldErrors = string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkString(obj: Record<string, unknown>, field: string, errors: FieldErrors): void {
  const value = obj[field];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`字段 ${field} 必须是非空字符串`);
  }
}

function checkPositiveNumber(obj: Record<string, unknown>, field: string, errors: FieldErrors): void {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(`字段 ${field} 必须是正数`);
  }
}

/** 逐字段校验任务配置；返回全部问题（每条指明字段与原因）。 */
export function validateTaskConfig(value: unknown): string[] {
  const errors: FieldErrors = [];
  if (!isRecord(value)) {
    return ["任务配置必须是 JSON 对象"];
  }
  if (value.schemaVersion !== 1) {
    errors.push(`字段 schemaVersion 必须为 1，收到 ${String(value.schemaVersion)}`);
  }
  checkString(value, "title", errors);
  checkString(value, "theme", errors);

  if (!isRecord(value.duration)) {
    errors.push("字段 duration 必须是对象（含 minSeconds/maxSeconds）");
  } else {
    checkPositiveNumber(value.duration, "minSeconds", errors);
    checkPositiveNumber(value.duration, "maxSeconds", errors);
    if (
      typeof value.duration.minSeconds === "number" &&
      typeof value.duration.maxSeconds === "number" &&
      value.duration.minSeconds > value.duration.maxSeconds
    ) {
      errors.push(
        `字段 duration：minSeconds（${value.duration.minSeconds}）不能大于 maxSeconds（${value.duration.maxSeconds}）`,
      );
    }
  }

  if (!isRecord(value.outputSpec)) {
    errors.push("字段 outputSpec 必须是对象（含 width/height/fps）");
  } else {
    const spec = value.outputSpec as Record<string, unknown>;
    checkPositiveNumber(spec, "width", errors);
    checkPositiveNumber(spec, "height", errors);
    checkPositiveNumber(spec, "fps", errors);
    if (
      typeof spec.width === "number" && typeof spec.height === "number" && typeof spec.fps === "number"
    ) {
      const candidate = { width: spec.width, height: spec.height, fps: spec.fps };
      if (!isVerifiedSpec(candidate)) {
        errors.push(
          `字段 outputSpec：${spec.width}×${spec.height}@${spec.fps} 不在已验证规格注册表中，明确拒绝（未验证规格不允许使用）`,
        );
      }
    }
  }

  if (!Array.isArray(value.moodArc) || value.moodArc.length === 0) {
    errors.push("字段 moodArc 必须是非空数组（有序情绪走向节点）");
  } else {
    value.moodArc.forEach((node, index) => {
      if (!isRecord(node)) {
        errors.push(`字段 moodArc[${index}] 必须是对象（含 name/energy）`);
        return;
      }
      checkString(node, "name", errors);
      const energy = node.energy;
      if (typeof energy !== "number" || !Number.isFinite(energy) || energy < 0 || energy > 2) {
        errors.push(`字段 moodArc[${index}].energy 必须在 0–2 之间`);
      }
    });
  }

  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    errors.push("字段 assets 必须是非空数组（素材候选清单）");
  } else {
    value.assets.forEach((asset, index) => {
      if (!isRecord(asset)) {
        errors.push(`字段 assets[${index}] 必须是对象（含 sourceUrl/licenseUrl）`);
        return;
      }
      checkString(asset, "sourceUrl", errors);
      checkString(asset, "licenseUrl", errors);
    });
  }
  return errors;
}

/** 读取并校验任务配置；任何问题都会抛出带逐条原因的错误。 */
export async function loadTaskConfig(file: string): Promise<TaskConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new Error(`无法读取任务配置 ${file}：${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`任务配置 ${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const errors = validateTaskConfig(parsed);
  if (errors.length > 0) {
    throw new Error(`任务配置 ${file} 无效：\n  - ${errors.join("\n  - ")}`);
  }
  return parsed as TaskConfig;
}

/** 配置（秒）→ 工作区目标（帧）。输出规格原样携带，帧率取自规格。 */
export function taskConfigToGoal(config: TaskConfig): Goal {
  const fps = config.outputSpec.fps;
  return {
    title: config.title,
    theme: config.theme,
    minFrames: Math.round(config.duration.minSeconds * fps),
    maxFrames: Math.round(config.duration.maxSeconds * fps),
    outputSpec: { ...config.outputSpec },
    moodArc: config.moodArc.map((node) => ({ ...node })),
  };
}

/**
 * 候选清单核对（spec F3）：来源在清单内直接放行；
 * 清单外素材必须附带替换原因，否则拒绝。
 */
export function checkAssetAgainstCandidates(
  candidates: readonly AssetCandidate[],
  sourceUrl: string,
  reason?: string,
): { allowed: true; replacement: boolean } | { allowed: false; message: string } {
  if (candidates.some((c) => c.sourceUrl === sourceUrl)) {
    return { allowed: true, replacement: false };
  }
  if (reason === undefined || reason.trim() === "") {
    return {
      allowed: false,
      message: `素材来源 ${sourceUrl} 不在任务配置候选清单中；如确需替换，请加 --reason 说明原因（将记入决定记录）`,
    };
  }
  return { allowed: true, replacement: true };
}

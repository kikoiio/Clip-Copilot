/**
 * AI 工具定义（spec F6/F7；plan.md 的 ai/tools.ts 模块）。
 * 读工具直连看板读层、免确认立即执行；写工具只把参数固化为 WriteActionSpec
 * （确认卡内容），绝不直接执行——执行由创作者逐条确认后经命令桥进行。
 * 写工具集合 = F3 人工动作 + render(score/video/final)，与 spec F7/AC7 一致。
 */
import {
  checkpointAction,
  monitorConfigAction,
  monitorDecideAction,
  observeAction,
  reopenAction,
  renderAction,
  reviewAction,
  waiveAction,
  type WriteActionSpec,
} from "../bridge.ts";
import { getWorkspaceDetail } from "../read.ts";
import type { ToolSpec } from "./providers.ts";

export type AiToolContext = { dir: string };

export interface AiToolDefinition {
  spec: ToolSpec;
  kind: "read" | "write";
  /** 读工具：直接执行并返回给模型的结果文本。 */
  execute?: (args: Record<string, unknown>, ctx: AiToolContext) => Promise<string>;
  /** 写工具：把参数固化为待确认动作；参数不合法时抛中文错误供模型修正。 */
  buildAction?: (args: Record<string, unknown>, ctx: AiToolContext) => WriteActionSpec;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function requireStr(args: Record<string, unknown>, key: string, label: string): string {
  const value = str(args, key);
  if (value === undefined || value.trim() === "") {
    throw new Error(`缺少必需参数 ${key}（${label}）`);
  }
  return value;
}

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = { type: "object", properties: {}, required: [] };

/* ---------- 读工具（免确认） ---------- */

async function readStatus(args: Record<string, unknown>, ctx: AiToolContext): Promise<string> {
  void args;
  const detail = await getWorkspaceDetail(ctx.dir);
  return JSON.stringify({
    phase: detail.state.phase,
    revision: detail.state.revision,
    updatedAt: detail.state.updatedAt,
    goal: detail.state.goal,
    counts: detail.state.counts,
    deepCheck: detail.state.deepCheck,
    nextAction: detail.state.nextAction,
    openSuggestions: detail.suggestions.filter((item) => item.status === "open" || item.status === "acknowledged").length,
  }, null, 2);
}

async function readArtifacts(args: Record<string, unknown>, ctx: AiToolContext): Promise<string> {
  void args;
  const detail = await getWorkspaceDetail(ctx.dir);
  return JSON.stringify(detail.artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    path: artifact.path,
    status: artifact.status,
    onDisk: artifact.onDisk,
    bytes: artifact.bytes,
    sha256: artifact.sha256.slice(0, 12),
  })), null, 2);
}

async function readSuggestions(args: Record<string, unknown>, ctx: AiToolContext): Promise<string> {
  void args;
  const detail = await getWorkspaceDetail(ctx.dir);
  return JSON.stringify({ suggestions: detail.suggestions, metrics: detail.metrics }, null, 2);
}

async function readReports(args: Record<string, unknown>, ctx: AiToolContext): Promise<string> {
  void args;
  const detail = await getWorkspaceDetail(ctx.dir);
  return JSON.stringify(detail.reports, null, 2);
}

async function readHandoff(args: Record<string, unknown>, ctx: AiToolContext): Promise<string> {
  void args;
  const detail = await getWorkspaceDetail(ctx.dir);
  return detail.handoff ?? "（handoff.md 缺失）";
}

export const READ_TOOLS: readonly AiToolDefinition[] = [
  {
    spec: {
      name: "get_status",
      description: "读取当前工作区的阶段、目标、产物计数、深度检查摘要与下一步提示",
      parameters: EMPTY_OBJECT_SCHEMA,
    },
    kind: "read",
    execute: readStatus,
  },
  {
    spec: {
      name: "list_artifacts",
      description: "列出当前工作区的产物清单（类型、状态、是否在磁盘、指纹前 12 位）",
      parameters: EMPTY_OBJECT_SCHEMA,
    },
    kind: "read",
    execute: readArtifacts,
  },
  {
    spec: {
      name: "get_suggestions",
      description: "读取监测建议清单与通知/处理统计",
      parameters: EMPTY_OBJECT_SCHEMA,
    },
    kind: "read",
    execute: readSuggestions,
  },
  {
    spec: {
      name: "get_reports",
      description: "读取深度检查报告（逐项结论 pass/warn/fail/待人工）",
      parameters: EMPTY_OBJECT_SCHEMA,
    },
    kind: "read",
    execute: readReports,
  },
  {
    spec: {
      name: "get_handoff",
      description: "读取 handoff.md（进度、决定与问题的人可读汇总）",
      parameters: EMPTY_OBJECT_SCHEMA,
    },
    kind: "read",
    execute: readHandoff,
  },
];

/* ---------- 写工具（确认后执行） ---------- */

function renderTool(stage: "score" | "video" | "final", description: string): AiToolDefinition {
  return {
    spec: { name: `render_${stage}`, description, parameters: EMPTY_OBJECT_SCHEMA },
    kind: "write",
    buildAction: (args, ctx) => renderAction(ctx.dir, stage),
  };
}

function enumStr<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], label: string): T {
  const value = str(args, key);
  if (value === undefined || !allowed.includes(value as T)) {
    throw new Error(`参数 ${key} 必须是 ${allowed.join("|")}（${label}）`);
  }
  return value as T;
}

export const WRITE_TOOLS: readonly AiToolDefinition[] = [
  {
    ...renderTool("score", "重新渲染配乐（LMMS 工程 + WAV），写操作，需创作者确认"),
  },
  {
    ...renderTool("video", "生成剪辑工程并渲染粗剪预览，写操作，需创作者确认"),
  },
  {
    ...renderTool("final", "渲染终版 MP4（要求已批准粗剪并通过验证），写操作，需创作者确认"),
  },
  {
    spec: {
      name: "submit_checkpoint",
      description: "提交当前阶段检查点（不可变副本；带未豁免硬伤会被门禁拒绝）",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "检查点摘要，如：配乐初稿 v1" } },
        required: ["summary"],
      },
    },
    kind: "write",
    buildAction: (args, ctx) => checkpointAction(ctx.dir, requireStr(args, "summary", "检查点摘要")),
  },
  {
    spec: {
      name: "record_review",
      description: "记录创作者对当前检查点的审阅意见（approve 或 changes）",
      parameters: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["approve", "changes"], description: "批准或要求修改" },
          feedback: { type: "string", description: "意见；要求修改时必填" },
        },
        required: ["decision"],
      },
    },
    kind: "write",
    buildAction: (args, ctx) => {
      const decision = enumStr(args, "decision", ["approve", "changes"] as const, "审阅决定");
      const feedback = str(args, "feedback") ?? "";
      if (decision === "changes" && feedback.trim() === "") {
        throw new Error("要求修改（changes）时必须提供 feedback 说明具体意见");
      }
      return reviewAction(ctx.dir, decision, feedback);
    },
  },
  {
    spec: {
      name: "waive_check",
      description: "豁免一条机器检查结论（原因必填、进决定记录；豁免后该项降级为告警）",
      parameters: {
        type: "object",
        properties: {
          check_id: { type: "string", description: "被豁免的检查项 ID，如 deep:video:black" },
          artifact_id: { type: "string", description: "可选：限定某个产物" },
          reason: { type: "string", description: "豁免原因（必填）" },
        },
        required: ["check_id", "reason"],
      },
    },
    kind: "write",
    buildAction: (args, ctx) => {
      const checkId = requireStr(args, "check_id", "检查项 ID");
      const reason = requireStr(args, "reason", "豁免原因");
      const artifactId = str(args, "artifact_id");
      return waiveAction(ctx.dir, checkId, reason, artifactId);
    },
  },
  {
    spec: {
      name: "record_observation",
      description: "登记一次软件内人工观察（lmms-edit/kdenlive-edit/subjective），verify 对应人工项随之翻转",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: ["lmms-edit", "kdenlive-edit", "subjective"], description: "观察项" },
          result: { type: "string", description: "观察结果（如实记录）" },
          action: { type: "string", description: "可选：具体操作说明" },
          copy: { type: "string", description: "可选：被修改的工程副本路径" },
        },
        required: ["name", "result"],
      },
    },
    kind: "write",
    buildAction: (args, ctx) => {
      const name = enumStr(args, "name", ["lmms-edit", "kdenlive-edit", "subjective"] as const, "观察项");
      const result = requireStr(args, "result", "观察结果");
      return observeAction(ctx.dir, name, result, {
        action: str(args, "action"),
        copy: str(args, "copy"),
      });
    },
  },
  {
    spec: {
      name: "reopen_workspace",
      description: "重开已交付（done）工作区的视频版本（产物失效并回到 video_draft）",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "重开原因（可选）" } },
        required: [],
      },
    },
    kind: "write",
    buildAction: (args, ctx) => reopenAction(ctx.dir, str(args, "reason")),
  },
  {
    spec: {
      name: "monitor_config",
      description: "修改当前工作区的监测配置（范围/通知强度/handoff 自动修复授权）",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", description: "逗号分隔：assets,projects,outputs,evidence,state" },
          notification: { type: "string", enum: ["silent", "important", "all"], description: "通知强度" },
          auto_repair_handoff: { type: "string", enum: ["on", "off"], description: "handoff 自动修复授权" },
        },
        required: [],
      },
    },
    kind: "write",
    buildAction: (args, ctx) => monitorConfigAction(ctx.dir, {
      scope: str(args, "scope"),
      notification: str(args, "notification"),
      ...(str(args, "auto_repair_handoff") !== undefined
        ? { autoRepair: str(args, "auto_repair_handoff") === "on" }
        : {}),
    }),
  },
  {
    spec: {
      name: "monitor_decide",
      description: "确认或忽略一条监测建议",
      parameters: {
        type: "object",
        properties: {
          suggestion_id: { type: "string", description: "建议 ID" },
          decision: { type: "string", enum: ["acknowledge", "ignore"], description: "确认或忽略" },
        },
        required: ["suggestion_id", "decision"],
      },
    },
    kind: "write",
    buildAction: (args, ctx) => monitorDecideAction(
      ctx.dir,
      requireStr(args, "suggestion_id", "建议 ID"),
      enumStr(args, "decision", ["acknowledge", "ignore"] as const, "处理决定"),
    ),
  },
];

export const AI_TOOLS: readonly AiToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS];

export function toolByName(name: string): AiToolDefinition | undefined {
  return AI_TOOLS.find((tool) => tool.spec.name === name);
}

export function toolSpecs(): ToolSpec[] {
  return AI_TOOLS.map((tool) => tool.spec);
}

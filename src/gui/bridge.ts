import { format } from "node:util";
import { cmdMonitor } from "../monitor/commands.ts";
import { commands } from "../workflow/coordinator.ts";

/** 所有写操作（界面按钮与 AI 发起）的统一返回，对应 CLI 的退出码与输出。 */
export interface ActionResult {
  ok: boolean;
  exitCode: number;
  /** 捕获的命令输出行（人可读，与终端一致）。 */
  lines: string[];
  /** 失败时的错误消息原文（与 CLI 拒绝文案一致）。 */
  error?: string;
}

export type WriteActionKind =
  | "render"
  | "verify"
  | "checkpoint"
  | "review"
  | "waive"
  | "observe"
  | "reopen"
  | "monitor_config"
  | "monitor_decide";

export interface WriteActionSpec {
  kind: WriteActionKind;
  /** 中文动作名（确认卡展示）。 */
  label: string;
  /** 原样传给现有命令处理器的参数（含 --workspace）。 */
  argv: string[];
  /** 将会发生什么（确认卡展示）。 */
  effectHint: string;
}

const MONITOR_KINDS: ReadonlySet<WriteActionKind> = new Set(["monitor_config", "monitor_decide"]);

/* ---------- 动作目录：各动作的中文文案与参数构造 ---------- */

export const RENDER_STAGE_LABELS: Record<"score" | "video" | "final", string> = {
  score: "渲染配乐",
  video: "渲染粗剪预览",
  final: "渲染终版视频",
};

/** 构造 render 动作；stage 为 score|video|final（与 CLI 的位置参数一致）。 */
export function renderAction(dir: string, stage: "score" | "video" | "final"): WriteActionSpec {
  return {
    kind: "render",
    label: RENDER_STAGE_LABELS[stage],
    argv: ["--workspace", dir, stage],
    effectHint: "生成工程并导出当前阶段产物（可能需要约 1 分钟，请勿并行修改工作区）",
  };
}

export function verifyAction(dir: string): WriteActionSpec {
  return {
    kind: "verify",
    label: "全量验证",
    argv: ["--workspace", dir],
    effectHint: "运行全部可自动化检查（含深度检查与无界面工程验证），并写入检查报告",
  };
}

export function checkpointAction(dir: string, summary: string): WriteActionSpec {
  return {
    kind: "checkpoint",
    label: "提交检查点",
    argv: ["--workspace", dir, "--summary", summary],
    effectHint: "把当前阶段产物冻结为不可变检查点副本；带未豁免硬伤时会被门禁拒绝",
  };
}

export function reviewAction(dir: string, decision: "approve" | "changes", feedback: string): WriteActionSpec {
  return {
    kind: "review",
    label: decision === "approve" ? "批准检查点" : "要求修改",
    argv: ["--workspace", dir, "--decision", decision, ...(feedback ? ["--feedback", feedback] : [])],
    effectHint: decision === "approve"
      ? "产物转 confirmed 并进入下一阶段"
      : "相关产物退回 draft（必须附带修改意见）",
  };
}

export function waiveAction(dir: string, checkId: string, reason: string, artifactId?: string): WriteActionSpec {
  return {
    kind: "waive",
    label: "豁免检查项",
    argv: ["--workspace", dir, "--check", checkId, ...(artifactId ? ["--artifact", artifactId] : []), "--reason", reason],
    effectHint: "该检查项在门禁评估中降级为告警，原因进入决定记录",
  };
}

export function observeAction(
  dir: string,
  name: "lmms-edit" | "kdenlive-edit" | "subjective",
  result: string,
  options: { action?: string; copy?: string; observer?: string } = {},
): WriteActionSpec {
  return {
    kind: "observe",
    label: "登记人工观察",
    argv: [
      "--workspace", dir,
      "--name", name,
      "--result", result,
      ...(options.action ? ["--action", options.action] : []),
      ...(options.copy ? ["--copy", options.copy] : []),
      ...(options.observer ? ["--observer", options.observer] : []),
    ],
    effectHint: "verify 对应人工项按观察结果翻转，记录写入 evidence/",
  };
}

export function reopenAction(dir: string, reason?: string): WriteActionSpec {
  return {
    kind: "reopen",
    label: "重开已交付工作区",
    argv: ["--workspace", dir, ...(reason ? ["--reason", reason] : [])],
    effectHint: "相关产物失效并回到 video_draft，旧终版自动归档",
  };
}

export function monitorConfigAction(
  dir: string,
  options: { scope?: string; notification?: string; autoRepair?: boolean } = {},
): WriteActionSpec {
  return {
    kind: "monitor_config",
    label: "修改监测配置",
    argv: [
      "config",
      "--workspace", dir,
      ...(options.scope ? ["--scope", options.scope] : []),
      ...(options.notification ? ["--notification", options.notification] : []),
      ...(options.autoRepair !== undefined ? ["--auto-repair-handoff", options.autoRepair ? "on" : "off"] : []),
    ],
    effectHint: "更新该工作区的监测范围、通知强度与 handoff 自动修复授权",
  };
}

export function monitorDecideAction(
  dir: string,
  suggestionId: string,
  decision: "acknowledge" | "ignore",
): WriteActionSpec {
  return {
    kind: "monitor_decide",
    label: decision === "acknowledge" ? "确认建议" : "忽略建议",
    argv: ["decide", "--workspace", dir, "--id", suggestionId, "--decision", decision],
    effectHint: "把该条监测建议标记为已确认或已忽略",
  };
}

/* ---------- 执行：console 捕获 + 每工作区互斥 ---------- */

const WORKSPACE_FLAG = "--workspace";

function workspaceOf(argv: readonly string[]): string {
  const index = argv.indexOf(WORKSPACE_FLAG);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) throw new Error(`动作参数缺少 ${WORKSPACE_FLAG}`);
  return value;
}

/** 在 fn 执行期间收集 console 输出为行；结束后无论成败都还原 console。 */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  const push = (...args: unknown[]) => {
    lines.push(format(...args));
  };
  console.log = push;
  console.error = push;
  console.warn = push;
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
}

/**
 * 同一工作区的动作串行执行（N3），不同工作区并行。
 * 队列中的前序动作失败不阻塞后续动作。
 */
export function enqueueAction<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = pendingAction.get(dir) ?? Promise.resolve();
  const tail = previous.catch(() => {}).then(fn);
  pendingAction.set(dir, tail);
  void tail.catch(() => {}).then(() => {
    if (pendingAction.get(dir) === tail) pendingAction.delete(dir);
  });
  return tail;
}

const pendingAction = new Map<string, Promise<unknown>>();

async function execute(spec: WriteActionSpec): Promise<ActionResult> {
  const handler = MONITOR_KINDS.has(spec.kind)
    ? cmdMonitor
    : commands[spec.kind];
  if (!handler) {
    return { ok: false, exitCode: 2, lines: [], error: `未知动作类型: ${spec.kind}` };
  }
  try {
    const captured = await captureConsole(() => handler(spec.argv));
    const exitCode = typeof captured.result === "number" ? captured.result : 1;
    return { ok: exitCode === 0, exitCode, lines: captured.lines };
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      lines: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 桥接执行：进入该工作区的互斥队列后调用现有命令处理器。 */
export function runAction(spec: WriteActionSpec): Promise<ActionResult> {
  return enqueueAction(workspaceOf(spec.argv), () => execute(spec));
}

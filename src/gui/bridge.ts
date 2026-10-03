import { format } from "node:util";
import { cmdMonitor } from "../monitor/commands.ts";
import { commands } from "../workflow/coordinator.ts";

export type WriteActionKind =
  | "render"
  | "verify"
  | "checkpoint"
  | "review"
  | "waive"
  | "observe"
  | "reopen"
  | "monitor_config"
  | "monitor_decide"
  | "software_open";

export interface WriteActionSpec {
  kind: WriteActionKind;
  /** 中文动作名（确认卡展示）。 */
  label: string;
  /** 原样传给现有命令处理器的参数（含 --workspace）。 */
  argv: string[];
  /** 将会发生什么（确认卡展示）。 */
  effectHint: string;
  /** 软件占用被拒后的二次确认：true=创作者已明确「仍要执行」。 */
  force?: boolean;
}

/** 软件占用信息（阶段 5 F5；gate 命中时阻断命令桥写操作）。 */
export interface SoftwareOccupyInfo {
  instances: { pid: number; projectBasename: string; projectPath: string | null }[];
}

export interface ActionResult {
  ok: boolean;
  exitCode: number;
  lines: string[];
  error?: string;
  blockedBy?: "software-in-use";
  instances?: SoftwareOccupyInfo["instances"];
}

/** 软件占用门：返回占用信息表示阻断，null 表示放行。由感知引擎在装配时注入。 */
export interface SoftwareGate {
  occupied(dir: string, kind: WriteActionKind): SoftwareOccupyInfo | null;
}

let softwareGate: SoftwareGate | null = null;
let softwareOpenHandler: ((dir: string) => Promise<{ ok: boolean; message: string }>) | null = null;

/** 装配点（main.ts bootstrap 调用；测试注入替身）。 */
export function setSoftwareGate(gate: SoftwareGate | null): void {
  softwareGate = gate;
}

/** 装配点：授权「打开工程」执行器（opener）。 */
export function setSoftwareOpenHandler(handler: ((dir: string) => Promise<{ ok: boolean; message: string }>) | null): void {
  softwareOpenHandler = handler;
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
  const dir = workspaceOf(spec.argv);
  // 冲突避让（阶段 5 F5/N1）：软件占用期间阻断写操作，宁停不覆盖。
  // force=true 表示创作者已在界面上二次确认「仍要执行」。
  if (!spec.force && softwareGate) {
    const occupy = softwareGate.occupied(dir, spec.kind);
    if (occupy) {
      const describe = occupy.instances
        .map((i) => `工程 ${i.projectBasename}${i.projectPath ? `（${i.projectPath}）` : "（路径未知）"}`)
        .join("；");
      return {
        ok: false,
        exitCode: 3,
        lines: [],
        blockedBy: "software-in-use",
        instances: occupy.instances,
        error:
          `${occupy.instances.length > 0 ? `软件占用：Kdenlive 正在运行该工作区${describe}。` : "软件占用：有 Kdenlive 工程无法唯一映射，可能占用该工作区。"}` +
          "为避免覆盖未保存的工作，本次操作已停止；请先在软件中保存并关闭工程，或在界面上选择「仍要执行」。",
      };
    }
  }
  if (spec.kind === "software_open") {
    if (!softwareOpenHandler) {
      return { ok: false, exitCode: 2, lines: [], error: "打开工程执行器未装配（感知未启用）" };
    }
    try {
      const outcome = await softwareOpenHandler(dir);
      return { ok: outcome.ok, exitCode: outcome.ok ? 0 : 1, lines: [outcome.message] };
    } catch (error) {
      return { ok: false, exitCode: 1, lines: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
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

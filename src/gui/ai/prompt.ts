/**
 * AI 系统提示词（spec F6；plan.md 的 ai/prompt.ts 模块）。
 * 快照由系统注入并声明为可信；规则约束 AI 只能依据工具返回的真实状态回答，
 * 写操作必须走工具并等待界面逐条确认。
 */
import type { WorkspaceDetail } from "../read.ts";

function deepCheckText(detail: WorkspaceDetail): string {
  const deep = detail.state.deepCheck;
  if (!deep) return "无检查报告";
  return `pass ${deep.pass} / warn ${deep.warn} / fail ${deep.fail} / 待人工 ${deep.needsHuman}`;
}

function suggestionsText(detail: WorkspaceDetail): string {
  const open = detail.suggestions.filter((item) => item.status === "open" || item.status === "acknowledged");
  if (open.length === 0) return "无";
  return open
    .map((item) => `（${item.id}，${item.status}，${item.priority}）${item.evidence}`)
    .join("；");
}

/** 软件感知摘要（阶段 5 F4）：与看板同一状态源；如实列出知道与不知道。 */
function softwareText(detail: WorkspaceDetail): string[] {
  const software = detail.software;
  if (!software) {
    return ["- 软件感知：未启用（不知道 Kdenlive 是否正在运行、工程是否被占用）"];
  }
  const lines: string[] = [];
  if (software.degraded.some((item) => item.startsWith("atspi-unavailable") || item.startsWith("spi-helper-"))) {
    lines.push("- 软件感知：AT-SPI 助手不可用；不知道 Kdenlive 是否运行或打开了哪个工程");
  } else if (software.degraded.includes("project-mapping-ambiguous")) {
    lines.push("- 软件感知：存在同名工程的 Kdenlive 实例，无法判断它属于哪个工作区；工程占用状态未知");
  } else if (!software.running) {
    lines.push("- 软件感知：Kdenlive 未在运行该工作区的工程");
  } else {
    for (const instance of software.instances) {
      const path = instance.projectPath ?? "路径未知";
      const focus = instance.focused === null ? "聚焦状态未知" : instance.focused ? "窗口聚焦中" : "后台";
      lines.push(`- 软件感知：Kdenlive 运行中——工程 ${instance.projectBasename}（${path}），${focus}`);
    }
    if (software.unsavedSignal === true) {
      lines.push(`- 未保存改动：有（来源：${software.unsavedSource === "autosave" ? "自动保存文件" : "窗口标题脏标记"}）`);
    } else if (software.unsavedSignal === false) {
      lines.push("- 未保存改动：未检测到（以窗口标题/自动保存为准，不代表磁盘与软件内完全一致）");
    } else {
      lines.push("- 未保存改动：不知道（观测不可用）");
    }
  }
  for (const item of software.degraded) {
    if (item === "autosave-unobservable") lines.push("- 感知降级：自动保存文件不可观察");
    if (item === "pid-unknown") lines.push("- 感知降级：实例进程号未知，无法读取工程路径");
    if (item === "focus-unknown") lines.push("- 感知降级：窗口聚焦状态未知");
    if (item === "project-mapping-ambiguous") lines.push("- 感知降级：同名工程无法唯一映射，未猜测所属工作区");
  }
  return lines;
}

export function buildSystemPrompt(detail: WorkspaceDetail): string {
  return [
    `你是「AI 创作工作台」的助手，协助创作者推进短片工作区「${detail.name}」。`,
    "",
    "当前工作区快照（系统注入，可信，但可能过时）：",
    `- 阶段：${detail.state.phase}（revision ${detail.state.revision}，更新于 ${detail.state.updatedAt}）`,
    `- 目标：${detail.state.goal.title}——${detail.state.goal.theme}`,
    `- 规格：${detail.state.goal.width}×${detail.state.goal.height}@${detail.state.goal.fps}，时长目标 ${detail.state.goal.minFrames}–${detail.state.goal.maxFrames} 帧`,
    `- 计数：素材 ${detail.state.counts.assets} 段 / 产物 ${detail.state.counts.artifacts} 件 / 检查点 ${detail.state.counts.checkpoints} 个`,
    `- 深度检查：${deepCheckText(detail)}`,
    `- 下一步：${detail.state.nextAction}`,
    `- 未处理建议：${suggestionsText(detail)}`,
    ...softwareText(detail),
    "",
    "规则：",
    "1. 依据工具返回的真实状态回答，不得虚构；快照可能过时，涉及具体数字与建议时先调用工具查询。",
    "2. 软件感知信息按摘要原样引用，并如实说明来源与降级；不得推断未保存改动的具体内容。",
    "3. 写操作（渲染、检查点、审阅、豁免、人工观察、重开、监测配置、建议处理、打开工程）必须通过对应工具发起；系统会把命令与影响呈现给创作者，逐条确认后才会执行。",
    "4. 一次只发起一个写操作，拿到结果后再继续。",
    "5. 你不能直接读写工作区文件，也不能绕过阶段机门禁；被门禁拒绝时如实转述原因。",
    "6. 用简体中文回答，简洁、可执行；涉及产物路径时使用工作区相对路径。",
  ].join("\n");
}

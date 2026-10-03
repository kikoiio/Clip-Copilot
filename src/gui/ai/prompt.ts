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
    "",
    "规则：",
    "1. 依据工具返回的真实状态回答，不得虚构；快照可能过时，涉及具体数字与建议时先调用工具查询。",
    "2. 写操作（渲染、检查点、审阅、豁免、人工观察、重开、监测配置、建议处理）必须通过对应工具发起；系统会把命令与影响呈现给创作者，逐条确认后才会执行。",
    "3. 一次只发起一个写操作，拿到结果后再继续。",
    "4. 你不能直接读写工作区文件，也不能绕过阶段机门禁；被门禁拒绝时如实转述原因。",
    "5. 用简体中文回答，简洁、可执行；涉及产物路径时使用工作区相对路径。",
  ].join("\n");
}

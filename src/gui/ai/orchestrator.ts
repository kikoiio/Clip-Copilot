/**
 * AI 会话编排（spec F6/F7；plan.md 的 ai/orchestrator.ts 模块）。
 * 单个对话循环：系统提示（注入工作区快照）→ 流式补全 → 工具调用。
 * 读工具直接执行回填；写工具固化为 WriteActionSpec 后挂起等待界面确认，
 * 批准后经命令桥（互斥队列 + 现有命令处理器）执行，拒绝则把「用户拒绝」回填给模型。
 * 会话按工作区持久化到 userData/sessions/，重启后可续聊。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAction, type WriteActionSpec } from "../bridge.ts";
import { getWorkspaceDetail, type WorkspaceDetail } from "../read.ts";
import { providerPreset, SettingsStore, type ProviderSetting } from "../secrets.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { createChatClient, type ChatClient, type ChatMessageIn, type ToolCallRequest } from "./providers.ts";
import { toolByName, toolSpecs } from "./tools.ts";

export type AiEvent =
  | { type: "token"; dir: string; text: string }
  | { type: "assistantMessage"; dir: string; message: AiStoredMessage }
  | { type: "confirmation"; dir: string; confirmationId: string; action: WriteActionSpec }
  | { type: "toolResult"; dir: string; toolName: string; ok: boolean; summary: string }
  | { type: "error"; dir: string; message: string }
  | { type: "done"; dir: string };

export interface AiStoredMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** role=tool 时的对应工具调用 ID。 */
  toolCallId?: string;
  /** role=assistant 携带的工具调用。 */
  toolCalls?: ToolCallRequest[];
  at: string;
}

export type AiListener = (event: AiEvent) => void;

export interface AiOrchestratorOptions {
  settings: SettingsStore;
  /** 会话持久化目录（通常为 userData/sessions）。 */
  sessionsDir: string;
  readDetail?: (dir: string) => Promise<WorkspaceDetail>;
  /** 测试注入假模型；默认按设置构造真实客户端。 */
  createClient?: (setting: ProviderSetting, apiKey: string | null) => ChatClient;
  maxToolRounds?: number;
}

interface PendingConfirmation {
  id: string;
  action: WriteActionSpec;
  resolve: (approved: boolean) => void;
}

interface Session {
  dir: string;
  messages: AiStoredMessage[];
  busy: boolean;
  abort?: AbortController;
  pending?: PendingConfirmation;
}

const MAX_RESULT_CHARS = 4000;

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

function capText(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…（输出过长已截断）` : text;
}

function sessionFile(sessionsDir: string, dir: string): string {
  const hash = createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 24);
  return path.join(sessionsDir, `${hash}.json`);
}

function toChatMessageIn(message: AiStoredMessage): ChatMessageIn {
  return {
    role: message.role,
    ...(message.content ? { content: message.content } : {}),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
  };
}

export class AiOrchestrator {
  readonly #options: Required<Omit<AiOrchestratorOptions, "createClient">> & Pick<AiOrchestratorOptions, "createClient">;
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Set<AiListener>();

  constructor(options: AiOrchestratorOptions) {
    this.#options = {
      settings: options.settings,
      sessionsDir: options.sessionsDir,
      readDetail: options.readDetail ?? getWorkspaceDetail,
      ...(options.createClient !== undefined ? { createClient: options.createClient } : {}),
      maxToolRounds: options.maxToolRounds ?? 8,
    };
  }

  /** 订阅 AI 事件（token/确认卡/工具结果/错误/结束）；返回退订函数。 */
  onUpdate(listener: AiListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 当前会话历史（无会话时返回空数组）。 */
  async history(dir: string): Promise<AiStoredMessage[]> {
    const session = await this.#session(path.resolve(dir));
    return [...session.messages];
  }

  /**
   * 发送一条用户消息并驱动完整的工具循环（含等待界面确认）。
   * 返回时本轮回答已结束（错误经事件上报而非抛出，配置缺失除外）。
   */
  async send(dir: string, text: string): Promise<void> {
    const resolved = path.resolve(dir);
    const session = await this.#session(resolved);
    if (session.busy) throw new Error("上一个对话尚未结束，请稍候或取消");
    session.busy = true;
    const controller = new AbortController();
    session.abort = controller;
    try {
      session.messages.push({ role: "user", content: text, at: now() });
      await this.#persist(session);

      for (let round = 0; round < this.#options.maxToolRounds; round++) {
        const detail = await this.#options.readDetail(resolved);
        const client = await this.#client();
        const events = client.stream({
          messages: [
            { role: "system", content: buildSystemPrompt(detail) },
            ...session.messages.map(toChatMessageIn),
          ],
          tools: toolSpecs(),
          signal: controller.signal,
        });
        let assistantText = "";
        let calls: ToolCallRequest[] = [];
        for await (const event of events) {
          if (event.type === "text") {
            assistantText += event.text;
            this.#emit({ type: "token", dir: resolved, text: event.text });
          } else if (event.type === "toolCalls") {
            calls = event.calls;
          }
        }
        const assistantMessage: AiStoredMessage = {
          role: "assistant",
          content: assistantText,
          ...(calls.length > 0 ? { toolCalls: calls } : {}),
          at: now(),
        };
        session.messages.push(assistantMessage);
        this.#emit({ type: "assistantMessage", dir: resolved, message: assistantMessage });
        await this.#persist(session);
        if (calls.length === 0) return;

        for (const call of calls) {
          const outcome = await this.#runTool(session, call);
          session.messages.push({ role: "tool", toolCallId: call.id, content: outcome.resultText, at: now() });
          this.#emit({ type: "toolResult", dir: resolved, toolName: call.name, ok: outcome.ok, summary: outcome.summary });
          await this.#persist(session);
        }
      }
      const exhausted: AiStoredMessage = {
        role: "assistant",
        content: `连续 ${this.#options.maxToolRounds} 轮工具调用仍未完成，已停止本轮处理；请查看工作区状态后重试。`,
        at: now(),
      };
      session.messages.push(exhausted);
      this.#emit({ type: "assistantMessage", dir: resolved, message: exhausted });
      await this.#persist(session);
    } catch (error) {
      if (controller.signal.aborted) {
        const cancelled: AiStoredMessage = {
          role: "assistant",
          content: "（用户取消了本次回答）",
          at: now(),
        };
        session.messages.push(cancelled);
        this.#emit({ type: "assistantMessage", dir: resolved, message: cancelled });
        await this.#persist(session);
        return;
      }
      this.#emit({ type: "error", dir: resolved, message: msgOf(error) });
    } finally {
      session.busy = false;
      session.abort = undefined;
      this.#emit({ type: "done", dir: resolved });
    }
  }

  /** 对挂起的确认卡做出决定；ID 不匹配时抛错（界面只允许决定最新一张）。 */
  async confirm(dir: string, confirmationId: string, approved: boolean): Promise<void> {
    const session = this.#sessions.get(path.resolve(dir));
    const pending = session?.pending;
    if (!pending || pending.id !== confirmationId) {
      throw new Error("没有等待确认的操作（可能已被处理或取消）");
    }
    pending.resolve(approved);
  }

  /** 取消当前流式回答与挂起的确认。 */
  cancel(dir: string): void {
    const session = this.#sessions.get(path.resolve(dir));
    if (!session) return;
    session.pending?.resolve(false);
    session.abort?.abort();
  }

  /** 应用退出：取消挂起确认、中止流。 */
  dispose(): void {
    for (const session of this.#sessions.values()) {
      session.pending?.resolve(false);
      session.abort?.abort();
    }
    this.#sessions.clear();
  }

  async #session(dir: string): Promise<Session> {
    const existing = this.#sessions.get(dir);
    if (existing) return existing;
    const file = sessionFile(this.#options.sessionsDir, dir);
    const raw = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    let messages: AiStoredMessage[] = [];
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { messages?: AiStoredMessage[] };
        messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      } catch {
        // 损坏的会话记录按空会话处理，不阻塞新对话。
      }
    }
    const session: Session = { dir, messages, busy: false };
    this.#sessions.set(dir, session);
    return session;
  }

  async #client(): Promise<ChatClient> {
    const settings = await this.#options.settings.getSettings();
    const setting = settings.providers.find((item) => item.id === settings.activeProviderId);
    if (!setting) {
      throw new Error("尚未配置模型：请在「设置」中选择服务商并保存 API Key");
    }
    const needsApiKey = providerPreset(setting.preset).needsApiKey;
    const apiKey = needsApiKey ? await this.#options.settings.getApiKey(setting.id) : null;
    if (needsApiKey && !apiKey) {
      throw new Error(`提供方「${setting.preset}」没有可用的 API Key：请在设置中重新保存`);
    }
    const create = this.#options.createClient
      ?? ((candidate: ProviderSetting, key: string | null) => createChatClient({ setting: candidate, apiKey: key }));
    return create(setting, apiKey);
  }

  async #runTool(
    session: Session,
    call: ToolCallRequest,
  ): Promise<{ ok: boolean; summary: string; resultText: string }> {
    const def = toolByName(call.name);
    if (!def) {
      return { ok: false, summary: "未知工具", resultText: `错误：未知工具 ${call.name}，请改用提供的工具。` };
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        summary: "参数解析失败",
        resultText: "错误：工具参数不是合法 JSON，请重新调用并输出合法 JSON。",
      };
    }
    if (def.kind === "read") {
      try {
        const text = await def.execute!(args, { dir: session.dir });
        return { ok: true, summary: `${def.spec.name} 完成`, resultText: capText(text) };
      } catch (error) {
        return { ok: false, summary: `${def.spec.name} 失败`, resultText: `错误：${msgOf(error)}` };
      }
    }
    // 写工具：先固化动作（参数校验），再等创作者逐条确认（spec F7）。
    let action: WriteActionSpec;
    try {
      action = def.buildAction!(args, { dir: session.dir });
    } catch (error) {
      return {
        ok: false,
        summary: "参数校验失败",
        resultText: `错误：${msgOf(error)}。请修正参数后重新调用。`,
      };
    }
    const confirmationId = `conf-${Date.now()}-${Math.random().toString(36).slice(1, 7)}`;
    const approved = await new Promise<boolean>((resolve) => {
      session.pending = { id: confirmationId, action, resolve };
      this.#emit({ type: "confirmation", dir: session.dir, confirmationId, action });
    });
    session.pending = undefined;
    if (!approved) {
      return {
        ok: false,
        summary: "用户拒绝",
        resultText: "用户在界面上拒绝了该操作，未执行。请询问创作者的意图或提出其他方案。",
      };
    }
    const result = await runAction(action);
    const summary = result.ok ? `${action.label} 已执行` : `${action.label} 执行失败`;
    const resultText = result.ok
      ? capText(`命令已执行成功（退出码 0）。\n输出：\n${result.lines.join("\n") || "（无输出）"}`)
      : capText(`命令执行失败：${result.error ?? `退出码 ${result.exitCode}`}。${result.lines.length > 0 ? `\n输出：\n${result.lines.join("\n")}` : ""}`);
    return { ok: result.ok, summary, resultText };
  }

  async #persist(session: Session): Promise<void> {
    await mkdir(this.#options.sessionsDir, { recursive: true });
    await writeFile(sessionFile(this.#options.sessionsDir, session.dir), JSON.stringify({
      dir: session.dir,
      messages: session.messages,
    }, null, 2), "utf8");
  }

  #emit(event: AiEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 单个监听器异常不影响对话循环。
      }
    }
  }
}

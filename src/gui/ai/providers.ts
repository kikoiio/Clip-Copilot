/**
 * 模型协议适配器（spec F6/F7/F8；plan.md 的 ai/providers.ts 模块）。
 * 两个协议族：OpenAI 兼容（智谱 GLM / OpenAI / Ollama / 自定义端点）与 Anthropic messages。
 * 对上层暴露统一的 ChatClient：流式文本增量 + 工具调用事件；
 * fetch 可注入（测试用替身），网络/鉴权/限流错误统一映射为可读中文消息。
 */
import { providerPreset, type ProviderProtocol, type ProviderSetting } from "../secrets.ts";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema 参数对象。 */
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  /** 模型给出的原始 JSON 参数串，由调用方解析。 */
  arguments: string;
}

export interface ChatMessageIn {
  role: "system" | "user" | "assistant" | "tool";
  /** 工具调用消息可以没有文本内容。 */
  content?: string;
  /** role=tool 时的对应工具调用 ID。 */
  toolCallId?: string;
  /** role=assistant 携带的工具调用（回传给模型继续对话）。 */
  toolCalls?: ToolCallRequest[];
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "toolCalls"; calls: ToolCallRequest[] }
  | { type: "done"; stopReason: string };

export interface ChatStreamInput {
  messages: ChatMessageIn[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ChatClient {
  /** 产出文本增量、（回答结束时）完整工具调用与 done 事件。 */
  stream(input: ChatStreamInput): AsyncGenerator<ChatEvent, void, void>;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  json?(): Promise<unknown>;
  body?: AsyncIterable<Uint8Array | string>;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export function defaultFetch(): FetchLike {
  return (url, init) =>
    fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
    }) as unknown as Promise<FetchResponseLike>;
}

/* ---------- 错误映射 ---------- */

function readableHttpError(status: number, detail: string): Error {
  if (status === 401 || status === 403) {
    return new Error(`模型请求鉴权失败（HTTP ${status}）：请检查 API Key 与端点。${detail}`);
  }
  if (status === 404) {
    return new Error(`模型端点不存在（HTTP 404）：请检查 base URL 与模型名。${detail}`);
  }
  if (status === 429) {
    return new Error(`模型请求被限流（HTTP 429）：请稍后重试。${detail}`);
  }
  return new Error(`模型请求失败（HTTP ${status}）：${detail}`);
}

async function errorFromResponse(response: FetchResponseLike, providerLabel: string): Promise<Error> {
  let detail = "";
  try {
    const parsed = (await response.json?.()) as { error?: { message?: string }; message?: string } | undefined;
    const message = parsed?.error?.message ?? parsed?.message;
    if (message) detail = `服务商返回：${message}`;
  } catch {
    // 响应体不是 JSON 时忽略，用状态码文案兜底。
  }
  const base = readableHttpError(response.status, detail);
  return new Error(`[${providerLabel}] ${base.message}`);
}

/* ---------- SSE 行解析 ---------- */

async function* sseLines(response: FetchResponseLike): AsyncGenerator<string, void, void> {
  if (!response.body) throw new Error("模型响应缺少流式正文");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  const tail = buffer.replace(/\r$/, "");
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

function jsonOrThrow(text: string, context: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`无法解析模型流式响应（${context}）：${text.slice(0, 200)}`);
  }
}

/* ---------- OpenAI 兼容协议 ---------- */

interface OpenAiAccumulatedCall {
  id: string;
  name: string;
  arguments: string;
}

class OpenAiCompatibleClient implements ChatClient {
  #baseUrl: string;
  #apiKey: string | null;
  #model: string;
  #label: string;
  #fetch: FetchLike;

  constructor(baseUrl: string, apiKey: string | null, model: string, label: string, fetchImpl: FetchLike) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#apiKey = apiKey;
    this.#model = model;
    this.#label = label;
    this.#fetch = fetchImpl;
  }

  async *stream(input: ChatStreamInput): AsyncGenerator<ChatEvent, void, void> {
    const messages = input.messages.map(toOpenAiMessage);
    const body = {
      model: this.#model,
      messages,
      ...(input.tools.length > 0
        ? {
            tools: input.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
          }
        : {}),
      stream: true,
    };
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!response.ok) throw await errorFromResponse(response, this.#label);

    let stopReason = "stop";
    const calls = new Map<number, OpenAiAccumulatedCall>();
    for await (const data of sseLines(response)) {
      if (data === "[DONE]") break;
      const payload = jsonOrThrow(data, "openai chunk") as {
        choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
      };
      const choice = payload.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) yield { type: "text", text: choice.delta.content };
      for (const fragment of choice.delta?.tool_calls ?? []) {
        const existing = calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
        if (fragment.id) existing.id = fragment.id;
        if (fragment.function?.name) existing.name = fragment.function.name;
        if (fragment.function?.arguments) existing.arguments += fragment.function.arguments;
        calls.set(fragment.index, existing);
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }
    if (calls.size > 0) {
      yield {
        type: "toolCalls",
        calls: [...calls.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((call) => ({ id: call.id || `call-${call.name}`, name: call.name, arguments: call.arguments || "{}" })),
      };
    }
    yield { type: "done", stopReason };
  }
}

function toOpenAiMessage(message: ChatMessageIn): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      ...(message.content ? { content: message.content } : {}),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/* ---------- Anthropic 协议 ---------- */

class AnthropicClient implements ChatClient {
  #baseUrl: string;
  #apiKey: string | null;
  #model: string;
  #label: string;
  #fetch: FetchLike;

  constructor(baseUrl: string, apiKey: string | null, model: string, label: string, fetchImpl: FetchLike) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#apiKey = apiKey;
    this.#model = model;
    this.#label = label;
    this.#fetch = fetchImpl;
  }

  async *stream(input: ChatStreamInput): AsyncGenerator<ChatEvent, void, void> {
    const system = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages = input.messages.filter((message) => message.role !== "system").map(toAnthropicMessage);
    const response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.#apiKey ? { "x-api-key": this.#apiKey } : {}),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.#model,
        max_tokens: 8192,
        ...(system ? { system } : {}),
        messages,
        ...(input.tools.length > 0
          ? {
              tools: input.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
            }
          : {}),
        stream: true,
      }),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!response.ok) throw await errorFromResponse(response, this.#label);

    let stopReason = "end_turn";
    let textEmitted = false;
    const order: string[] = [];
    const blocks = new Map<string, { name: string; json: string }>();
    let currentToolId: string | null = null;

    for await (const data of sseLines(response)) {
      if (data === "") continue;
      const event = jsonOrThrow(data, "anthropic event") as {
        type: string;
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        content_block?: { type?: string; id?: string; name?: string };
        index?: number;
      };
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        currentToolId = event.content_block.id ?? `tool-${blocks.size}`;
        blocks.set(currentToolId, { name: event.content_block.name ?? "", json: "" });
        order.push(currentToolId);
      } else if (event.type === "content_block_delta") {
        if (event.delta?.text) {
          textEmitted = true;
          yield { type: "text", text: event.delta.text };
        } else if (event.delta?.partial_json && currentToolId) {
          const block = blocks.get(currentToolId)!;
          block.json += event.delta.partial_json;
        }
      } else if (event.type === "message_delta" && event.delta?.stop_reason) {
        stopReason = event.delta.stop_reason;
      }
    }
    const calls = order
      .map((id) => blocks.get(id)!)
      .map((block, index) => ({
        id: order[index]!,
        name: block.name,
        arguments: block.json || "{}",
      }));
    if (calls.length > 0) yield { type: "toolCalls", calls };
    if (!textEmitted && calls.length === 0) {
      throw new Error(`[${this.#label}] 模型响应为空（stop_reason=${stopReason}）`);
    }
    yield { type: "done", stopReason };
  }
}

function toAnthropicMessage(message: ChatMessageIn): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.toolCallId ?? "", content: message.content }],
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    const content: Record<string, unknown>[] = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const call of message.toolCalls) {
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(call.arguments);
      } catch {
        parsedInput = {};
      }
      content.push({ type: "tool_use", id: call.id, name: call.name, input: parsedInput });
    }
    return { role: "assistant", content };
  }
  return { role: message.role === "system" ? "user" : message.role, content: message.content };
}

/* ---------- 客户端工厂 ---------- */

/** 依据设置构造已授权的客户端；协议由预设决定（custom 固定为 OpenAI 兼容）。 */
export function createChatClient(options: {
  setting: ProviderSetting;
  apiKey: string | null;
  fetchImpl?: FetchLike;
}): ChatClient {
  const { setting, apiKey, fetchImpl = defaultFetch() } = options;
  const protocol: ProviderProtocol = providerPreset(setting.preset).protocol;
  if (protocol === "anthropic") {
    return new AnthropicClient(setting.baseUrl, apiKey, setting.model, setting.preset, fetchImpl);
  }
  return new OpenAiCompatibleClient(setting.baseUrl, apiKey, setting.model, setting.preset, fetchImpl);
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatClient,
  type ChatEvent,
  type ChatMessageIn,
  type FetchInit,
  type FetchLike,
  type ToolCallRequest,
  type ToolSpec,
} from "../src/gui/ai/providers.ts";

const sampleTools: ToolSpec[] = [
  {
    name: "get_status",
    description: "读取工作区状态",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

function sseResponse(sseText: string, capture: { url?: string; init?: FetchInit } = {}): FetchLike {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (const chunk of sseText.match(/.{1,20}/gs) ?? []) yield chunk;
      })(),
    };
  };
}

async function collect(generator: AsyncGenerator<ChatEvent, void, void>): Promise<{ text: string; calls: ToolCallRequest[]; stopReason: string }> {
  let text = "";
  let calls: ToolCallRequest[] = [];
  let stopReason = "";
  for await (const event of generator) {
    if (event.type === "text") text += event.text;
    else if (event.type === "toolCalls") calls = event.calls;
    else if (event.type === "done") stopReason = event.stopReason;
  }
  return { text, calls, stopReason };
}

test("T6：OpenAI 兼容协议的请求形状与消息映射", async () => {
  const capture: { url?: string; init?: FetchInit } = {};
  const client = createChatClient({
    setting: { id: "p1", preset: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
    apiKey: "sk-secret",
    fetchImpl: sseResponse('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n', capture),
  });
  const messages: ChatMessageIn[] = [
    { role: "system", content: "你是工作台助手" },
    { role: "user", content: "现在做到哪了" },
    {
      role: "assistant",
      content: "我查一下",
      toolCalls: [{ id: "call-1", name: "get_status", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "call-1", content: '{"phase":"done"}' },
  ];
  const result = await collect(client.stream({ messages, tools: sampleTools }));
  assert.equal(result.text, "好");
  assert.equal(capture.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(capture.init?.headers.Authorization, "Bearer sk-secret");
  const body = JSON.parse(capture.init?.body ?? "{}") as {
    model: string;
    stream: boolean;
    tools: { type: string; function: { name: string; parameters: unknown } }[];
    messages: Record<string, unknown>[];
  };
  assert.equal(body.model, "glm-4-flash");
  assert.equal(body.stream, true);
  assert.equal(body.tools[0]!.function.name, "get_status");
  assert.equal(body.messages[0]!.role, "system");
  const assistant = body.messages[2] as { tool_calls: { id: string; function: { name: string } }[] };
  assert.equal(assistant.tool_calls[0]!.id, "call-1");
  assert.equal(body.messages[3]!.role, "tool");
});

test("T6：OpenAI 兼容协议的流式工具调用拼装", async () => {
  const plain = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"render_score","arguments":""}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"workspace\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ws\\"}"}}]}}]}\n',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
    "data: [DONE]\n",
  ].join("\n");
  const client = createChatClient({
    setting: { id: "p1", preset: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    apiKey: null,
    fetchImpl: sseResponse(plain),
  });
  const result = await collect(client.stream({ messages: [{ role: "user", content: "重渲染配乐" }], tools: sampleTools }));
  assert.equal(result.stopReason, "tool_calls");
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]!.name, "render_score");
  assert.deepEqual(JSON.parse(result.calls[0]!.arguments), { workspace: "ws" });
});

test("T6：Anthropic 协议的请求形状（system 提取、tool_result 映射）", async () => {
  const capture: { url?: string; init?: FetchInit } = {};
  const client = createChatClient({
    setting: { id: "p1", preset: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
    apiKey: "sk-ant-test",
    fetchImpl: sseResponse(
      'event: message_start\ndata: {"type":"message_start"}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好的"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
      capture,
    ),
  });
  const messages: ChatMessageIn[] = [
    { role: "system", content: "你是工作台助手" },
    { role: "user", content: "现在做到哪了" },
    { role: "assistant", toolCalls: [{ id: "toolu-1", name: "get_status", arguments: "{}" }] },
    { role: "tool", toolCallId: "toolu-1", content: '{"phase":"done"}' },
  ];
  const result = await collect(client.stream({ messages, tools: sampleTools }));
  assert.equal(result.text, "好的");
  assert.equal(capture.url, "https://api.anthropic.com/v1/messages");
  assert.equal(capture.init?.headers["x-api-key"], "sk-ant-test");
  assert.equal(capture.init?.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(capture.init?.body ?? "{}") as {
    system: string;
    tools: { name: string; input_schema: unknown }[];
    messages: { role: string; content: unknown }[];
  };
  assert.equal(body.system, "你是工作台助手");
  assert.equal(body.tools[0]!.name, "get_status");
  assert.equal(body.messages.length, 3); // system 已提取到顶层
  const toolResult = body.messages[2]!.content as { type: string; tool_use_id: string }[];
  assert.equal(toolResult[0]!.type, "tool_result");
  assert.equal(toolResult[0]!.tool_use_id, "toolu-1");
});

test("T6：Anthropic 协议的 tool_use 块拼装", async () => {
  const sse = [
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu-9","name":"get_handoff"}}\n',
    'data: {"type":"content_block_delta","delta":{"partial_json":"{\\"dir\\""}}\n',
    'data: {"type":"content_block_delta","delta":{"partial_json":":\\"ws\\"}"}}\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n',
    'data: {"type":"message_stop"}\n',
  ].join("");
  const client = createChatClient({
    setting: { id: "p1", preset: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
    apiKey: "sk-ant-test",
    fetchImpl: sseResponse(sse),
  });
  const result = await collect(client.stream({ messages: [{ role: "user", content: "看看 handoff" }], tools: sampleTools }));
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(JSON.parse(result.calls[0]!.arguments), { dir: "ws" });
});

test("T6：鉴权失败映射为可读中文错误", async () => {
  const failing: FetchLike = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: "Invalid API key" } }),
  });
  const client = createChatClient({
    setting: { id: "p1", preset: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    apiKey: "bad-key",
    fetchImpl: failing,
  });
  await assert.rejects(
    async () => {
      for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) {
        void _;
      }
    },
    /鉴权失败.*Invalid API key/s,
  );
});

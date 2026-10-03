import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROVIDER_PRESETS,
  SecretsUnavailableError,
  SettingsStore,
  type SecretBox,
} from "../src/gui/secrets.ts";

/** 测试密文盒：base64 当作“加密”，足以验证「磁盘无明文」的契约。 */
function fakeBox(): SecretBox {
  return {
    isAvailable: () => true,
    encrypt: (plaintext) => Buffer.from(`enc:${Buffer.from(plaintext, "utf8").toString("base64")}`),
    decrypt: (ciphertext) => {
      const text = ciphertext.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("密文格式不符");
      return Buffer.from(text.slice(4), "base64").toString("utf8");
    },
  };
}

async function makeUserDataDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "gui-secrets-"));
}

test("T5：服务商预设五类齐全且协议正确", () => {
  assert.deepEqual(
    PROVIDER_PRESETS.map((preset) => preset.id),
    ["zhipu", "openai", "anthropic", "ollama", "custom"],
  );
  const anthropic = PROVIDER_PRESETS.find((preset) => preset.id === "anthropic")!;
  assert.equal(anthropic.protocol, "anthropic");
  const ollama = PROVIDER_PRESETS.find((preset) => preset.id === "ollama")!;
  assert.equal(ollama.needsApiKey, false);
  assert.match(ollama.defaultBaseUrl, /^http:\/\/127\.0\.0\.1/);
});

test("T5：保存后磁盘无明文密钥且解密一致", async () => {
  const dir = await makeUserDataDir();
  try {
    const store = new SettingsStore(dir, fakeBox());
    const settings = await store.saveProvider({
      preset: "zhipu",
      apiKey: "sk-test-密钥-abc123",
    });
    assert.equal(settings.providers.length, 1);
    assert.equal(settings.activeProviderId, settings.providers[0]!.id);

    const configRaw = await readFile(path.join(dir, "config.json"), "utf8");
    const keysRaw = await readFile(path.join(dir, "keys.json"), "utf8");
    assert.ok(!configRaw.includes("sk-test-密钥-abc123"), "config.json 不得含明文密钥");
    assert.ok(!keysRaw.includes("sk-test-密钥-abc123"), "keys.json 不得含明文密钥");

    const key = await store.getApiKey(settings.providers[0]!.id);
    assert.equal(key, "sk-test-密钥-abc123");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T5：更新时不带 apiKey 保留既有密文；setActive 校验存在性", async () => {
  const dir = await makeUserDataDir();
  try {
    const store = new SettingsStore(dir, fakeBox());
    const first = await store.saveProvider({ preset: "openai", apiKey: "sk-one" });
    const id = first.providers[0]!.id;
    const second = await store.saveProvider({ id, preset: "openai", model: "gpt-4o" });
    assert.equal(second.providers.length, 1);
    assert.equal(second.providers[0]!.model, "gpt-4o");
    assert.equal(await store.getApiKey(id), "sk-one");

    const switched = await store.setActive(id);
    assert.equal(switched.activeProviderId, id);
    assert.rejects(() => store.setActive("不存在"), /不存在/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T5：加密不可用时拒绝保存且不留明文、不落文件", async () => {
  const dir = await makeUserDataDir();
  try {
    const store = new SettingsStore(dir, null);
    await assert.rejects(
      () => store.saveProvider({ preset: "zhipu", apiKey: "sk-明文-泄漏" }),
      SecretsUnavailableError,
    );
    const configRaw = await readFile(path.join(dir, "config.json"), "utf8").catch(() => null);
    const keysRaw = await readFile(path.join(dir, "keys.json"), "utf8").catch(() => null);
    assert.equal(keysRaw, null, "keys.json 不应被创建");
    if (configRaw !== null) assert.ok(!configRaw.includes("sk-明文-泄漏"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T5：deleteProvider 同步清理密文并回退激活项", async () => {
  const dir = await makeUserDataDir();
  try {
    const store = new SettingsStore(dir, fakeBox());
    const a = await store.saveProvider({ preset: "zhipu", apiKey: "sk-a" });
    const b = await store.saveProvider({ preset: "openai", apiKey: "sk-b" });
    const idA = a.providers[0]!.id;
    const idB = b.providers.find((item) => item.id !== idA)!.id;

    const after = await store.deleteProvider(idA);
    assert.equal(after.providers.length, 1);
    assert.equal(after.activeProviderId, idB);
    assert.equal(await store.getApiKey(idA), null);
    assert.equal(await store.getApiKey(idB), "sk-b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T5：损坏的 config.json 按空设置处理", async () => {
  const dir = await makeUserDataDir();
  try {
    const store = new SettingsStore(dir, fakeBox());
    await store.saveProvider({ preset: "ollama" });
    await readFile(path.join(dir, "config.json"), "utf8");
    await writeFile(path.join(dir, "config.json"), "{ 损坏", "utf8");
    const settings = await store.getSettings();
    assert.deepEqual(settings, { providers: [], activeProviderId: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- T7：工具定义 ---------- */

import { READ_TOOLS, toolByName } from "../src/gui/ai/tools.ts";
import { taskConfigToGoal, type TaskConfig } from "../src/workflow/taskConfig.ts";
import { emptyState, saveState } from "../src/workspace/store.ts";
import { existsSync } from "node:fs";
import { AiOrchestrator, type AiEvent, type AiStoredMessage } from "../src/gui/ai/orchestrator.ts";
import type { ChatClient, ChatEvent, ChatStreamInput, ToolCallRequest } from "../src/gui/ai/providers.ts";
import type { ProviderSetting } from "../src/gui/secrets.ts";

async function makeFixtureWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gui-ai-ws-"));
  const config: TaskConfig = {
    schemaVersion: 1,
    title: "AI 测试样板",
    theme: "临时工作区",
    moodArc: [{ name: "平静", energy: 0 }],
    duration: { minSeconds: 30, maxSeconds: 60 },
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    assets: [
      { sourceUrl: "https://www.pexels.com/video/ai-test/", licenseUrl: "https://www.pexels.com/license/" },
    ],
  };
  await saveState(dir, emptyState(taskConfigToGoal(config)), 0);
  return dir;
}

test("T7：读工具返回读层真实数据", async () => {
  const dir = await makeFixtureWorkspace();
  try {
    const status = await toolByName("get_status")!.execute!({}, { dir });
    const parsed = JSON.parse(status) as { phase: string; counts: { assets: number } };
    assert.equal(parsed.phase, "assets");
    assert.equal(parsed.counts.assets, 0);
    const artifacts = await toolByName("list_artifacts")!.execute!({}, { dir });
    assert.deepEqual(JSON.parse(artifacts), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T7：写工具只产出待确认动作，参数非法时抛中文错误", async () => {
  const dir = "/tmp/任意目录"; // buildAction 不触碰文件系统
  const render = toolByName("render_score")!.buildAction!({}, { dir });
  assert.equal(render.kind, "render");
  assert.deepEqual(render.argv, ["--workspace", dir, "score"]);
  assert.match(render.effectHint, /工程/);

  const review = toolByName("record_review")!.buildAction!(
    { decision: "approve", feedback: "可以" },
    { dir },
  );
  assert.deepEqual(review.argv.slice(2), ["--decision", "approve", "--feedback", "可以"]);

  assert.throws(() => toolByName("submit_checkpoint")!.buildAction!({}, { dir }), /缺少必需参数 summary/);
  assert.throws(
    () => toolByName("record_review")!.buildAction!({ decision: "changes" }, { dir }),
    /必须提供 feedback/,
  );
  assert.equal(READ_TOOLS.every((tool) => tool.execute !== undefined), true);
  assert.equal(READ_TOOLS.every((tool) => tool.buildAction === undefined), true);
});

/* ---------- T8：会话编排 ---------- */

interface ScriptedTurn {
  events: ChatEvent[];
}

function scriptedClient(turns: ScriptedTurn[]): { client: ChatClient; inputs: ChatStreamInput[] } {
  let index = 0;
  const inputs: ChatStreamInput[] = [];
  const client: ChatClient = {
    async *stream(input) {
      inputs.push(input);
      const turn = turns[Math.min(index, turns.length - 1)]!;
      for (const event of turn.events) yield event;
      index++;
    },
  };
  return { client, inputs };
}

function toolCallsEvent(calls: ToolCallRequest[]): ChatEvent {
  return { type: "toolCalls", calls };
}

async function makeAiSetup(options: { withProvider: boolean }): Promise<{
  userDataDir: string;
  sessionsDir: string;
  settings: SettingsStore;
}> {
  const userDataDir = await makeUserDataDir();
  const settings = new SettingsStore(userDataDir, fakeBox());
  if (options.withProvider) {
    await settings.saveProvider({ preset: "ollama", model: "test-model" });
  }
  return { userDataDir, sessionsDir: path.join(userDataDir, "sessions"), settings };
}

function collectEvents(orchestrator: AiOrchestrator, dir: string): {
  events: AiEvent[];
  confirmations: { id: string; resolve: (approved: boolean) => void }[];
} {
  const events: AiEvent[] = [];
  const confirmations: { id: string; resolve: (approved: boolean) => void }[] = [];
  orchestrator.onUpdate((event) => {
    events.push(event);
    if (event.type === "confirmation") {
      confirmations.push({ id: event.confirmationId, resolve: (approved) => void orchestrator.confirm(dir, event.confirmationId, approved) });
    }
  });
  return { events, confirmations };
}

function messagesOf(events: AiEvent[]): AiStoredMessage[] {
  return events.filter((event): event is Extract<AiEvent, { type: "assistantMessage" }> => event.type === "assistantMessage")
    .map((event) => event.message);
}

test("T8：批准路径——写工具经确认后由命令桥执行并回填", async () => {
  const dir = await makeFixtureWorkspace();
  const setup = await makeAiSetup({ withProvider: true });
  try {
    const { client, inputs } = scriptedClient([
      {
        events: [
          { type: "text", text: "我来把通知强度改为 all，需要你确认。" },
          toolCallsEvent([{ id: "c1", name: "monitor_config", arguments: '{"notification":"all"}' }]),
          { type: "done", stopReason: "tool_use" },
        ],
      },
      { events: [{ type: "text", text: "已执行完成。" }, { type: "done", stopReason: "end_turn" }] },
    ]);
    const orchestrator = new AiOrchestrator({
      settings: setup.settings,
      sessionsDir: setup.sessionsDir,
      createClient: () => client,
    });
    const { events, confirmations } = collectEvents(orchestrator, dir);
    const sendPromise = orchestrator.send(dir, "把监测通知改成 all");
    await new Promise<void>((resolve) => {
      const check = () => {
        if (confirmations.length > 0) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    assert.equal(confirmations.length, 1);
    const confirmationEvent = events.find((event): event is Extract<AiEvent, { type: "confirmation" }> => event.type === "confirmation")!;
    assert.deepEqual(confirmationEvent.action.argv, ["config", "--workspace", dir, "--notification", "all"]);
    confirmations[0]!.resolve(true);
    await sendPromise;

    const toolResult = events.find((event): event is Extract<AiEvent, { type: "toolResult" }> => event.type === "toolResult")!;
    assert.equal(toolResult.ok, true);
    assert.match(toolResult.summary, /已执行/);
    // 命令真实执行：monitor config 已持久化到 .monitor/state.json
    const monitorRaw = await readFile(path.join(dir, ".monitor", "state.json"), "utf8");
    assert.match(monitorRaw, /"notificationLevel": "all"/);
    // 工具结果回填进第二轮对话
    const toolMessages = inputs[1]!.messages.filter((message) => message.role === "tool");
    assert.match(toolMessages[0]!.content ?? "", /命令已执行成功/);
    assert.ok(messagesOf(events).some((message) => message.content === "已执行完成。"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(setup.userDataDir, { recursive: true, force: true });
  }
});

test("T8：拒绝路径——零副作用且回填拒绝原因", async () => {
  const dir = await makeFixtureWorkspace();
  const setup = await makeAiSetup({ withProvider: true });
  try {
    const { client } = scriptedClient([
      {
        events: [
          toolCallsEvent([{ id: "c1", name: "monitor_config", arguments: '{"notification":"all"}' }]),
          { type: "done", stopReason: "tool_use" },
        ],
      },
      { events: [{ type: "text", text: "好的，那我不改了。" }, { type: "done", stopReason: "end_turn" }] },
    ]);
    const orchestrator = new AiOrchestrator({
      settings: setup.settings,
      sessionsDir: setup.sessionsDir,
      createClient: () => client,
    });
    const { confirmations, events } = collectEvents(orchestrator, dir);
    const sendPromise = orchestrator.send(dir, "改配置");
    await new Promise<void>((resolve) => {
      const check = () => {
        if (confirmations.length > 0) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    confirmations[0]!.resolve(false);
    await sendPromise;
    assert.equal(existsSync(path.join(dir, ".monitor")), false, "拒绝后不得产生 .monitor");
    const toolResult = events.find((event): event is Extract<AiEvent, { type: "toolResult" }> => event.type === "toolResult")!;
    assert.equal(toolResult.ok, false);
    assert.match(toolResult.summary, /拒绝/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(setup.userDataDir, { recursive: true, force: true });
  }
});

test("T8：会话按工作区持久化，重启后可续", async () => {
  const dir = await makeFixtureWorkspace();
  const setup = await makeAiSetup({ withProvider: true });
  try {
    const { client } = scriptedClient([
      {
        events: [
          toolCallsEvent([{ id: "c1", name: "get_status", arguments: "{}" }]),
          { type: "done", stopReason: "tool_use" },
        ],
      },
      { events: [{ type: "text", text: "当前在 assets 阶段。" }, { type: "done", stopReason: "end_turn" }] },
    ]);
    const first = new AiOrchestrator({
      settings: setup.settings,
      sessionsDir: setup.sessionsDir,
      createClient: () => client,
    });
    await first.send(dir, "现在做到哪了");
    const reloaded = new AiOrchestrator({
      settings: setup.settings,
      sessionsDir: setup.sessionsDir,
      createClient: () => client,
    });
    const history = await reloaded.history(dir);
    const roles = history.map((message) => message.role);
    assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
    assert.match(history[2]!.content, /"phase": "assets"/);
    assert.equal(history[3]!.content, "当前在 assets 阶段。");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(setup.userDataDir, { recursive: true, force: true });
  }
});

test("T8：未配置模型时给出可读指引", async () => {
  const dir = await makeFixtureWorkspace();
  const setup = await makeAiSetup({ withProvider: false });
  try {
    const orchestrator = new AiOrchestrator({
      settings: setup.settings,
      sessionsDir: setup.sessionsDir,
      createClient: () => {
        throw new Error("不应构造客户端");
      },
    });
    const { events } = collectEvents(orchestrator, dir);
    await orchestrator.send(dir, "现在做到哪了");
    const errorEvent = events.find((event): event is Extract<AiEvent, { type: "error" }> => event.type === "error");
    assert.match(errorEvent?.message ?? "", /尚未配置模型/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(setup.userDataDir, { recursive: true, force: true });
  }
});

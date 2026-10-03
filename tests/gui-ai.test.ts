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

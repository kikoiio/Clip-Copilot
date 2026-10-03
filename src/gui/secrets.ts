/**
 * 服务商预设、设置与密钥存储（spec F8；plan.md 的 secrets.ts 模块）。
 * API key 只以 safeStorage 密文落盘（userData/keys.json），配置本体不含明文；
 * 加密后端可注入（node 测试环境没有 Electron），解密只发生在主进程内存。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type ProviderPresetId = "zhipu" | "openai" | "anthropic" | "ollama" | "custom";

export type ProviderProtocol = "openai" | "anthropic";

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  needsApiKey: boolean;
  protocol: ProviderProtocol;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "zhipu",
    label: "智谱 GLM",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    needsApiKey: true,
    protocol: "openai",
  },
  {
    id: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    needsApiKey: true,
    protocol: "openai",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-5",
    needsApiKey: true,
    protocol: "anthropic",
  },
  {
    id: "ollama",
    label: "Ollama（本机）",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:7b",
    needsApiKey: false,
    protocol: "openai",
  },
  {
    id: "custom",
    label: "自定义 OpenAI 兼容端点",
    defaultBaseUrl: "",
    defaultModel: "",
    needsApiKey: true,
    protocol: "openai",
  },
];

export function providerPreset(id: ProviderPresetId): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(`未知服务商预设: ${id}`);
  return preset;
}

export interface ProviderSetting {
  id: string;
  preset: ProviderPresetId;
  baseUrl: string;
  model: string;
}

export interface Settings {
  providers: ProviderSetting[];
  activeProviderId: string | null;
}

export function emptySettings(): Settings {
  return { providers: [], activeProviderId: null };
}

/** 加密后端抽象；默认实现基于 Electron safeStorage，测试注入替身。 */
export interface SecretBox {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

/** 系统凭据加密不可用（无密钥环等）；按 N5 显式报错，绝不回落明文。 */
export class SecretsUnavailableError extends Error {}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

/** 默认后端：惰性加载 Electron 的 safeStorage（纯 node 环境下不可用）。 */
export async function defaultSecretBox(): Promise<SecretBox> {
  const mod = (await import("electron")) as unknown as { safeStorage?: SafeStorageLike };
  const safeStorage = mod.safeStorage;
  if (!safeStorage) {
    throw new SecretsUnavailableError("当前运行环境没有 Electron safeStorage");
  }
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  };
}

const CONFIG_FILE = "config.json";
const KEYS_FILE = "keys.json";

export interface SaveProviderInput {
  /** 省略时新建；提供时更新对应条目。 */
  id?: string;
  preset: ProviderPresetId;
  baseUrl?: string;
  model?: string;
  /** 明文 key 只在此刻经 SecretBox 加密，调用后不保留。 */
  apiKey?: string;
}

export class SettingsStore {
  readonly #dir: string;
  readonly #box: SecretBox | null;

  constructor(userDataDir: string, box: SecretBox | null = null) {
    this.#dir = userDataDir;
    this.#box = box;
  }

  async getSettings(): Promise<Settings> {
    const raw = await readFile(path.join(this.#dir, CONFIG_FILE), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (raw === null) return emptySettings();
    try {
      const parsed = JSON.parse(raw) as Settings;
      return {
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        activeProviderId: typeof parsed.activeProviderId === "string" ? parsed.activeProviderId : null,
      };
    } catch {
      // 损坏的配置按空设置处理，不阻塞 GUI；密钥文件不动。
      return emptySettings();
    }
  }

  /**
   * 保存提供方。带 apiKey 时加密写 keys.json（加密不可用则整体失败、不留明文）；
   * 不带时保留既有密文。
   */
  async saveProvider(input: SaveProviderInput): Promise<Settings> {
    const preset = providerPreset(input.preset);
    const settings = await this.getSettings();
    const id = input.id ?? `provider-${Date.now()}-${Math.random().toString(36).slice(1, 7)}`;
    const existing = settings.providers.find((item) => item.id === id);
    const setting: ProviderSetting = {
      id,
      preset: preset.id,
      baseUrl: input.baseUrl ?? existing?.baseUrl ?? preset.defaultBaseUrl,
      model: input.model ?? existing?.model ?? preset.defaultModel,
    };
    settings.providers = [...settings.providers.filter((item) => item.id !== id), setting];
    if (settings.activeProviderId === null) settings.activeProviderId = id;

    if (input.apiKey !== undefined && input.apiKey !== "") {
      await this.#writeSecret(id, input.apiKey);
    }
    // 新建条目但未提供 key 时允许占位保存，AI 面板按未配置处理。
    await this.#writeConfig(settings);
    return settings;
  }

  async setActive(id: string): Promise<Settings> {
    const settings = await this.getSettings();
    if (!settings.providers.some((item) => item.id === id)) {
      throw new Error(`提供方 ${id} 不存在`);
    }
    settings.activeProviderId = id;
    await this.#writeConfig(settings);
    return settings;
  }

  async deleteProvider(id: string): Promise<Settings> {
    const settings = await this.getSettings();
    settings.providers = settings.providers.filter((item) => item.id !== id);
    if (settings.activeProviderId === id) {
      settings.activeProviderId = settings.providers[0]?.id ?? null;
    }
    await this.#writeConfig(settings);
    await this.#deleteSecret(id);
    return settings;
  }

  /** 主进程内存解密；供 AI 请求头使用，调用后即弃。 */
  async getApiKey(providerId: string): Promise<string | null> {
    const raw = await readFile(path.join(this.#dir, KEYS_FILE), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (raw === null) return null;
    const keys = JSON.parse(raw) as Record<string, string>;
    const encoded = keys[providerId];
    if (!encoded) return null;
    const box = this.#requireBox();
    return box.decrypt(Buffer.from(encoded, "base64"));
  }

  #requireBox(): SecretBox {
    if (!this.#box || !this.#box.isAvailable()) {
      throw new SecretsUnavailableError(
        "系统凭据加密不可用，无法存取 API 密钥（密钥绝不以明文落盘）",
      );
    }
    return this.#box;
  }

  async #writeSecret(id: string, plaintext: string): Promise<void> {
    const box = this.#requireBox();
    const encoded = box.encrypt(plaintext).toString("base64");
    const keys = await this.#readKeys();
    keys[id] = encoded;
    await this.#ensureDir();
    await writeFile(path.join(this.#dir, KEYS_FILE), JSON.stringify(keys, null, 2), "utf8");
  }

  async #deleteSecret(id: string): Promise<void> {
    const keys = await this.#readKeys();
    if (!(id in keys)) return;
    delete keys[id];
    await writeFile(path.join(this.#dir, KEYS_FILE), JSON.stringify(keys, null, 2), "utf8");
  }

  async #readKeys(): Promise<Record<string, string>> {
    const raw = await readFile(path.join(this.#dir, KEYS_FILE), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
  }

  async #writeConfig(settings: Settings): Promise<void> {
    await this.#ensureDir();
    await writeFile(path.join(this.#dir, CONFIG_FILE), JSON.stringify(settings, null, 2), "utf8");
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
  }
}

/** 测试辅助：清空 userData 目录（不用于生产路径）。 */
export async function removeUserDataDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

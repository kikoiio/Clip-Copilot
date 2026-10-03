import { useEffect, useState } from "react";
import { gui } from "../api.ts";
import type { ProviderPreset, Settings as SettingsData } from "../types.ts";

/** 设置（spec F8）：服务商预设选择、端点/模型/密钥表单、激活切换。 */
export function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [preset, setPreset] = useState<string>("zhipu");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const data = await gui.getSettings();
    setSettings(data.settings);
    setPresets(data.presets);
  };

  useEffect(() => {
    void reload().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const applyPreset = (id: string) => {
    setPreset(id);
    const found = presets.find((item) => item.id === id);
    if (found) {
      setBaseUrl(found.defaultBaseUrl);
      setModel(found.defaultModel);
    }
    setApiKey("");
  };

  const save = async () => {
    setError(null);
    setMessage(null);
    try {
      const updated = await gui.saveProvider({
        preset: preset as ProviderPreset["id"],
        baseUrl,
        model,
        ...(apiKey.trim() !== "" ? { apiKey } : {}),
      });
      setSettings(updated);
      setApiKey("");
      setMessage("已保存（密钥加密落盘，不进入仓库与工作区）");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const activate = async (id: string) => {
    try {
      setSettings(await gui.setActiveProvider(id));
      setMessage("已切换激活的服务商");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>已配置的服务商</h2>
        {!settings || settings.providers.length === 0 ? (
          <p className="muted">还没有配置；AI 面板在配置前不可用。</p>
        ) : (
          <table className="table">
            <thead><tr><th>预设</th><th>端点</th><th>模型</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {settings.providers.map((provider) => (
                <tr key={provider.id}>
                  <td>{provider.preset}</td>
                  <td className="mono small">{provider.baseUrl || "（未填）"}</td>
                  <td className="mono small">{provider.model || "（未填）"}</td>
                  <td>
                    {settings.activeProviderId === provider.id
                      ? <span className="badge badge-done">激活中</span>
                      : <button className="btn small" onClick={() => void activate(provider.id)}>激活</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>新增 / 更新服务商</h2>
        <p className="muted">
          预设覆盖智谱 GLM、OpenAI、Anthropic、Ollama 与自定义 OpenAI 兼容端点。
          API Key 只存本机用户配置目录（safeStorage 加密），不进入仓库与工作区。
        </p>
        <label>预设
          <select value={preset} onChange={(event) => applyPreset(event.target.value)}>
            {presets.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>Base URL
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…" />
        </label>
        <label>模型名
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="如 glm-4-flash" />
        </label>
        <label>API Key（留空表示不更新密钥）
          <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
        </label>
        <button className="btn primary" onClick={() => void save()}>保存</button>
        {message && <p className="ok-text">{message}</p>}
        {error && <p className="error-text">{error}</p>}
      </section>
    </div>
  );
}

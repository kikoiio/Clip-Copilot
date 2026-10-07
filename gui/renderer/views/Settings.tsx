import { useEffect, useRef, useState } from "react";
import { gui } from "../api.ts";
import type { ProviderPreset, ProviderSetting, Settings as SettingsData } from "../types.ts";

/** 设置（spec F8）：服务商预设选择、端点/模型/密钥表单、激活切换。 */
export function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [preset, setPreset] = useState<string>("zhipu");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const baseUrlInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const data = await gui.getSettings();
    setSettings(data.settings);
    setPresets(data.presets);
    const initialPreset = data.presets.find((item) => item.id === "zhipu");
    if (initialPreset) {
      setBaseUrl(initialPreset.defaultBaseUrl);
      setModel(initialPreset.defaultModel);
    }
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

  const edit = (provider: ProviderSetting) => {
    setEditingId(provider.id);
    setPreset(provider.preset);
    setBaseUrl(provider.baseUrl);
    setModel(provider.model);
    setApiKey("");
    setMessage(null);
    setError(null);
    baseUrlInput.current?.focus();
  };

  const startNew = () => {
    setEditingId(null);
    applyPreset("zhipu");
    setMessage(null);
    setError(null);
  };

  const save = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const updated = await gui.saveProvider({
        ...(editingId !== null ? { id: editingId } : {}),
        preset: preset as ProviderPreset["id"],
        baseUrl,
        model,
        ...(apiKey.trim() !== "" ? { apiKey } : {}),
      });
      setSettings(updated);
      if (editingId === null) {
        const created = updated.providers.find((provider) =>
          !settings?.providers.some((existing) => existing.id === provider.id));
        if (created) setEditingId(created.id);
      }
      setApiKey("");
      setMessage(editingId !== null
        ? "已更新配置；密钥留空时保留原密钥。"
        : "已新增配置。填写的密钥加密保存在本机。"
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const activate = async (id: string) => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      setSettings(await gui.setActiveProvider(id));
      setMessage("已切换激活的服务商");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
            <thead><tr><th>预设</th><th>端点</th><th>模型</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {settings.providers.map((provider) => (
                <tr key={provider.id}>
                  <td>{provider.preset}</td>
                  <td className="mono small">{provider.baseUrl || "（未填）"}</td>
                  <td className="mono small">{provider.model || "（未填）"}</td>
                  <td>
                    {settings.activeProviderId === provider.id
                      ? <span className="badge badge-done">激活中</span>
                      : <button className="btn small" disabled={busy} onClick={() => void activate(provider.id)}>激活</button>}
                  </td>
                  <td className="row-actions">
                    <button className="btn small" disabled={busy}
                      aria-label={`编辑 ${provider.model || provider.preset}`}
                      onClick={() => edit(provider)}>
                      {editingId === provider.id ? "正在编辑" : "编辑"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>{editingId !== null ? "编辑服务商配置" : "新增服务商"}</h2>
        <p className="muted">
          预设覆盖智谱 GLM、OpenAI、Anthropic、Ollama 与自定义 OpenAI 兼容端点。
          API Key 只存本机用户配置目录（safeStorage 加密），不进入仓库与工作区。
        </p>
        <form onSubmit={(event) => { event.preventDefault(); if (!busy) void save(); }}>
          <label>预设
            <select disabled={busy || settings === null} value={preset} onChange={(event) => applyPreset(event.target.value)}>
              {presets.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <label>Base URL
            <input ref={baseUrlInput} disabled={busy || settings === null} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…" />
          </label>
          <label>模型名
            <input disabled={busy || settings === null} value={model} onChange={(event) => setModel(event.target.value)} placeholder="如 glm-4-flash" />
          </label>
          <label>{editingId !== null ? "API Key（留空保留原密钥；填写新密钥可替换）" : "API Key"}
            <input type="password" autoComplete="new-password" disabled={busy || settings === null} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </label>
          <div className="btn-row">
            <button type="submit" className="btn primary" disabled={busy || settings === null}>
              {busy ? "处理中…" : editingId !== null ? "保存修改" : "新增配置"}
            </button>
            {editingId !== null && <button type="button" className="btn" disabled={busy} onClick={startNew}>取消编辑</button>}
          </div>
        </form>
        {message && <p role="status" className="ok-text">{message}</p>}
        {error && <p role="alert" className="error-text">{error}</p>}
      </section>
    </div>
  );
}

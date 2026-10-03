import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { gui } from "./api.ts";
import { phaseLabel } from "./labels.ts";
import type { MonitorUpdate, WorkspaceDetail, WorkspaceSummary } from "./types.ts";
import { Dashboard } from "./views/Dashboard.tsx";
import { Artifacts } from "./views/Artifacts.tsx";
import { Actions } from "./views/Actions.tsx";
import { Suggestions } from "./views/Suggestions.tsx";
import { AiPanel } from "./views/AiPanel.tsx";
import { Settings } from "./views/Settings.tsx";

type Tab = "dashboard" | "artifacts" | "actions" | "suggestions" | "ai" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "总览" },
  { id: "artifacts", label: "产物与预览" },
  { id: "actions", label: "动作" },
  { id: "suggestions", label: "建议" },
  { id: "ai", label: "AI 助手" },
  { id: "settings", label: "设置" },
];

function phaseBadgeClass(phase: string): string {
  if (phase === "done") return "badge badge-done";
  if (phase.endsWith("review")) return "badge badge-review";
  return "badge";
}

function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  // 开发钩子：GUI_TAB=<tab> 指定初始页签（自动化截图检查用），正常启动无感知。
  const [tab, setTab] = useState<Tab>(() => {
    const initial = new URLSearchParams(window.location.search).get("tab");
    return TABS.some((item) => item.id === initial) ? initial as Tab : "dashboard";
  });
  const [error, setError] = useState<string | null>(null);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const list = await gui.listWorkspaces();
      console.info(`[工作台] 已加载 ${list.length} 个工作区: ${list.map((item) => item.name).join(", ")}`);
      setWorkspaces(list);
      setSelectedDir((current) => current ?? list[0]?.dir ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshDetail = useCallback(async (dir: string) => {
    try {
      setDetail(await gui.getWorkspace(dir));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaces();
    const unsubscribe = gui.onMonitorUpdate((update: MonitorUpdate) => {
      if (update.dir === selectedDir) void refreshDetail(update.dir);
    });
    const unsubscribeSense = gui.onSenseUpdate((update) => {
      if (update.dir === selectedDir) void refreshDetail(update.dir);
    });
    return () => { unsubscribe(); unsubscribeSense(); };
  }, [refreshWorkspaces, refreshDetail, selectedDir]);

  useEffect(() => {
    if (selectedDir) void refreshDetail(selectedDir);
  }, [selectedDir, refreshDetail]);

  const selected = workspaces.find((item) => item.dir === selectedDir) ?? null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>AI 创作工作台</h1>
          <p className="brand-sub">Kdenlive × LMMS 短片工作流</p>
        </div>
        <nav className="ws-list">
          {workspaces.length === 0 && <p className="empty">workspaces/ 下暂无工作区</p>}
          {workspaces.map((item) => (
            <button
              key={item.dir}
              className={`ws-item${item.dir === selectedDir ? " active" : ""}`}
              onClick={() => setSelectedDir(item.dir)}
            >
              <span className="ws-name">{item.name}</span>
              {item.state && <span className={phaseBadgeClass(item.state.phase)}>{phaseLabel(item.state.phase)}</span>}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">
        {selected?.state && (
          <header className="topbar">
            <div>
              <strong>{selected.name}</strong>
              <span className="muted">　{phaseLabel(selected.state.phase)} · revision {selected.state.revision}</span>
            </div>
            <div className="muted next-hint">下一步：{selected.state.nextAction}</div>
          </header>
        )}
        <nav className="tabs">
          {TABS.map((item) => (
            <button key={item.id} className={`tab${tab === item.id ? " active" : ""}`} onClick={() => setTab(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
        {error && <div className="error-banner">{error}</div>}
        {detail ? (
          <section className="content">
            {tab === "dashboard" && <Dashboard detail={detail} onChanged={() => void refreshDetail(detail.dir)} />}
            {tab === "artifacts" && <Artifacts detail={detail} />}
            {tab === "actions" && <Actions detail={detail} onChanged={() => void refreshDetail(detail.dir)} />}
            {tab === "suggestions" && (
              <Suggestions detail={detail} onChanged={() => void refreshDetail(detail.dir)} />
            )}
            {tab === "ai" && <AiPanel dir={detail.dir} name={detail.name} />}
            {tab === "settings" && <Settings />}
          </section>
        ) : (
          <section className="content empty-state">
            <p>选择左侧工作区，或通过 CLI `init` 创建后刷新。</p>
          </section>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

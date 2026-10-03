import { useEffect, useState } from "react";
import { gui } from "../api.ts";
import { statusLabel } from "../labels.ts";
import type { MonitorHostEntry, WorkspaceDetail } from "../types.ts";

/** 建议与监测（spec F5）：开关监测、实时清单、确认/忽略、统计。 */
export function Suggestions({ detail, onChanged }: { detail: WorkspaceDetail; onChanged: () => void }) {
  const [hostState, setHostState] = useState<MonitorHostEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dir = detail.dir;

  useEffect(() => {
    void gui.monitorList().then((list) => {
      setHostState(list.find((item) => item.dir === dir) ?? null);
    }).catch(() => setHostState(null));
  }, [dir]);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const entry = hostState?.running ? await gui.monitorStop(dir) : await gui.monitorStart(dir);
      setHostState(entry);
      if (entry.error) setError(entry.error);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, decision: "acknowledge" | "ignore") => {
    setBusy(true);
    setError(null);
    try {
      const result = await gui.runAction({
        kind: "monitor_decide",
        label: decision === "acknowledge" ? "确认建议" : "忽略建议",
        argv: ["decide", "--workspace", dir, "--id", id, "--decision", decision],
        effectHint: "把该条监测建议标记为已确认或已忽略",
      });
      if (!result.ok) setError(result.error ?? "执行失败");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const open = detail.suggestions.filter((item) => item.status === "open" || item.status === "acknowledged");
  const done = detail.suggestions.filter((item) => item.status === "ignored" || item.status === "resolved");

  return (
    <div className="stack">
      <section className="card">
        <h2>工作区监测</h2>
        <p className="muted">
          GUI 运行期间内嵌监测；与 CLI `monitor run` 互斥（同一工作区同时只有一个监测者）。
          {detail.metrics && ` 通知尝试 ${detail.metrics.notificationAttempts} / 发送 ${detail.metrics.notificationSent} / 失败 ${detail.metrics.notificationFailed} / 去重 ${detail.metrics.duplicateNotificationsSuppressed}。`}
        </p>
        <button className={`btn ${hostState?.running ? "" : "primary"}`} disabled={busy} onClick={() => void toggle()}>
          {hostState?.running ? "停止监测" : "开启监测"}
        </button>
        {hostState?.error && <p className="error-text">{hostState.error}</p>}
        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="card">
        <h2>待处理建议（{open.length}）</h2>
        {open.length === 0 && <p className="muted">暂无待处理建议。</p>}
        {open.map((item) => (
          <div key={item.id} className="suggestion">
            <div className="suggestion-head">
              <span className={`badge badge-${item.priority === "high" ? "fail" : ""}`}>{item.priority}</span>
              <strong>{item.category}</strong>
              <span className={`badge`}>{statusLabel(item.status)}</span>
            </div>
            <p>{item.evidence}</p>
            <p className="muted small">影响：{item.impact}</p>
            <p className="small">下一步：{item.nextAction}</p>
            {item.affectedPaths.length > 0 && (
              <p className="mono small">{item.affectedPaths.join("、")}</p>
            )}
            <div className="btn-row">
              <button className="btn small" disabled={busy} onClick={() => void decide(item.id, "acknowledge")}>确认</button>
              <button className="btn small" disabled={busy} onClick={() => void decide(item.id, "ignore")}>忽略</button>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>已处理（{done.length}）</h2>
        {done.length === 0 && <p className="muted">暂无记录。</p>}
        {done.map((item) => (
          <div key={item.id} className="suggestion muted">
            <strong>{item.category}</strong>（{statusLabel(item.status)}）——{item.evidence}
          </div>
        ))}
      </section>
    </div>
  );
}

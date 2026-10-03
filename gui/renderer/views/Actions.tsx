import { useState } from "react";
import { gui } from "../api.ts";
import type { ActionResult, WorkspaceDetail, WriteActionSpec } from "../types.ts";
import { CheckResultPanel } from "./CheckResultPanel.tsx";

/**
 * 人工动作（spec F3/F4）：每类动作先填表，再在确认面板上看到
 * 「将会发生什么」与完整命令参数，确认后才经命令桥执行（与 CLI 同一实现）。
 */
export function Actions({ detail, onChanged }: { detail: WorkspaceDetail; onChanged: () => void }) {
  const [pending, setPending] = useState<WriteActionSpec | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const dir = detail.dir;

  const execute = async (spec: WriteActionSpec) => {
    setRunning(true);
    setResult(null);
    try {
      const outcome = await gui.runAction(spec);
      setResult(outcome);
      if (outcome.ok) onChanged();
    } catch (error) {
      setResult({ ok: false, exitCode: 1, lines: [], error: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
      setPending(null);
    }
  };

  const propose = (spec: WriteActionSpec) => {
    setPending(spec);
    setResult(null);
  };

  return (
    <div className="stack">
      {pending && (
        <section className="card confirm-card">
          <h2>确认操作：{pending.label}</h2>
          <p>{pending.effectHint}</p>
          <pre className="cmdline">npm run cli -- {pending.kind === "monitor_config" || pending.kind === "monitor_decide" ? "monitor " : ""}{pending.argv.join(" ")}</pre>
          <div className="btn-row">
            <button className="btn primary" disabled={running} onClick={() => void execute(pending)}>确认执行</button>
            <button className="btn" disabled={running} onClick={() => setPending(null)}>取消</button>
          </div>
        </section>
      )}
      {result && (
        <section className={`card ${result.ok ? "result-ok" : "result-fail"}`}>
          <h2>{result.ok ? "执行成功" : "执行失败"}</h2>
          {result.error && <p className="error-text">{result.error}</p>}
          {result.lines.length > 0 && <pre className="handoff">{result.lines.join("\n")}</pre>}
          <button className="btn" onClick={() => setResult(null)}>关闭</button>
        </section>
      )}

      <VerifyCard busy={running} propose={propose} dir={dir} reports={detail.reports} />
      <ReviewCard busy={running} propose={propose} dir={dir} />
      <CheckpointCard busy={running} propose={propose} dir={dir} />
      <WaiveCard busy={running} propose={propose} dir={dir} />
      <ObserveCard busy={running} propose={propose} dir={dir} />
      <ReopenCard busy={running} propose={propose} dir={dir} />
      <MonitorCard busy={running} propose={propose} dir={dir} suggestions={detail.suggestions} />
      <CheckResultPanel detail={detail} />
    </div>
  );
}

type Proposer = (spec: WriteActionSpec) => void;

function VerifyCard({ dir, propose, busy }: { dir: string; propose: Proposer; busy: boolean; reports: unknown }) {
  return (
    <section className="card">
      <h2>全量验证</h2>
      <p className="muted">运行全部可自动化检查（含深度检查与无界面工程验证），硬伤会阻塞检查点。</p>
      <button
        className="btn primary"
        disabled={busy}
        onClick={() => propose({ kind: "verify", label: "全量验证", argv: ["--workspace", dir], effectHint: "运行全部可自动化检查并写入检查报告" })}
      >
        {busy ? "进行中…" : "运行 verify"}
      </button>
    </section>
  );
}

function ReviewCard({ dir, propose, busy }: { dir: string; propose: Proposer; busy: boolean }) {
  const [decision, setDecision] = useState<"approve" | "changes">("approve");
  const [feedback, setFeedback] = useState("");
  return (
    <section className="card">
      <h2>审阅检查点</h2>
      <label>决定
        <select value={decision} onChange={(event) => setDecision(event.target.value as "approve" | "changes")}>
          <option value="approve">approve——批准并进入下一阶段</option>
          <option value="changes">changes——要求修改（产物退回草稿）</option>
        </select>
      </label>
      <label>意见{decision === "changes" ? "（必填）" : "（可选）"}
        <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={2} />
      </label>
      <button
        className="btn primary"
        disabled={busy || (decision === "changes" && feedback.trim() === "")}
        onClick={() => propose({
          kind: "review",
          label: decision === "approve" ? "批准检查点" : "要求修改",
          argv: ["--workspace", dir, "--decision", decision, ...(feedback ? ["--feedback", feedback] : [])],
          effectHint: decision === "approve" ? "产物转 confirmed 并进入下一阶段" : "相关产物退回 draft，阶段回到草稿",
        })}
      >
        提交审阅
      </button>
    </section>
  );
}

function CheckpointCard({ dir, propose, busy }: { dir: string; propose: Proposer; busy: boolean }) {
  const [summary, setSummary] = useState("");
  return (
    <section className="card">
      <h2>提交检查点</h2>
      <label>摘要（必填）
        <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="如：配乐初稿 v1" />
      </label>
      <button
        className="btn primary"
        disabled={busy || summary.trim() === ""}
        onClick={() => propose({
          kind: "checkpoint",
          label: "提交检查点",
          argv: ["--workspace", dir, "--summary", summary],
          effectHint: "把当前阶段产物冻结为不可变检查点副本；带未豁免硬伤时会被门禁拒绝",
        })}
      >
        提交
      </button>
    </section>
  );
}

function WaiveCard({ dir, propose, busy }: { dir: string; propose: Proposer; busy: boolean }) {
  const [checkId, setCheckId] = useState("");
  const [artifactId, setArtifactId] = useState("");
  const [reason, setReason] = useState("");
  return (
    <section className="card">
      <h2>豁免检查项</h2>
      <p className="muted">豁免针对机器检查项（如 deep:video:black），原因必填并进决定记录。</p>
      <label>检查项 ID
        <input value={checkId} onChange={(event) => setCheckId(event.target.value)} placeholder="deep:video:black" />
      </label>
      <label>产物 ID（可选）
        <input value={artifactId} onChange={(event) => setArtifactId(event.target.value)} />
      </label>
      <label>原因（必填）
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button
        className="btn primary"
        disabled={busy || checkId.trim() === "" || reason.trim() === ""}
        onClick={() => propose({
          kind: "waive",
          label: "豁免检查项",
          argv: ["--workspace", dir, "--check", checkId, ...(artifactId ? ["--artifact", artifactId] : []), "--reason", reason],
          effectHint: "该检查项在门禁评估中降级为告警，不再阻塞",
        })}
      >
        豁免
      </button>
    </section>
  );
}

function ObserveCard({ dir, propose, busy }: { dir: string; propose: Proposer; busy: boolean }) {
  const [name, setName] = useState<"lmms-edit" | "kdenlive-edit" | "subjective">("lmms-edit");
  const [result, setResult] = useState("");
  return (
    <section className="card">
      <h2>登记人工观察</h2>
      <p className="muted">在 LMMS/Kdenlive 中完成副本修改并保存重开后，登记结果使 verify 人工项翻转。</p>
      <label>观察项
        <select value={name} onChange={(event) => setName(event.target.value as typeof name)}>
          <option value="lmms-edit">LMMS 工程可编辑性</option>
          <option value="kdenlive-edit">Kdenlive 工程可编辑性</option>
          <option value="subjective">主观满意度</option>
        </select>
      </label>
      <label>观察结果（必填，如实记录）
        <textarea value={result} onChange={(event) => setResult(event.target.value)} rows={2} />
      </label>
      <button
        className="btn primary"
        disabled={busy || result.trim() === ""}
        onClick={() => propose({
          kind: "observe",
          label: "登记人工观察",
          argv: ["--workspace", dir, "--name", name, "--result", result],
          effectHint: "verify 对应人工项按观察结果翻转，记录写入 evidence/",
        })}
      >
        登记
      </button>
    </section>
  );
}

function ReopenCard({ dir, propose, busy }: { dir: string; propose: Proposer; busy: boolean }) {
  const [reason, setReason] = useState("");
  return (
    <section className="card">
      <h2>重开已交付工作区</h2>
      <p className="muted">仅用于 done 工作区：相关产物失效并回到剪辑草稿，旧终版自动归档。</p>
      <label>原因（可选）
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button
        className="btn"
        disabled={busy}
        onClick={() => propose({
          kind: "reopen",
          label: "重开已交付工作区",
          argv: ["--workspace", dir, ...(reason ? ["--reason", reason] : [])],
          effectHint: "产物失效并回到 video_draft，旧终版自动归档为 superseded",
        })}
      >
        重开
      </button>
    </section>
  );
}

function MonitorCard({ dir, propose, busy, suggestions }: {
  dir: string;
  propose: Proposer;
  busy: boolean;
  suggestions: WorkspaceDetail["suggestions"];
}) {
  const [suggestionId, setSuggestionId] = useState("");
  const [decision, setDecision] = useState<"acknowledge" | "ignore">("acknowledge");
  return (
    <section className="card">
      <h2>处理监测建议</h2>
      <p className="muted">确认/忽略当前轮建议；「建议」页签可实时查看全部建议。</p>
      <label>建议 ID
        <select value={suggestionId} onChange={(event) => setSuggestionId(event.target.value)}>
          <option value="">（选择建议）</option>
          {suggestions.filter((item) => item.status === "open" || item.status === "acknowledged").map((item) => (
            <option key={item.id} value={item.id}>{item.id}——{item.evidence.slice(0, 40)}</option>
          ))}
        </select>
      </label>
      <label>决定
        <select value={decision} onChange={(event) => setDecision(event.target.value as "acknowledge" | "ignore")}>
          <option value="acknowledge">acknowledge——已知晓</option>
          <option value="ignore">ignore——忽略</option>
        </select>
      </label>
      <button
        className="btn primary"
        disabled={busy || suggestionId === ""}
        onClick={() => propose({
          kind: "monitor_decide",
          label: decision === "acknowledge" ? "确认建议" : "忽略建议",
          argv: ["decide", "--workspace", dir, "--id", suggestionId, "--decision", decision],
          effectHint: "把该条监测建议标记为已确认或已忽略",
        })}
      >
        提交
      </button>
    </section>
  );
}

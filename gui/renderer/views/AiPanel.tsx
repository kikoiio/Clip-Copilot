import { useEffect, useRef, useState } from "react";
import { gui } from "../api.ts";
import type { AiEvent, AiStoredMessage, WriteActionSpec } from "../types.ts";

/** AI 面板（spec F6/F7/F8 的界面侧）：对话流、确认卡、流式回答、取消。 */
export function AiPanel({ dir, name }: { dir: string; name: string }) {
  const [history, setHistory] = useState<AiStoredMessage[]>([]);
  const [input, setInput] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [pending, setPending] = useState<{ id: string; action: WriteActionSpec } | null>(null);
  const [liveText, setLiveText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void gui.aiHistory(dir).then(setHistory).catch(() => setHistory([]));
    void gui.aiStatus().then((status) => setConfigured(status.configured)).catch(() => setConfigured(false));
    const unsubscribe = gui.onAiEvent((event: AiEvent) => {
      if (event.dir !== dir) return;
      if (event.type === "token") {
        setLiveText((current) => current + event.text);
      } else if (event.type === "assistantMessage") {
        setHistory((current) => [...current, event.message]);
        setLiveText("");
      } else if (event.type === "confirmation") {
        setPending({ id: event.confirmationId, action: event.action });
      } else if (event.type === "toolResult") {
        setHistory((current) => [...current, {
          role: "tool",
          content: `${event.toolName}：${event.summary}`,
          at: new Date().toISOString(),
        }]);
      } else if (event.type === "error") {
        setError(event.message);
        setStreaming(false);
      } else if (event.type === "done") {
        setStreaming(false);
      }
    });
    return unsubscribe;
  }, [dir]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [history, liveText]);

  const send = async () => {
    const text = input.trim();
    if (text === "" || streaming) return;
    setInput("");
    setError(null);
    setStreaming(true);
    setHistory((current) => [...current, { role: "user", content: text, at: new Date().toISOString() }]);
    try {
      await gui.aiSend(dir, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStreaming(false);
    }
  };

  const decide = async (approved: boolean) => {
    if (!pending) return;
    try {
      await gui.aiConfirm(dir, pending.id, approved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const cancel = async () => {
    await gui.aiCancel(dir).catch(() => undefined);
  };

  if (configured === false) {
    return (
      <section className="card">
        <h2>AI 助手</h2>
        <p>尚未配置模型：请到「设置」页签选择服务商、填入 API Key 并保存。其余界面功能不受影响。</p>
      </section>
    );
  }

  return (
    <div className="stack ai-panel">
      <section className="card chat">
        <h2>AI 助手 · {name}</h2>
        <div className="messages">
          {history.length === 0 && liveText === "" && (
            <p className="muted">问「现在做到哪了」，或让助手发起渲染、检查点等操作（写操作会先弹出确认卡）。</p>
          )}
          {history.map((message, index) => (
            <div key={index} className={`message message-${message.role}`}>
              <span className="role">{message.role === "user" ? "你" : message.role === "assistant" ? "助手" : "工具"}</span>
              <pre className="bubble">{message.content}</pre>
            </div>
          ))}
          {liveText && (
            <div className="message message-assistant">
              <span className="role">助手</span>
              <pre className="bubble">{liveText}</pre>
            </div>
          )}
          {pending && (
            <div className="message message-confirm">
              <span className="role">确认操作</span>
              <div className="bubble">
                <p><strong>{pending.action.label}</strong></p>
                <p>{pending.action.effectHint}</p>
                <pre className="cmdline">{pending.action.argv.join(" ")}</pre>
                <div className="btn-row">
                  <button className="btn primary" onClick={() => void decide(true)}>{pending.action.force ? "仍要执行" : "批准执行"}</button>
                  <button className="btn" onClick={() => void decide(false)}>拒绝</button>
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="chat-input">
          <textarea
            value={input}
            placeholder={streaming ? "回答进行中…" : "输入消息（Enter 发送，Shift+Enter 换行）"}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
          />
          {streaming
            ? <button className="btn" onClick={() => void cancel()}>取消</button>
            : <button className="btn primary" disabled={input.trim() === ""} onClick={() => void send()}>发送</button>}
        </div>
      </section>
    </div>
  );
}

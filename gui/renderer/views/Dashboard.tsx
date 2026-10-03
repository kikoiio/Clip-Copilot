import type { WorkspaceDetail } from "../types.ts";
import { PhaseTimeline } from "./PhaseTimeline.tsx";

/** 总览（spec F1）：阶段机、目标规格、计数、深度检查摘要、下一步与 handoff。 */
export function Dashboard({ detail }: { detail: WorkspaceDetail; onChanged: () => void }) {
  const state = detail.state;
  const deep = state.deepCheck;
  const software = detail.software;
  return (
    <div className="stack">
      <section className="card">
        <h2>阶段机</h2>
        <PhaseTimeline phase={state.phase} />
      </section>
      <section className="card" aria-live="polite">
        <h2>软件活动</h2>
        {software ? (
          <>
            {!software.running && software.degraded.includes("project-mapping-ambiguous")
              ? <p>Kdenlive：存在工程映射歧义，无法判断此工作区是否被占用</p>
              : !software.running ? <p>Kdenlive：未运行</p> : software.instances.map((instance) => (
              <p key={`${instance.pid}-${instance.projectBasename}`}>
                Kdenlive：运行中 · {instance.projectBasename}{instance.projectPath ? `（${instance.projectPath}）` : "（路径未知）"}（{instance.focused === null ? "聚焦未知" : instance.focused ? "聚焦" : "后台"}）
                {software.unsavedSignal === true && <> · 有未保存改动（{software.unsavedSource === "autosave" ? "自动保存文件" : "窗口标题"}）</>}
              </p>
            ))}
            {software.running && software.unsavedSignal === false && <p>未检测到未保存改动</p>}
            {software.running && software.unsavedSignal === null && <p>未保存状态未知</p>}
            {software.degraded.length > 0 && <p className="muted">感知降级：{software.degraded.join("、")}</p>}
          </>
        ) : <p className="muted">感知未启用</p>}
      </section>
      <section className="card">
        <h2>目标与规格</h2>
        <p className="goal-title">{state.goal.title}</p>
        <p className="muted">{state.goal.theme}</p>
        <p>
          {state.goal.width}×{state.goal.height}@{state.goal.fps}，时长目标 {state.goal.minFrames}–{state.goal.maxFrames} 帧
        </p>
      </section>
      <section className="card row">
        <div>
          <h2>素材</h2>
          <p className="big">{state.counts.assets}</p>
        </div>
        <div>
          <h2>产物</h2>
          <p className="big">{state.counts.artifacts}</p>
        </div>
        <div>
          <h2>检查点</h2>
          <p className="big">{state.counts.checkpoints}</p>
        </div>
        <div>
          <h2>未处理建议</h2>
          <p className="big">{detail.suggestions.filter((item) => item.status === "open" || item.status === "acknowledged").length}</p>
        </div>
      </section>
      <section className="card">
        <h2>深度检查</h2>
        {deep ? (
          <div className="chips">
            <span className="chip chip-pass">通过 {deep.pass}</span>
            <span className="chip chip-warn">告警 {deep.warn}</span>
            <span className="chip chip-fail">硬伤 {deep.fail}</span>
            <span className="chip chip-human">待人工 {deep.needsHuman}</span>
          </div>
        ) : (
          <p className="muted">暂无检查报告（先触发一次渲染或全量验证）</p>
        )}
      </section>
      <section className="card">
        <h2>下一步</h2>
        <p>{state.nextAction}</p>
      </section>
      <section className="card">
        <h2>handoff.md</h2>
        {detail.handoff ? (
          <details>
            <summary>查看完整交接文档</summary>
            <pre className="handoff">{detail.handoff}</pre>
          </details>
        ) : (
          <p className="muted">缺失（监测器可在授权后自动重建，或用 CLI resume 生成）</p>
        )}
      </section>
    </div>
  );
}

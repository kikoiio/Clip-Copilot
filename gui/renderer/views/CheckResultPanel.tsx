import { statusLabel } from "../labels.ts";
import type { WorkspaceDetail } from "../types.ts";

/** F4 的就地结果展示：全量验证后逐项结论（与「产物与预览」页签的报告同源）。 */
export function CheckResultPanel({ detail }: { detail: WorkspaceDetail }) {
  const reports = detail.reports;
  if (reports.length === 0) {
    return (
      <section className="card">
        <h2>最近检查结论</h2>
        <p className="muted">暂无报告；运行 verify 或渲染后此处展示逐项结论。</p>
      </section>
    );
  }
  const total = reports.reduce(
    (acc, report) => ({
      pass: acc.pass + report.summary.pass,
      warn: acc.warn + report.summary.warn,
      fail: acc.fail + report.summary.fail,
      needsHuman: acc.needsHuman + report.summary.needsHuman,
    }),
    { pass: 0, warn: 0, fail: 0, needsHuman: 0 },
  );
  const needsHuman = reports.flatMap((report) =>
    report.results
      .filter((result) => result.status === "needs_human" || result.status === "needs_observation")
      .map((result) => ({ artifactId: report.targetArtifactId ?? "unknown", ...result })),
  );
  return (
    <section className="card">
      <h2>最近检查结论（{reports.length} 份报告）</h2>
      <div className="chips">
        <span className="chip chip-pass">通过 {total.pass}</span>
        <span className="chip chip-warn">告警 {total.warn}</span>
        <span className="chip chip-fail">硬伤 {total.fail}</span>
        <span className="chip chip-human">待人工 {total.needsHuman}</span>
      </div>
      {needsHuman.length > 0 && (
        <div>
          <h3>需要人来做的项</h3>
          <ul>
            {needsHuman.map((item) => (
              <li key={`${item.artifactId}-${item.id}`}>
                <span className="mono small">{item.artifactId}</span>：{item.id}——{item.evidence}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary>展开全部逐项结论</summary>
        {reports.map((report, index) => (
          <details key={index} className="report">
            <summary>
              <strong>{report.targetArtifactId ?? "（未登记产物）"}</strong>
              （通过 {report.summary.pass} / 硬伤 {report.summary.fail} / 待人工 {report.summary.needsHuman}）
            </summary>
            <table className="table">
              <thead><tr><th>检查项</th><th>结论</th><th>证据</th></tr></thead>
              <tbody>
                {report.results.map((result) => (
                  <tr key={result.id}>
                    <td className="mono small">{result.id}</td>
                    <td><span className={`badge badge-${result.status}`}>{statusLabel(result.status)}</span></td>
                    <td className="small">{result.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </details>
    </section>
  );
}

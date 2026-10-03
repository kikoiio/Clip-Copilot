import { useEffect, useState } from "react";
import { gui } from "../api.ts";
import { artifactKindLabel, bytesLabel, reviewLabel, statusLabel } from "../labels.ts";
import type { ArtifactView, WorkspaceDetail } from "../types.ts";

/** 产物与预览（spec F2/F4 展示部分）：播放、检查点 manifest、验证报告、定位目录。 */
export function Artifacts({ detail }: { detail: WorkspaceDetail }) {
  const [playing, setPlaying] = useState<ArtifactView | null>(null);
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (playing) {
      void gui.mediaUrl(detail.dir, playing.path).then((url) => {
        if (!cancelled) setMediaSrc(url);
      }).catch(() => setMediaSrc(null));
    } else {
      setMediaSrc(null);
    }
    return () => {
      cancelled = true;
    };
  }, [playing, detail.dir]);

  const isVideo = (artifact: ArtifactView) => artifact.kind === "video_preview" || artifact.kind === "video_final";
  const isAudio = (artifact: ArtifactView) => artifact.kind === "audio_preview" || artifact.kind === "audio_final";

  return (
    <div className="stack">
      {playing && (
        <section className="card">
          <h2>预览：{artifactKindLabel(playing.kind)}</h2>
          <p className="muted">{playing.path}</p>
          {mediaSrc && isVideo(playing) && <video controls autoPlay src={mediaSrc} className="player" />}
          {mediaSrc && isAudio(playing) && <audio controls autoPlay src={mediaSrc} className="audio-player" />}
          {!mediaSrc && <p className="muted">正在生成媒体链接…</p>}
          <button className="btn" onClick={() => setPlaying(null)}>关闭预览</button>
        </section>
      )}
      <section className="card">
        <h2>产物（{detail.artifacts.length}）</h2>
        <table className="table">
          <thead>
            <tr><th>ID</th><th>类型</th><th>文件</th><th>状态</th><th>指纹</th><th>大小</th><th></th></tr>
          </thead>
          <tbody>
            {detail.artifacts.map((artifact) => (
              <tr key={artifact.id}>
                <td className="mono">{artifact.id}</td>
                <td>{artifactKindLabel(artifact.kind)}</td>
                <td className="mono small">{artifact.path}</td>
                <td><span className={artifact.status === "confirmed" ? "badge badge-done" : "badge"}>{statusLabel(artifact.status)}</span></td>
                <td className="mono small">{artifact.sha256.slice(0, 12)}</td>
                <td>
                  {bytesLabel(artifact.bytes)}
                  {!artifact.onDisk && <span className="badge badge-missing">缺盘</span>}
                </td>
                <td className="row-actions">
                  {(isVideo(artifact) || isAudio(artifact)) && artifact.onDisk && (
                    <button className="btn small" onClick={() => setPlaying(artifact)}>播放</button>
                  )}
                  <button className="btn small" onClick={() => void gui.revealInFolder(artifact.absolutePath)}>定位</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>检查点（{detail.checkpoints.length}）</h2>
        {detail.checkpoints.map((checkpoint) => (
          <details key={checkpoint.id} className="checkpoint">
            <summary>
              <strong>{checkpoint.id}</strong>　{checkpoint.summary}　
              <span className={checkpoint.review === "approved" ? "badge badge-done" : "badge"}>{reviewLabel(checkpoint.review)}</span>
            </summary>
            <p className="muted small">创建于 {checkpoint.createdAt} · 阶段 {checkpoint.phase}</p>
            {checkpoint.feedback && <p>反馈：{checkpoint.feedback}</p>}
            {checkpoint.manifest && (
              <table className="table">
                <thead><tr><th>产物</th><th>类型</th><th>文件</th><th>指纹</th></tr></thead>
                <tbody>
                  {checkpoint.manifest.artifacts.map((item) => (
                    <tr key={item.id}>
                      <td className="mono">{item.id}</td>
                      <td>{artifactKindLabel(item.kind)}</td>
                      <td className="mono small">{item.file}</td>
                      <td className="mono small">{item.sha256.slice(0, 12)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        ))}
      </section>

      <section className="card">
        <h2>验证报告（{detail.reports.length} 份）</h2>
        {detail.reports.map((report, index) => (
          <details key={`${report.targetArtifactId}-${report.checkedAt}-${index}`} className="report">
            <summary>
              <strong>{report.targetArtifactId ?? "（未登记产物）"}</strong>　
              通过 {report.summary.pass} · 告警 {report.summary.warn} · 硬伤 {report.summary.fail} · 待人工 {report.summary.needsHuman}
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
      </section>
    </div>
  );
}

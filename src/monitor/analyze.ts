import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { waiversOf, type ArtifactRecord, type WorkspaceState } from "../domain.ts";
import { probeMedia } from "../verification/media.ts";
import { checkProjectReferences } from "../verification/native.ts";
import { applyWaivers } from "../verification/deep.ts";
import { sha256File } from "../workspace/store.ts";
import type { AnalysisResult, FileChange, Finding, FindingCategory, WorkspaceSnapshot } from "./types.ts";

const key = (category: FindingCategory, object: string): string => `${category}:${object}`;
const normalize = (file: string): string => file.replaceAll("\\", "/").replace(/^\.\//, "");
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_BYTES = 16 * 1024 * 1024;

async function readBoundedText(file: string, limit: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error(`文件超过分析上限 ${limit} 字节：${file}`);
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > info.size) throw new Error(`文件读取时仍在增长：${file}`);
    return bytes.toString("utf8", 0, offset);
  } finally { await handle.close(); }
}

/** Only the most recent registration for a path describes the current creative version. */
function currentArtifacts(state: WorkspaceState): ArtifactRecord[] {
  const byPath = new Map<string, ArtifactRecord>();
  for (const item of state.artifacts) {
    const previous = byPath.get(normalize(item.path));
    if (!previous || item.createdAt >= previous.createdAt) byPath.set(normalize(item.path), item);
  }
  return [...byPath.values()];
}

function dependentArtifacts(state: WorkspaceState, id: string): string[] {
  const found = new Set<string>([id]);
  const impacted = new Set<string>();
  for (let pass = 0; pass < state.artifacts.length; pass++) {
    let changed = false;
    for (const artifact of state.artifacts) {
      if (!impacted.has(artifact.id) && artifact.basedOn.some((dep) => found.has(dep))) {
        impacted.add(artifact.id);
        found.add(artifact.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return [...impacted];
}

function currentStageKinds(phase: WorkspaceState["phase"]): ArtifactRecord["kind"][] {
  switch (phase) {
    case "score_review": return ["lmms_project", "audio_preview"];
    case "video_review": return ["kdenlive_project", "video_preview"];
    case "final_verify":
    case "done": return ["kdenlive_project", "audio_final", "video_final"];
    default: return [];
  }
}

function stageArtifacts(state: WorkspaceState, artifacts: ArtifactRecord[]): ArtifactRecord[] {
  const kinds = currentStageKinds(state.phase);
  return kinds.flatMap((kind) => {
    const matches = artifacts.filter((item) => item.kind === kind);
    const latest = matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest ? [latest] : [];
  });
}

async function latestReportFile(workspaceDir: string, artifactId: string): Promise<string | undefined> {
  const dir = path.join(workspaceDir, "evidence");
  const prefix = `check-report-${artifactId}-`;
  const names = await readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const candidates = names.flatMap((name) => {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) return [];
    const timestamp = Number(name.slice(prefix.length, -5));
    return Number.isSafeInteger(timestamp) && timestamp > 0 ? [{ name, timestamp }] : [];
  }).sort((a, b) => b.timestamp - a.timestamp);
  return candidates[0] ? path.join(dir, candidates[0].name) : undefined;
}

async function reportFails(workspaceDir: string, artifact: ArtifactRecord, state: WorkspaceState): Promise<{ evidence: string; file: string } | undefined> {
  const file = await latestReportFile(workspaceDir, artifact.id);
  if (!file) return undefined;
  const parsed = JSON.parse(await readBoundedText(file, MAX_EVIDENCE_BYTES)) as { results?: unknown };
  if (!Array.isArray(parsed.results) || !parsed.results.every((r) => r && typeof r.id === "string" && typeof r.status === "string" && typeof r.evidence === "string")) {
    throw new Error(`检查报告结构无效：${path.relative(workspaceDir, file)}`);
  }
  const fails = applyWaivers(parsed.results, waiversOf(state), artifact.id).filter((r) => r.status === "fail");
  return fails.length ? { file: normalize(path.relative(workspaceDir, file)), evidence: fails.map((r) => `${r.id}: ${r.evidence}`).join("；") } : undefined;
}

function renderOutput(workspaceDir: string, evidenceFile: string, args: string[]): string | undefined {
  const name = path.basename(evidenceFile);
  const outputFlag = args.indexOf("-o");
  const raw = name.startsWith("lmms-render-") ? (outputFlag >= 0 ? args[outputFlag + 1] : undefined) : args[1];
  if (typeof raw !== "string" || !raw) return undefined;
  // Saved evidence can contain absolute paths from before the workspace was copied.
  const inside = path.resolve(workspaceDir, raw);
  const relative = path.relative(workspaceDir, inside);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? path.join(workspaceDir, "outputs", path.basename(raw)) : inside;
}

/** Inspect saved workspace changes without running render or full verify. */
export async function analyzeChanges(
  workspaceDir: string,
  state: WorkspaceState,
  snapshot: WorkspaceSnapshot,
  changes: FileChange[],
  initial: boolean,
): Promise<AnalysisResult> {
  const findings = new Map<string, Finding>();
  const checked = new Set<string>();
  const changed = new Set(changes.map((item) => normalize(item.path)));
  const stateChanged = initial || changed.has("state.json") || snapshot.stateRevision !== state.revision;
  const artifacts = currentArtifacts(state);
  const artifactByPath = new Map(artifacts.map((item) => [normalize(item.path), item]));
  const assetByPath = new Map(state.assets.map((item) => [normalize(item.localPath), item]));
  const paths = initial || stateChanged
    ? new Set([...Object.keys(snapshot.files).map(normalize), ...state.assets.map((a) => normalize(a.localPath)), ...artifacts.map((a) => normalize(a.path))])
    : changed;
  const add = (finding: Finding): void => { checked.add(finding.key); findings.set(finding.key, finding); };
  const question = (scope: string, evidence: string, affectedPaths: string[]): void => add({
    key: key("analysis_error", scope), category: "analysis_error", disposition: "question", priority: "normal",
    evidence, impact: "必要核对未完成，当前状态无法自动判定", nextAction: "检查文件和证据格式，修复后重新扫描。", affectedPaths,
  });

  for (const file of paths) {
    if (file.startsWith("assets/")) {
      const asset = assetByPath.get(file);
      if (!asset) {
        const addedKey = key("asset_added", file);
        checked.add(addedKey);
        if (snapshot.files[file]) {
          const info = await stat(path.join(workspaceDir, file)).catch(() => null);
          if (info?.isFile()) {
            let mediaEvidence = "媒体信息暂不可读";
            try {
              const media = await probeMedia(path.join(workspaceDir, file));
              mediaEvidence = `${Math.round(media.durationMs / 1000)} 秒，${media.width}×${media.height}，音频 ${media.hasAudio ? "有" : "无"}`;
            } catch (error) { mediaEvidence = `媒体信息核对失败：${errorText(error)}`; }
            add({ key: addedKey, category: "asset_added", disposition: "question", priority: "normal",
              evidence: `${file}，${info.size} 字节；${mediaEvidence}`, impact: "新增素材尚未登记来源、许可和用途",
              nextAction: "询问创作者来源与许可，确认后用 ingest 登记。", affectedPaths: [file] });
          }
        }
        continue;
      }
      const missingKey = key("asset_missing", asset.id);
      const changedKey = key("asset_changed", asset.id);
      checked.add(missingKey); checked.add(changedKey); checked.add(key("analysis_error", `asset:${asset.id}`));
      try {
        const info = await stat(path.join(workspaceDir, file)).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        const deps = dependentArtifacts(state, asset.id);
        const affectedPaths = [file, ...artifacts.filter((a) => deps.includes(a.id)).map((a) => normalize(a.path))];
        const used = state.editPlan?.clips.some((clip) => clip.assetId === asset.id) || deps.length > 0;
        if (!info?.isFile()) {
          add({ key: missingKey, category: "asset_missing", disposition: "action", priority: used ? "high" : "normal",
            evidence: `已登记素材 ${asset.id} 缺失：${file}`, impact: deps.length ? `依赖产物：${deps.join(", ")}` : "已登记素材不可用",
            nextAction: "找回原素材并核对指纹；若需替换，按创作流程重新登记与重渲。", affectedPaths });
        } else {
          const hash = await sha256File(path.join(workspaceDir, file));
          if (hash !== asset.sha256) {
            add({ key: changedKey, category: "asset_changed", disposition: "action", priority: used ? "high" : "normal",
              evidence: `${file} 指纹由 ${asset.sha256.slice(0, 12)} 变为 ${hash.slice(0, 12)}；原登记 ${asset.bytes} 字节，现 ${info.size} 字节`,
              impact: deps.length ? `依赖产物：${deps.join(", ")}` : "登记内容与磁盘内容不一致",
              nextAction: "确认修改来源，恢复原文件或重新登记并检查依赖产物。", affectedPaths });
          }
        }
      } catch (error) { question(`asset:${asset.id}`, `${file} 核对失败：${errorText(error)}`, [file]); }
    }
  }

  const affectedAssetIds = new Set([...paths].flatMap((file) => assetByPath.get(file)?.id ? [assetByPath.get(file)!.id] : []));
  const projects = [...new Set([...paths].filter((file) => file.startsWith("projects/") && /\.(mmp|kdenlive)$/i.test(file)).concat(
    artifacts.filter((a) => /^(lmms|kdenlive)_project$/.test(a.kind) && a.basedOn.some((id) => affectedAssetIds.has(id))).map((a) => normalize(a.path)),
  ))];
  for (const file of projects) {
    const artifact = artifactByPath.get(file);
    const object = artifact?.id ?? file;
    const projectChanged = key("project_changed", object);
    const refMissing = key("reference_missing", object);
    const projectInvalid = key("project_invalid", object);
    checked.add(projectChanged); checked.add(refMissing); checked.add(projectInvalid); checked.add(key("analysis_error", `project:${object}`));
    try {
      const absolute = path.join(workspaceDir, file);
      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) {
        if (artifact) add({ key: projectInvalid, category: "project_invalid", disposition: "action", priority: "high",
          evidence: `已登记工程缺失：${file}`, impact: `工程 ${object} 无法打开或重新渲染`, nextAction: "找回工程副本或按恢复流程重建。", affectedPaths: [file] });
        continue;
      }
      const xml = await readBoundedText(absolute, MAX_PROJECT_BYTES);
      const doc = new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(xml, "application/xml");
      const expectedRoot = file.endsWith(".kdenlive") ? "mlt" : "lmms-project";
      if (doc.documentElement?.tagName !== expectedRoot) throw new Error(`工程根节点应为 ${expectedRoot}`);
      const refs = await checkProjectReferences(absolute);
      const failures = refs.filter((item) => item.status === "fail");
      if (failures.length) add({ key: refMissing, category: "reference_missing", disposition: "action", priority: "high",
        evidence: failures.map((item) => item.evidence).join("；"), impact: `工程 ${object} 的本地素材引用失效`,
        nextAction: "恢复引用目标，或在工程中重新链接素材并保存副本。", affectedPaths: [file] });
      const hash = await sha256File(absolute);
      if (!artifact || hash !== artifact.sha256) add({ key: projectChanged, category: "project_changed", disposition: "record", priority: "normal",
        evidence: `${file} 已保存；${artifact ? `登记指纹 ${artifact.sha256.slice(0, 12)}，当前 ${hash.slice(0, 12)}` : "尚未登记为产物"}`,
        impact: artifact ? `工程 ${object} 内容与登记版本不同` : "新增工程尚未关联到工作区产物",
        nextAction: "打开工程副本复核，确认后按现有创作流程登记或重渲。", affectedPaths: [file] });
    } catch (error) {
      add({ key: projectInvalid, category: "project_invalid", disposition: "question", priority: "normal",
        evidence: `${file} 无法解析或核对：${errorText(error)}`, impact: `工程 ${object} 状态不确定`,
        nextAction: "用对应软件打开副本检查并保存有效工程。", affectedPaths: [file] });
    }
  }

  for (const file of paths) {
    if (!file.startsWith("outputs/")) continue;
    const artifact = artifactByPath.get(file);
    if (!artifact) continue;
    const artifactKey = key("artifact_changed", artifact.id);
    checked.add(artifactKey); checked.add(key("analysis_error", `artifact:${artifact.id}`));
    try {
      const info = await stat(path.join(workspaceDir, file)).catch(() => null);
      const hash = info?.isFile() ? await sha256File(path.join(workspaceDir, file)) : undefined;
      if (!hash || hash !== artifact.sha256) {
        const report = await reportFails(workspaceDir, artifact, state);
        add({ key: artifactKey, category: "artifact_changed", disposition: "action", priority: !hash ? "high" : "normal",
          evidence: !hash ? `${file} 缺失` : `${file} 指纹变化：${artifact.sha256.slice(0, 12)} → ${hash.slice(0, 12)}${report ? `；最新报告 ${report.file}: ${report.evidence}` : ""}`,
          impact: `登记产物 ${artifact.id} 与磁盘内容不一致`, nextAction: "核对来源；必要时重新渲染并主动执行 verify。", affectedPaths: [file, ...(report ? [report.file] : [])] });
      }
    } catch (error) { question(`artifact:${artifact.id}`, `${file} 核对失败：${errorText(error)}`, [file]); }
  }

  const evidenceFiles = [...paths].filter((file) => /^evidence\/(lmms|kdenlive)-render-.*\.json$/.test(file));
  for (const file of evidenceFiles) {
    const renderKey = key("render_failed", file);
    checked.add(renderKey); checked.add(key("analysis_error", `render:${file}`));
    if (!snapshot.files[file]) continue;
    try {
      const run = JSON.parse(await readBoundedText(path.join(workspaceDir, file), MAX_EVIDENCE_BYTES)) as Record<string, unknown>;
      if (!Array.isArray(run.args) || !run.args.every((arg) => typeof arg === "string") ||
          !(typeof run.exitCode === "number" || run.exitCode === null) || typeof run.timedOut !== "boolean") {
        throw new Error("渲染运行证据结构无效");
      }
      const output = renderOutput(workspaceDir, file, run.args as string[]);
      const outputInfo = output ? await stat(output).catch(() => null) : null;
      if (run.exitCode !== 0 || run.timedOut || !outputInfo?.isFile() || outputInfo.size === 0) {
        add({ key: renderKey, category: "render_failed", disposition: "action", priority: "high",
          evidence: `${file}：退出码 ${run.exitCode}${run.timedOut ? "，超时" : ""}；输出 ${output ? (outputInfo?.isFile() ? `${outputInfo.size} 字节` : "缺失") : "路径不明"}；${String(run.stderr ?? "").slice(-300)}`,
          impact: "对应渲染未产出可用文件", nextAction: "查看运行证据，修复工程或环境后手动重渲。",
          affectedPaths: [file, ...(output ? [normalize(path.relative(workspaceDir, output))] : [])] });
      }
    } catch (error) { question(`render:${file}`, `${file} 核对失败：${errorText(error)}`, [file]); }
  }

  const handoffKey = key("handoff_missing", "handoff.md");
  checked.add(handoffKey);
  if (!(await stat(path.join(workspaceDir, "handoff.md")).catch(() => null))?.isFile()) {
    add({ key: handoffKey, category: "handoff_missing", disposition: "action", priority: "normal",
      evidence: "handoff.md 缺失", impact: "创作者无法从交接文件查看当前建议", nextAction: "按工作区授权重建 handoff，或手动运行现有状态命令。", affectedPaths: ["handoff.md"] });
  }

  if (initial || stateChanged || [...paths].some((file) => /^(assets|projects|outputs|evidence)\//.test(file))) {
    for (const phase of ["assets", "score_draft", "score_review", "video_draft", "video_review", "final_verify", "done"] as const) {
      checked.add(key("stage_blocked", phase));
      checked.add(key("analysis_error", `stage:${phase}`));
    }
    if (state.phase !== "done") {
      try {
        const reasons: string[] = [];
        const affected = new Set<string>(["state.json"]);
        const requiredAssetIds = state.phase.startsWith("video") || state.phase === "final_verify"
          ? new Set(state.editPlan?.clips.map((clip) => clip.assetId) ?? [])
          : new Set(state.assets.map((asset) => asset.id));
        for (const asset of state.assets.filter((item) => requiredAssetIds.has(item.id))) {
          const file = normalize(asset.localPath);
          if (!(await stat(path.join(workspaceDir, file)).catch(() => null))?.isFile()) {
            reasons.push(`必需素材 ${asset.id} 缺失`); affected.add(file);
          }
        }
        for (const artifact of stageArtifacts(state, artifacts)) {
          const file = normalize(artifact.path);
          if (!(await stat(path.join(workspaceDir, file)).catch(() => null))?.isFile()) {
            reasons.push(`当前产物 ${artifact.id} 缺失`); affected.add(file);
          }
          const report = await reportFails(workspaceDir, artifact, state);
          if (report) { reasons.push(`${artifact.id} 最新检查未豁免失败：${report.evidence}`); affected.add(report.file); }
        }
        // A submitted checkpoint awaiting human review is a healthy stage state.
        if (reasons.length) add({ key: key("stage_blocked", state.phase), category: "stage_blocked", disposition: "action", priority: "high",
          evidence: reasons.join("；"), impact: `当前 ${state.phase} 阶段机器条件无法推进`,
          nextAction: "恢复必需资源，修复并重验；若检查项确需接受，用 waive 记录原因。", affectedPaths: [...affected] });
      } catch (error) { question(`stage:${state.phase}`, `阶段必要核对失败：${errorText(error)}`, ["state.json"]); }
    }
  }

  return { findings: [...findings.values()], checkedKeys: [...checked] };
}

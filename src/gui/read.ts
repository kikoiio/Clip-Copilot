/**
 * GUI 看板只读层（spec F1/F2/F4 展示；plan.md 的 read.ts 模块）。
 * 只读取工作区文件与领域存储，绝不写状态、工程或产物；
 * 深度检查摘要复用 CLI `status` 的同一套口径（latestReportsSync + 豁免 + 计数）。
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waiversOf, type CheckResult, type Phase, type WorkspaceState } from "../domain.ts";
import { loadMonitorState } from "../monitor/store.ts";
import type { MonitorMetrics, SuggestionRecord } from "../monitor/types.ts";
import type { WorkspaceSoftwareState } from "../sense/types.ts";
import { assessCapability, getEditorCapabilities } from "../editor/capabilities.ts";
import type { EditorHealth, MappingNote, ResolveWorkspaceContext } from "../editor/contracts.ts";
import { applyWaivers } from "../verification/deep.ts";
import { latestReportsSync, summarize, type DeepCheckReport } from "../verification/report.ts";
import { WorkspaceError, loadState, stateExists } from "../workspace/store.ts";

export interface DeepCheckSummary {
  pass: number;
  warn: number;
  fail: number;
  needsHuman: number;
}

export interface WorkspaceStateSummary {
  phase: Phase;
  revision: number;
  updatedAt: string;
  goal: {
    title: string;
    theme: string;
    width: number;
    height: number;
    fps: number;
    minFrames: number;
    maxFrames: number;
  };
  counts: { assets: number; artifacts: number; checkpoints: number };
  /** 无任何检查报告时为 null（与 CLI status 不打印深度检查行一致）。 */
  deepCheck: DeepCheckSummary | null;
  nextAction: string;
}

export interface WorkspaceSummary {
  dir: string;
  name: string;
  state?: WorkspaceStateSummary;
}

export interface ArtifactView {
  id: string;
  kind: string;
  /** 相对工作区路径。 */
  path: string;
  /** 绝对路径（供主进程定位文件/目录）。 */
  absolutePath: string;
  sha256: string;
  status: "draft" | "confirmed";
  createdAt: string;
  bytes: number | null;
  onDisk: boolean;
}

export interface CheckpointView {
  id: string;
  phase: string;
  createdAt: string;
  summary: string;
  nextAction: string;
  review: "pending" | "approved" | "changes_requested";
  feedback?: string;
  manifest: {
    artifacts: { id: string; kind: string; file: string; sha256: string }[];
    reports?: { file: string; sha256: string }[];
  } | null;
}

export interface ReportView {
  checkedAt: string;
  targetArtifactId: string | null;
  targetFile: string;
  targetKind: string;
  summary: DeepCheckSummary;
  results: CheckResult[];
}

export interface WorkspaceDetail extends WorkspaceSummary {
  state: WorkspaceStateSummary;
  artifacts: ArtifactView[];
  checkpoints: CheckpointView[];
  suggestions: SuggestionRecord[];
  metrics: MonitorMetrics | null;
  reports: ReportView[];
  /** handoff.md 原文；缺失时为 null。 */
  handoff: string | null;
  /** 软件感知状态（阶段 5 F1/F3/F4）；感知未启用时为 null 并由界面标注。 */
  software: WorkspaceSoftwareState | null;
  resolve: ResolveContextView | null;
}

export interface ResolveContextView {
  health: EditorHealth;
  runtime: ResolveWorkspaceContext["runtime"] | null;
  identity: ResolveWorkspaceContext["identity"];
  lastReadAt: string | null;
  snapshot: null | {
    fingerprint: string;
    capturedAt: string;
    counts: { tracks: number; clips: number; markers: number; subtitles: number; media: number };
    mappingNotes: MappingNote[];
  };
  staleReason: string | null;
  capabilities: { id: string; stage: string; support: string; available: boolean; reason: string | null }[];
}

/** 仓库根目录（包含 package.json 的最近祖先），与 coordinator 的定位规则一致。 */
function findRepoRoot(start: string): string {
  let current = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return start;
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

export function defaultWorkspacesRoot(): string {
  return path.join(REPO_ROOT, "workspaces");
}

function toStateSummary(dir: string, state: WorkspaceState): WorkspaceStateSummary {
  return {
    phase: state.phase,
    revision: state.revision,
    updatedAt: state.updatedAt,
    goal: {
      title: state.goal.title,
      theme: state.goal.theme,
      width: state.goal.outputSpec.width,
      height: state.goal.outputSpec.height,
      fps: state.goal.outputSpec.fps,
      minFrames: state.goal.minFrames,
      maxFrames: state.goal.maxFrames,
    },
    counts: {
      assets: state.assets.length,
      artifacts: state.artifacts.length,
      checkpoints: state.checkpoints.length,
    },
    deepCheck: collectDeepCheckSummary(dir, state),
    nextAction: state.nextAction,
  };
}

function toResolveContextView(context: ResolveWorkspaceContext | undefined): ResolveContextView | null {
  if (!context) return null;
  const health = context.health;
  const snapshot = context.latestSnapshot;
  const prerequisites = ["resolve_adapter_available", "mapping_rules_known"];
  if (health.state === "online") prerequisites.push("resolve_connected");
  if (context.identity?.projectId || context.identity?.projectName) prerequisites.push("active_project");
  if (context.identity?.timelineId || context.identity?.timelineName) prerequisites.push("active_timeline");
  if (snapshot) prerequisites.push("snapshot_available");
  if (context.runtime?.compatibility === "supported") prerequisites.push("supported_resolve_version_selected");
  if (context.runtime?.edition === "free") prerequisites.push("edition_requirements_confirmed");
  const capabilities = getEditorCapabilities().map((capability) => {
    const availability = assessCapability(capability.id, health, prerequisites);
    return {
      id: capability.id,
      stage: capability.stage,
      support: capability.support,
      available: availability.available,
      reason: availability.available ? null : availability.message,
    };
  });
  return {
    health,
    runtime: context.runtime ?? null,
    identity: context.identity,
    lastReadAt: snapshot?.capturedAt ?? null,
    snapshot: snapshot ? {
      fingerprint: snapshot.fingerprint,
      capturedAt: snapshot.capturedAt,
      counts: {
        tracks: snapshot.tracks.length,
        clips: snapshot.clips.length,
        markers: snapshot.markers.length,
        subtitles: snapshot.subtitles.length,
        media: snapshot.media.length,
      },
      mappingNotes: snapshot.mappingNotes,
    } : null,
    staleReason: health.state === "online" ? null : health.reason ?? "最近一次时间线快照可能已过期",
    capabilities,
  };
}

/** 与 CLI status 的 collectCheckSummarySync 同口径：最新报告 + 豁免 + 计数。 */
function collectDeepCheckSummary(dir: string, state: WorkspaceState): DeepCheckSummary | null {
  const reports = latestReportsSync(path.join(dir, "evidence"));
  if (reports.length === 0) return null;
  const waivers = waiversOf(state);
  const totals = { pass: 0, warn: 0, fail: 0, needsHuman: 0 };
  for (const report of reports) {
    const counted = summarize(applyWaivers(report.results, waivers, report.targetArtifactId));
    totals.pass += counted.pass;
    totals.warn += counted.warn;
    totals.fail += counted.fail;
    totals.needsHuman += counted.needsHuman;
  }
  return totals;
}

/** 列出根目录下全部已初始化的工作区（跳过隐藏目录与未建区目录）。 */
export async function listWorkspaces(rootDir: string = defaultWorkspacesRoot()): Promise<WorkspaceSummary[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const summaries: WorkspaceSummary[] = [];
  for (const name of names) {
    const dir = path.join(rootDir, name);
    if (!(await stateExists(dir))) continue;
    const loaded = await loadState(dir);
    summaries.push({ dir, name, state: toStateSummary(dir, loaded.state) });
  }
  return summaries;
}

async function toArtifactView(dir: string, record: WorkspaceState["artifacts"][number]): Promise<ArtifactView> {
  const absolutePath = path.resolve(dir, record.path);
  const info = await stat(absolutePath).catch(() => null);
  return {
    id: record.id,
    kind: record.kind,
    path: record.path,
    absolutePath,
    sha256: record.sha256,
    status: record.status,
    createdAt: record.createdAt,
    bytes: info?.size ?? null,
    onDisk: info?.isFile() ?? false,
  };
}

interface CheckpointManifestShape {
  artifacts?: { id: string; kind: string; file: string; sha256: string }[];
  reports?: { file: string; sha256: string }[];
}

async function toCheckpointView(
  dir: string,
  record: WorkspaceState["checkpoints"][number],
): Promise<CheckpointView> {
  const manifestFile = path.join(dir, "checkpoints", record.id, "manifest.json");
  let manifest: CheckpointManifestShape | null = null;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8")) as CheckpointManifestShape;
  } catch {
    // manifest 缺失或损坏时按 null 展示，不让单个检查点阻塞整个看板。
    manifest = null;
  }
  return {
    id: record.id,
    phase: record.phase,
    createdAt: record.createdAt,
    summary: record.summary,
    nextAction: record.nextAction,
    review: record.review,
    ...(record.feedback !== undefined ? { feedback: record.feedback } : {}),
    manifest: manifest
      ? { artifacts: manifest.artifacts ?? [], ...(manifest.reports ? { reports: manifest.reports } : {}) }
      : null,
  };
}

function toReportView(report: DeepCheckReport): ReportView {
  return {
    checkedAt: report.checkedAt,
    targetArtifactId: report.targetArtifactId ?? null,
    targetFile: report.targetFile,
    targetKind: report.targetKind,
    summary: report.summary,
    results: report.results,
  };
}

/** 组装单个工作区的完整看板数据；目录未初始化时抛 WorkspaceError。 */
export async function getWorkspaceDetail(
  dir: string,
  software: WorkspaceSoftwareState | null = null,
): Promise<WorkspaceDetail> {
  if (!(await stateExists(dir))) {
    throw new WorkspaceError(`工作区 ${dir} 还没有初始化（先运行 init）`);
  }
  const { state } = await loadState(dir);
  const artifacts = await Promise.all(state.artifacts.map((record) => toArtifactView(dir, record)));
  const checkpoints = await Promise.all(state.checkpoints.map((record) => toCheckpointView(dir, record)));
  const reports = latestReportsSync(path.join(dir, "evidence")).map(toReportView);
  const monitor = await loadMonitorState(dir).catch(() => null);
  const handoff = await readFile(path.join(dir, "handoff.md"), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  return {
    dir,
    name: path.basename(dir),
    state: toStateSummary(dir, state),
    artifacts,
    checkpoints,
    suggestions: monitor?.suggestions ?? [],
    metrics: monitor?.metrics ?? null,
    reports,
    handoff,
    software,
    resolve: toResolveContextView(state.editorContext),
  };
}

/** 供 AI 工具与提示词使用的轻量快照（详情子集，免确认即读）。 */
export type { DeepCheckReport };

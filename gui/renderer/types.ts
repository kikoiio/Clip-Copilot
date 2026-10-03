/** 与主进程（src/gui/*）对齐的视图类型镜像；字段改动需同步两侧。 */

export type Phase =
  | "assets"
  | "score_draft"
  | "score_review"
  | "video_draft"
  | "video_review"
  | "final_verify"
  | "done";

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
  path: string;
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
  results: CheckResultView[];
}

export interface CheckResultView {
  id: string;
  status: string;
  evidence: string;
}

export interface SuggestionView {
  key: string;
  id: string;
  category: string;
  disposition: string;
  priority: "high" | "normal" | "info";
  evidence: string;
  impact: string;
  nextAction: string;
  affectedPaths: string[];
  episode: number;
  status: "open" | "acknowledged" | "ignored" | "resolved";
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface MonitorMetricsView {
  notificationAttempts: number;
  notificationSent: number;
  notificationFailed: number;
  duplicateNotificationsSuppressed: number;
  acknowledged: number;
  ignored: number;
  resolved: number;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  state: WorkspaceStateSummary;
  artifacts: ArtifactView[];
  checkpoints: CheckpointView[];
  suggestions: SuggestionView[];
  metrics: MonitorMetricsView | null;
  reports: ReportView[];
  handoff: string | null;
  software: WorkspaceSoftwareState | null;
}

export interface WorkspaceSoftwareState {
  workspaceDir: string;
  running: boolean;
  instances: { pid: number; projectBasename: string; projectPath: string | null; dirty: boolean | null; focused: boolean | null }[];
  unsavedSignal: boolean | null;
  unsavedSource: "title" | "autosave" | null;
  degraded: string[];
  observedAt: string;
}

export interface MonitorHostEntry {
  dir: string;
  running: boolean;
  error?: string;
}

export interface MonitorUpdate {
  dir: string;
  suggestions: SuggestionView[];
  metrics: MonitorMetricsView | null;
  error?: string;
}

export type WriteActionKind =
  | "render"
  | "verify"
  | "checkpoint"
  | "review"
  | "waive"
  | "observe"
  | "reopen"
  | "monitor_config"
  | "monitor_decide"
  | "software_open";

export interface WriteActionSpec {
  kind: WriteActionKind;
  label: string;
  argv: string[];
  effectHint: string;
  force?: boolean;
}

export interface ActionResult {
  ok: boolean;
  exitCode: number;
  lines: string[];
  error?: string;
  blockedBy?: "software-in-use";
  instances?: { pid: number; projectBasename: string; projectPath: string | null }[];
}

export type AiRole = "user" | "assistant" | "tool";

export interface AiStoredMessage {
  role: AiRole;
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  at: string;
}

export type AiEvent =
  | { type: "token"; dir: string; text: string }
  | { type: "assistantMessage"; dir: string; message: AiStoredMessage }
  | { type: "confirmation"; dir: string; confirmationId: string; action: WriteActionSpec }
  | { type: "toolResult"; dir: string; toolName: string; ok: boolean; summary: string }
  | { type: "error"; dir: string; message: string }
  | { type: "done"; dir: string };

export type ProviderPresetId = "zhipu" | "openai" | "anthropic" | "ollama" | "custom";

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  needsApiKey: boolean;
  protocol: string;
}

export interface ProviderSetting {
  id: string;
  preset: ProviderPresetId;
  baseUrl: string;
  model: string;
}

export interface Settings {
  providers: ProviderSetting[];
  activeProviderId: string | null;
}

export interface SaveProviderInput {
  id?: string;
  preset: ProviderPresetId;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

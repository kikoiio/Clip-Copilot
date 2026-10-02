/** Stage 4 monitor data is separate from the creative workspace state. */
export type MonitorScope = "assets" | "projects" | "outputs" | "evidence" | "state";
export type NotificationLevel = "silent" | "important" | "all";
export type Disposition = "action" | "question" | "record";
export type SuggestionStatus = "open" | "acknowledged" | "ignored" | "resolved";
export type Priority = "high" | "normal" | "info";
export type FindingCategory =
  | "asset_added"
  | "asset_missing"
  | "asset_changed"
  | "project_changed"
  | "reference_missing"
  | "project_invalid"
  | "artifact_changed"
  | "render_failed"
  | "stage_blocked"
  | "handoff_missing"
  | "analysis_error";

export interface MonitorConfig {
  scopes: MonitorScope[];
  notificationLevel: NotificationLevel;
  autoRepairHandoff: boolean;
}

export interface FileStamp {
  size: number;
  mtimeMs: number;
  sha256?: string;
}

export interface WorkspaceSnapshot {
  scannedAt: string;
  stateRevision: number;
  files: Record<string, FileStamp>;
}

export interface FileChange {
  path: string;
  kind: "added" | "removed" | "modified";
  before?: FileStamp;
  after?: FileStamp;
}

export interface Finding {
  key: string;
  category: FindingCategory;
  disposition: Disposition;
  priority: Priority;
  evidence: string;
  impact: string;
  nextAction: string;
  affectedPaths: string[];
}

export interface AnalysisResult {
  findings: Finding[];
  checkedKeys: string[];
}

export interface SuggestionRecord extends Finding {
  id: string;
  episode: number;
  status: SuggestionStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  notificationAttemptedAt?: string;
  notificationResult?: "sent" | "failed";
  notificationError?: string;
}

export interface MonitorMetrics {
  notificationAttempts: number;
  notificationSent: number;
  notificationFailed: number;
  duplicateNotificationsSuppressed: number;
  acknowledged: number;
  ignored: number;
  resolved: number;
}

export interface RepairRecord {
  at: string;
  action: "rebuild-handoff";
  authorized: boolean;
  result: "verified" | "failed";
  evidence: string;
}

export interface MonitorState {
  schemaVersion: 1;
  revision: number;
  config: MonitorConfig;
  baseline?: WorkspaceSnapshot;
  suggestions: SuggestionRecord[];
  metrics: MonitorMetrics;
  repairs: RepairRecord[];
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  scopes: ["assets", "projects", "outputs", "evidence", "state"],
  notificationLevel: "important",
  autoRepairHandoff: false,
};

export function emptyMonitorState(): MonitorState {
  return {
    schemaVersion: 1,
    revision: 0,
    config: { ...DEFAULT_MONITOR_CONFIG, scopes: [...DEFAULT_MONITOR_CONFIG.scopes] },
    suggestions: [],
    metrics: {
      notificationAttempts: 0,
      notificationSent: 0,
      notificationFailed: 0,
      duplicateNotificationsSuppressed: 0,
      acknowledged: 0,
      ignored: 0,
      resolved: 0,
    },
    repairs: [],
  };
}

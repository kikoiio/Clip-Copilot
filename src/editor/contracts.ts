export type CapabilityStage = "read" | "edit" | "render" | "verify";

export type CapabilitySupport =
  | "supported"
  | "conditional"
  | "unsupported"
  | "unevaluated";

export type ProjectEffect = "read_only" | "mutates_project" | "creates_output";

export type ApprovalRequirement = "none" | "required" | "separate";

export type ResolveEdition = "free" | "studio" | "unknown";

export type ResolveCompatibility = "supported" | "unsupported" | "unknown";

/** Runtime provenance returned by the Resolve read-only probe. */
export interface ResolveRuntimeInfo {
  version: string;
  build: string;
  edition: ResolveEdition;
  platform: "linux-x64";
  compatibility: ResolveCompatibility;
  checkedAt: string;
}

export interface EditorCapability {
  id: string;
  stage: CapabilityStage;
  support: CapabilitySupport;
  prerequisites: string[];
  effect: ProjectEffect;
  approval: ApprovalRequirement;
  timeoutMs?: number;
  idempotent?: boolean;
  degradation: string;
}

export interface EditorHealth {
  state: "online" | "offline" | "unknown";
  checkedAt: string;
  version?: string;
  edition?: "free" | "studio" | "unknown";
  reason?: string;
}

export interface ProjectIdentity {
  projectId: string | null;
  databaseId: string | null;
  projectName: string;
  timelineId: string | null;
  timelineName: string | null;
}

export interface RationalTimeBase {
  numerator: number;
  denominator: number;
}

export interface TrackSnapshot {
  id: string;
  index: number;
  kind: "video" | "audio" | "subtitle" | "unknown";
  name: string;
}

export interface ClipSnapshot {
  id: string;
  trackId: string;
  mediaId: string | null;
  sourceInFrame: number;
  sourceOutFrame: number;
  timelineStartFrame: number;
  durationFrames: number;
  rawTimecode?: string;
}

export interface MarkerSnapshot {
  id: string;
  timelineFrame: number;
  name: string;
  note?: string;
}

export interface SubtitleSnapshot {
  id: string;
  startFrame: number;
  endFrame: number;
  text: string;
  trackId?: string;
}

export interface MediaReference {
  id: string;
  location: string | null;
  durationFrames: number | null;
  availability: "online" | "missing" | "unknown";
}

export interface MappingNote {
  sourceField: string;
  reason: string;
}

export interface TimelineSnapshot {
  identity: ProjectIdentity;
  timeBase: RationalTimeBase;
  width: number | null;
  height: number | null;
  tracks: TrackSnapshot[];
  clips: ClipSnapshot[];
  markers: MarkerSnapshot[];
  subtitles: SubtitleSnapshot[];
  media: MediaReference[];
  capturedAt: string;
  fingerprint: string;
  mappingNotes: MappingNote[];
}

export interface ResolveWorkspaceContext {
  kind: "resolve";
  identity: ProjectIdentity | null;
  latestSnapshot: TimelineSnapshot | null;
  /** Source build and edition for the latest health/snapshot observation. */
  runtime?: ResolveRuntimeInfo;
  health: EditorHealth;
}

export interface AdapterCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type AdapterErrorKind = "offline" | "unsupported" | "protocol" | "timeout";

export type AdapterResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        capabilityId: string;
        kind: AdapterErrorKind;
        reason: string;
        retryable: boolean;
      };
    };

export interface EditorAdapter {
  readonly editorKind: "resolve";
  getHealth(options: AdapterCallOptions): Promise<EditorHealth>;
  /** Optional runtime provenance used by Resolve workspace persistence. */
  getRuntimeInfo?(): ResolveRuntimeInfo | undefined;
  getCapabilities(): readonly EditorCapability[];
  readProjectSnapshot(
    options: AdapterCallOptions,
  ): Promise<AdapterResult<TimelineSnapshot>>;
}

/**
 * 核心类型与阶段约束。对应 plan.md 的「核心数据结构与接口」。
 * 时间约定：视频用 30 帧/秒整数帧；音乐用节拍与小节（1 小节 = 4 拍）。
 */

export const SCHEMA_VERSION = 1;

export const FPS = 30;
export const MIN_FRAMES = 900;
export const MAX_FRAMES = 1800;
/** 配乐与视频允许的最大时长差（毫秒）。 */
export const AV_TOLERANCE_MS = 1000;
/** 素材下载总量默认上限：2 GB。 */
export const MAX_TOTAL_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

export type Phase =
  | "assets"
  | "score_draft"
  | "score_review"
  | "video_draft"
  | "video_review"
  | "final_verify"
  | "done";

/** 只允许的阶段迁移；其余一律拒绝。 */
export const PHASE_TRANSITIONS: Record<Phase, Phase[]> = {
  assets: ["score_draft"],
  score_draft: ["score_review"],
  score_review: ["video_draft", "score_draft"],
  video_draft: ["video_review"],
  video_review: ["final_verify", "video_draft"],
  final_verify: ["done"],
  done: [],
};

export function canTransition(from: Phase, to: Phase): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

export interface AssetRecord {
  id: string;
  sourceUrl: string;
  licenseUrl: string;
  licenseCheckedAt: string;
  /** 相对工作区目录的本地路径。 */
  localPath: string;
  sha256: string;
  bytes: number;
  media: MediaInfo;
}

export interface MediaInfo {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface NoteEvent {
  trackId: string;
  pitchMidi: number;
  startBeat: number;
  durationBeats: number;
  /** 0–127。 */
  velocity: number;
}

export interface ScoreSection {
  name: string;
  startBar: number;
  bars: number;
  /** 0（稀疏）–2（增强），用于证据描述，不影响渲染。 */
  energy: number;
}

export interface ScorePlan {
  bpm: number;
  beatsPerBar: 4;
  sections: ScoreSection[];
  tracks: { id: string; instrumentTemplate: string; notes: NoteEvent[] }[];
}

export interface EditPlanClip {
  assetId: string;
  /** 原始素材内的入点（毫秒）。 */
  sourceInMs: number;
  timelineStartFrame: number;
  durationFrames: number;
}

export interface EditPlan {
  profile: { width: number; height: number; fps: number };
  clips: EditPlanClip[];
  soundtrackArtifactId: string;
  fadeInFrames: number;
  fadeOutFrames: number;
}

export type ArtifactKind =
  | "lmms_project"
  | "audio_preview"
  | "audio_final"
  | "kdenlive_project"
  | "video_preview"
  | "video_final";

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  /** 相对工作区目录的路径。 */
  path: string;
  sha256: string;
  createdAt: string;
  /** 生成该产物所依据的素材或其他产物的 ID。 */
  basedOn: string[];
  status: "draft" | "confirmed";
}

export interface CheckpointRecord {
  id: string;
  phase: "score_review" | "video_review";
  createdAt: string;
  artifactIds: string[];
  summary: string;
  nextAction: string;
  review: "pending" | "approved" | "changes_requested";
  feedback?: string;
}

export interface DecisionRecord {
  at: string;
  subject: string;
  reason: string;
  effect: string;
}

export interface IssueRecord {
  at: string;
  kind: string;
  evidence: string;
  action: string;
  result: string;
}

export type CheckStatus = "pass" | "fail" | "needs_observation";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  evidence: string;
}

export interface WorkspaceState {
  schemaVersion: typeof SCHEMA_VERSION;
  revision: number;
  goal: { title: string; minFrames: number; maxFrames: number; fps: number };
  phase: Phase;
  assets: AssetRecord[];
  scorePlan?: ScorePlan;
  editPlan?: EditPlan;
  artifacts: ArtifactRecord[];
  checkpoints: CheckpointRecord[];
  decisions: DecisionRecord[];
  issues: IssueRecord[];
  nextAction: string;
  updatedAt: string;
}

/** 计划分片必须正好铺满 0..totalFrames，无空洞、无重叠。 */
export function validateClipLayout(
  clips: EditPlanClip[],
): { ok: true; totalFrames: number } | { ok: false; reason: string } {
  if (clips.length === 0) return { ok: false, reason: "剪辑计划没有任何片段" };
  let expected = 0;
  for (const clip of clips) {
    if (clip.durationFrames <= 0) {
      return { ok: false, reason: `片段 ${clip.assetId} 长度必须为正` };
    }
    if (clip.timelineStartFrame !== expected) {
      return {
        ok: false,
        reason: `时间线在 ${expected} 帧处出现空洞或重叠（片段从 ${clip.timelineStartFrame} 开始）`,
      };
    }
    expected += clip.durationFrames;
  }
  const total = expected;
  if (total < MIN_FRAMES || total > MAX_FRAMES) {
    return { ok: false, reason: `总长 ${total} 帧超出 ${MIN_FRAMES}–${MAX_FRAMES} 帧范围` };
  }
  return { ok: true, totalFrames: total };
}

/** 剪辑计划完整校验：引用、片源边界、时长、配乐对应。 */
export function validateEditPlan(
  plan: EditPlan,
  assets: AssetRecord[],
  artifacts: ArtifactRecord[],
  state: Pick<WorkspaceState, "goal">,
): string[] {
  const errors: string[] = [];
  if (plan.profile.width !== 1920 || plan.profile.height !== 1080 || plan.profile.fps !== FPS) {
    errors.push("剪辑计划规格必须是 1920×1080、30 帧/秒");
  }
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const clip of plan.clips) {
    const asset = byId.get(clip.assetId);
    if (!asset) {
      errors.push(`片段引用了不存在的素材 ${clip.assetId}`);
      continue;
    }
    const inMs = clip.sourceInMs;
    const outMs = inMs + (clip.durationFrames / FPS) * 1000;
    if (outMs > asset.media.durationMs + 1) {
      errors.push(
        `素材 ${clip.assetId} 的出点 ${Math.round(outMs)}ms 超出其时长 ${Math.round(asset.media.durationMs)}ms`,
      );
    }
    if (asset.media.width < plan.profile.width || asset.media.height < plan.profile.height) {
      errors.push(
        `素材 ${clip.assetId} 分辨率 ${asset.media.width}×${asset.media.height} 低于目标 ${plan.profile.width}×${plan.profile.height}`,
      );
    }
  }
  const layout = validateClipLayout(plan.clips);
  if (!layout.ok) errors.push(layout.reason);
  else if (layout.totalFrames < state.goal.minFrames || layout.totalFrames > state.goal.maxFrames) {
    errors.push(
      `总长 ${layout.totalFrames} 帧超出目标范围 ${state.goal.minFrames}–${state.goal.maxFrames}`,
    );
  }
  const soundtrack = artifacts.find((a) => a.id === plan.soundtrackArtifactId);
  if (!soundtrack) {
    errors.push(`配乐产物 ${plan.soundtrackArtifactId} 不存在`);
  } else if (soundtrack.status !== "confirmed") {
    errors.push(`配乐产物 ${plan.soundtrackArtifactId} 尚未确认，不能用于剪辑`);
  }
  return errors;
}

/** 配乐计划校验：小节连续、音符落在有效范围、目标时长。 */
export function validateScorePlan(plan: ScorePlan): string[] {
  const errors: string[] = [];
  if (plan.bpm <= 0 || plan.bpm > 300) errors.push("BPM 必须在 1–300 之间");
  if (plan.beatsPerBar !== 4) errors.push("第一轮固定 4/4 拍");
  let expected = 0;
  for (const section of plan.sections) {
    if (section.startBar !== expected) {
      errors.push(`分段 ${section.name} 应从小节 ${expected} 开始，实际 ${section.startBar}`);
    }
    if (section.bars <= 0) errors.push(`分段 ${section.name} 小节数必须为正`);
    expected += section.bars;
  }
  const trackIds = new Set(plan.tracks.map((t) => t.id));
  for (const track of plan.tracks) {
    for (const note of track.notes) {
      if (!trackIds.has(note.trackId)) {
        errors.push(`音符引用了不存在的轨道 ${note.trackId}`);
      }
      if (note.pitchMidi < 0 || note.pitchMidi > 119) {
        errors.push(`音符音高 ${note.pitchMidi} 超出 0–119`);
      }
      if (note.velocity < 1 || note.velocity > 127) {
        errors.push(`音符力度 ${note.velocity} 超出 1–127`);
      }
      if (note.durationBeats <= 0) errors.push("音符时值必须为正");
    }
  }
  return errors;
}

/** 配乐目标时长（毫秒）：小节 × 每小节 4 拍 × 每拍秒数。 */
export function scoreDurationMs(plan: ScorePlan): number {
  const bars = plan.sections.reduce((sum, s) => sum + s.bars, 0);
  return bars * plan.beatsPerBar * (60_000 / plan.bpm);
}

export function assetById(state: WorkspaceState, id: string): AssetRecord | undefined {
  return state.assets.find((a) => a.id === id);
}

export function artifactById(state: WorkspaceState, id: string): ArtifactRecord | undefined {
  return state.artifacts.find((a) => a.id === id);
}

/** 依据 basedOn 链判断产物是否依赖了已失效的素材或产物。 */
export function isArtifactStale(
  artifact: ArtifactRecord,
  invalidatedIds: ReadonlySet<string>,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (invalidatedIds.has(artifact.id)) return true;
  if (seen.has(artifact.id)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(artifact.id);
  return artifact.basedOn.some((dep) => {
    if (invalidatedIds.has(dep)) return true;
    return false;
  });
}

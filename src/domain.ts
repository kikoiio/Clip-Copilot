/**
 * 核心类型与阶段约束。对应 plan.md 的「核心数据结构与接口」。
 * 时间约定：视频用 30 帧/秒整数帧；音乐用节拍与小节（1 小节 = 4 拍）。
 */

export const SCHEMA_VERSION = 2;

/** 配乐与视频允许的最大时长差（毫秒）。 */
export const AV_TOLERANCE_MS = 1000;
/** 素材下载总量默认上限：2 GB。 */
export const MAX_TOTAL_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

/** 已验证的输出规格注册表：任务配置与剪辑计划只能从中取值。 */
export const VERIFIED_SPECS: readonly { width: number; height: number; fps: number }[] = [
  { width: 1920, height: 1080, fps: 30 },
];

export function isVerifiedSpec(spec: { width: number; height: number; fps: number }): boolean {
  return VERIFIED_SPECS.some(
    (s) => s.width === spec.width && s.height === spec.height && s.fps === spec.fps,
  );
}

/** 情绪走向节点：energy 沿用 ScoreSection 的 0–2 标度，走向由节点顺序体现。 */
export interface MoodNode {
  name: string;
  energy: number;
}

/** 作品目标：来自任务配置，是工作区状态的一等字段。 */
export interface Goal {
  title: string;
  theme: string;
  minFrames: number;
  maxFrames: number;
  outputSpec: { width: number; height: number; fps: number };
  /** 为空表示不做自动情绪校验（阶段 1 迁移来的旧工作区）。 */
  moodArc: MoodNode[];
}

/**
 * 阶段 1 的 v1 状态在读取时迁移为 v2：目标补齐 theme/outputSpec/moodArc。
 * 只在内存中生效，下次保存自然写出 v2；不是 v1 报文时返回 null。
 */
export function migrateStateV1(raw: unknown): WorkspaceState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) return null;
  const goal = candidate.goal as
    | { title?: unknown; minFrames?: unknown; maxFrames?: unknown; fps?: unknown }
    | undefined;
  if (
    !goal ||
    typeof goal.title !== "string" ||
    typeof goal.minFrames !== "number" ||
    typeof goal.maxFrames !== "number" ||
    typeof goal.fps !== "number"
  ) {
    throw new Error("v1 state.json 的 goal 字段不完整，无法迁移");
  }
  return {
    ...(candidate as unknown as WorkspaceState),
    schemaVersion: 2,
    goal: {
      title: goal.title,
      theme: "阶段 1 样板（配置化之前的数据）",
      minFrames: goal.minFrames,
      maxFrames: goal.maxFrames,
      outputSpec: { width: 1920, height: 1080, fps: goal.fps },
      moodArc: [],
    },
  };
}

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
  // done → video_draft 仅由显式的 reopen 命令使用（重开已交付版本）。
  done: ["video_draft"],
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

export type CheckStatus = "pass" | "fail" | "warn" | "needs_observation" | "needs_human";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  evidence: string;
  // 阶段 3 深度检查必须填写：判定阈值、实际命令与工具版本，保证结果可复现（N3）。
  threshold?: string;
  command?: string;
  tool?: string;
}

/** 对一条机器检查结论的显式豁免：记录原因后该检查项降级为 warn，不再阻塞。 */
export interface WaiverRecord {
  at: string;
  /** 被豁免的检查项 ID，如 "deep:video:black:unexpected"。 */
  checkId: string;
  /** 限定到产物；缺省表示该检查项在所有产物上豁免。 */
  artifactId?: string;
  reason: string;
}

/** 旧状态无 waivers 字段时按空处理（N1 兼容）。 */
export function waiversOf(state: WorkspaceState): WaiverRecord[] {
  return state.waivers ?? [];
}

/** 素材候选：来自任务配置，登记时用于核对来源。 */
export interface AssetCandidate {
  sourceUrl: string;
  licenseUrl: string;
  note?: string;
}

export interface WorkspaceState {
  schemaVersion: typeof SCHEMA_VERSION;
  revision: number;
  goal: Goal;
  /** 任务配置候选清单；v1 迁移的旧工作区没有此字段，视为不做候选核对。 */
  assetCandidates?: AssetCandidate[];
  taskConfigPath?: string;
  phase: Phase;
  assets: AssetRecord[];
  scorePlan?: ScorePlan;
  editPlan?: EditPlan;
  artifacts: ArtifactRecord[];
  checkpoints: CheckpointRecord[];
  decisions: DecisionRecord[];
  issues: IssueRecord[];
  /** 机器检查豁免记录；v2 早期状态无此字段，视为无豁免。 */
  waivers?: WaiverRecord[];
  nextAction: string;
  updatedAt: string;
}

/** 计划分片必须正好铺满 0..totalFrames，无空洞、无重叠；总长落在给定目标范围内。 */
export function validateClipLayout(
  clips: EditPlanClip[],
  minFrames: number,
  maxFrames: number,
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
  if (total < minFrames || total > maxFrames) {
    return { ok: false, reason: `总长 ${total} 帧超出目标范围 ${minFrames}–${maxFrames} 帧` };
  }
  return { ok: true, totalFrames: total };
}

/** 剪辑计划完整校验：规格等于目标规格、引用、片源边界、时长范围、配乐对应。 */
export function validateEditPlan(
  plan: EditPlan,
  assets: AssetRecord[],
  artifacts: ArtifactRecord[],
  goal: Goal,
): string[] {
  const errors: string[] = [];
  if (
    plan.profile.width !== goal.outputSpec.width ||
    plan.profile.height !== goal.outputSpec.height ||
    plan.profile.fps !== goal.outputSpec.fps
  ) {
    errors.push(
      `剪辑计划规格 ${plan.profile.width}×${plan.profile.height}@${plan.profile.fps} 与目标规格 ${goal.outputSpec.width}×${goal.outputSpec.height}@${goal.outputSpec.fps} 不一致`,
    );
  }
  const fps = goal.outputSpec.fps;
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const clip of plan.clips) {
    const asset = byId.get(clip.assetId);
    if (!asset) {
      errors.push(`片段引用了不存在的素材 ${clip.assetId}`);
      continue;
    }
    const inMs = clip.sourceInMs;
    const outMs = inMs + (clip.durationFrames / fps) * 1000;
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
  const layout = validateClipLayout(plan.clips, goal.minFrames, goal.maxFrames);
  if (!layout.ok) errors.push(layout.reason);
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

/**
 * 配乐方案与作品目标的一致性校验（spec F4）：
 * ① 总时长换算后落在目标范围内（±1 小节容差）；
 * ② 段落按顺序覆盖 moodArc 每个节点（能量容差 0.5）；
 * moodArc 为空（阶段 1 迁移的旧工作区）时跳过情绪校验。
 */
export function validateScorePlanAgainstGoal(plan: ScorePlan, goal: Goal): string[] {
  const errors: string[] = [];
  const fps = goal.outputSpec.fps;
  const minMs = (goal.minFrames / fps) * 1000;
  const maxMs = (goal.maxFrames / fps) * 1000;
  const barMs = plan.beatsPerBar * (60_000 / plan.bpm);
  const duration = scoreDurationMs(plan);
  if (duration < minMs - barMs || duration > maxMs + barMs) {
    errors.push(
      `配乐总时长 ${(duration / 1000).toFixed(1)}s 超出目标范围 ${(minMs / 1000).toFixed(1)}–${(maxMs / 1000).toFixed(1)}s（±1 小节容差）`,
    );
  }
  if (goal.moodArc.length > 0) {
    let cursor = 0;
    for (const node of goal.moodArc) {
      let matched = -1;
      for (let i = cursor; i < plan.sections.length; i++) {
        const section = plan.sections[i];
        if (section && Math.abs(section.energy - node.energy) <= 0.5) {
          matched = i;
          break;
        }
      }
      if (matched === -1) {
        errors.push(
          `情绪走向节点「${node.name}」(energy ${node.energy}) 未被段落按顺序覆盖（能量容差 0.5）`,
        );
      } else {
        cursor = matched + 1;
      }
    }
  }
  return errors;
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

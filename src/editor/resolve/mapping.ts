import { createHash } from "node:crypto";
import type {
  ClipSnapshot,
  MappingNote,
  MarkerSnapshot,
  MediaReference,
  ProjectIdentity,
  RationalTimeBase,
  SubtitleSnapshot,
  TimelineSnapshot,
  TrackSnapshot,
} from "../contracts.ts";

/** The JSON shape returned by the Resolve summary protocol used in phase 0. */
export interface ResolveProjectSummaryResponse {
  project?: ResolveProjectSummaryProject;
  timeline?: ResolveProjectSummaryTimeline;
  media?: ResolveProjectSummaryMedia[];
  [field: string]: unknown;
}

export interface ResolveProjectSummaryProject {
  id?: unknown;
  name?: unknown;
  database?: {
    id?: unknown;
    name?: unknown;
    [field: string]: unknown;
  } | null;
  [field: string]: unknown;
}

export interface ResolveProjectSummaryTimeline {
  id?: unknown;
  name?: unknown;
  frameRate?: { numerator?: unknown; denominator?: unknown; [field: string]: unknown } | null;
  resolution?: { width?: unknown; height?: unknown; [field: string]: unknown } | null;
  videoTracks?: ResolveProjectSummaryTrack[] | null;
  audioTracks?: ResolveProjectSummaryTrack[] | null;
  markers?: ResolveProjectSummaryMarker[] | null;
  subtitles?: ResolveProjectSummarySubtitle[] | null;
  [field: string]: unknown;
}

export interface ResolveProjectSummaryTrack {
  id?: unknown;
  index?: unknown;
  name?: unknown;
  clips?: ResolveProjectSummaryClip[] | null;
  [field: string]: unknown;
}

export interface ResolveProjectSummaryClip {
  id?: unknown;
  mediaId?: unknown;
  sourceInFrame?: unknown;
  sourceOutFrame?: unknown;
  timelineStartFrame?: unknown;
  durationFrames?: unknown;
  rawTimecode?: unknown;
  timecode?: unknown;
  [field: string]: unknown;
}

export interface ResolveProjectSummaryMarker {
  id?: unknown;
  frame?: unknown;
  name?: unknown;
  note?: unknown;
  [field: string]: unknown;
}

export interface ResolveProjectSummarySubtitle {
  id?: unknown;
  startFrame?: unknown;
  endFrame?: unknown;
  text?: unknown;
  trackId?: unknown;
  [field: string]: unknown;
}

export interface ResolveProjectSummaryMedia {
  id?: unknown;
  location?: unknown;
  durationFrames?: unknown;
  availability?: unknown;
  [field: string]: unknown;
}

export interface MappingOptions {
  /** Supplying this makes complete snapshot equality deterministic in tests. */
  capturedAt?: string;
}

const PROJECT_FIELDS = new Set(["id", "name", "database"]);
const DATABASE_FIELDS = new Set(["id", "name"]);
const TIMELINE_FIELDS = new Set([
  "id", "name", "frameRate", "resolution", "videoTracks", "audioTracks", "markers", "subtitles",
]);
const RATE_FIELDS = new Set(["numerator", "denominator"]);
const RESOLUTION_FIELDS = new Set(["width", "height"]);
const TRACK_FIELDS = new Set(["id", "index", "name", "clips"]);
const CLIP_FIELDS = new Set(["id", "mediaId", "sourceInFrame", "sourceOutFrame", "timelineStartFrame", "durationFrames", "rawTimecode", "timecode"]);
const MARKER_FIELDS = new Set(["id", "frame", "name", "note"]);
const SUBTITLE_FIELDS = new Set(["id", "startFrame", "endFrame", "text", "trackId"]);
const MEDIA_FIELDS = new Set(["id", "location", "durationFrames", "availability"]);

/** Normalize one Resolve project summary into the editor-independent contract. */
export function mapResolveProjectSummary(
  raw: ResolveProjectSummaryResponse,
  options: MappingOptions = {},
): TimelineSnapshot {
  const notes: MappingNote[] = [];
  const root = isRecord(raw) ? raw : {};
  noteUnknownFields(root, new Set(["project", "timeline", "media"]), "", notes);

  const project = isRecord(root.project) ? root.project : {};
  const timeline = isRecord(root.timeline) ? root.timeline : {};
  if (!isRecord(root.project)) notes.push({ sourceField: "project", reason: "项目对象缺失，身份字段按未知处理" });
  if (!isRecord(root.timeline)) notes.push({ sourceField: "timeline", reason: "时间线对象缺失，返回空时间线摘要" });

  noteUnknownFields(project, PROJECT_FIELDS, "project", notes);
  if (project.database !== undefined && project.database !== null && isRecord(project.database)) {
    noteUnknownFields(project.database, DATABASE_FIELDS, "project.database", notes);
  } else if (project.database === undefined || project.database === null) {
    notes.push({ sourceField: "project.database", reason: "数据库身份缺失" });
  } else {
    notes.push({ sourceField: "project.database", reason: "数据库对象类型无效，身份字段按未知处理" });
  }
  noteUnknownFields(timeline, TIMELINE_FIELDS, "timeline", notes);
  if (isRecord(timeline.frameRate)) noteUnknownFields(timeline.frameRate, RATE_FIELDS, "timeline.frameRate", notes);
  if (isRecord(timeline.resolution)) noteUnknownFields(timeline.resolution, RESOLUTION_FIELDS, "timeline.resolution", notes);

  const identity: ProjectIdentity = {
    projectId: stringOrNull(project.id, "project.id", notes),
    databaseId: stringOrNull(isRecord(project.database) ? project.database.id : undefined, "project.database.id", notes),
    projectName: stringOrFallback(project.name, "project.name", "", notes),
    timelineId: stringOrNull(timeline.id, "timeline.id", notes),
    timelineName: stringOrNull(timeline.name, "timeline.name", notes),
  };

  const timeBase = mapTimeBase(timeline.frameRate, notes);
  const { width, height } = mapResolution(timeline.resolution, notes);
  const tracks: TrackSnapshot[] = [];
  const clips: ClipSnapshot[] = [];
  mapTracks(timeline.videoTracks, "video", tracks, clips, notes);
  mapTracks(timeline.audioTracks, "audio", tracks, clips, notes);
  const markers = mapMarkers(timeline.markers, notes);
  const subtitles = mapSubtitles(timeline.subtitles, notes);
  const media = mapMedia(root.media, notes);

  const semantic = { identity, timeBase, width, height, tracks, clips, markers, subtitles, media, mappingNotes: notes };
  const snapshot: TimelineSnapshot = {
    ...semantic,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    fingerprint: fingerprintFor(semantic),
  };
  return snapshot;
}

/** Aliases make the mapping boundary convenient for adapters and callers. */
export const normalizeResolveSummary = mapResolveProjectSummary;
export const mapResolveResponse = mapResolveProjectSummary;
export const mapResolveSummary = mapResolveProjectSummary;

function mapTimeBase(value: unknown, notes: MappingNote[]): RationalTimeBase {
  if (!isRecord(value)) {
    notes.push({ sourceField: "timeline.frameRate", reason: "帧率缺失，使用 1/1 作为占位基准" });
    return { numerator: 1, denominator: 1 };
  }
  const numerator = finiteInteger(value.numerator);
  const denominator = finiteInteger(value.denominator);
  if (numerator === null || numerator <= 0) notes.push({ sourceField: "timeline.frameRate.numerator", reason: "分子缺失或无效，使用 1" });
  if (denominator === null || denominator <= 0) notes.push({ sourceField: "timeline.frameRate.denominator", reason: "分母缺失或无效，使用 1" });
  return { numerator: numerator !== null && numerator > 0 ? numerator : 1, denominator: denominator !== null && denominator > 0 ? denominator : 1 };
}

function mapResolution(value: unknown, notes: MappingNote[]): { width: number | null; height: number | null } {
  if (!isRecord(value)) {
    notes.push({ sourceField: "timeline.resolution", reason: "分辨率缺失，无法映射" });
    return { width: null, height: null };
  }
  return { width: nullableInteger(value.width, "timeline.resolution.width", notes), height: nullableInteger(value.height, "timeline.resolution.height", notes) };
}

function mapTracks(
  values: unknown,
  kind: "video" | "audio",
  tracks: TrackSnapshot[],
  clips: ClipSnapshot[],
  notes: MappingNote[],
): void {
  if (!Array.isArray(values)) {
    notes.push({ sourceField: `timeline.${kind}Tracks`, reason: "轨道数组缺失，按空数组处理" });
    return;
  }
  values.forEach((rawTrack, trackPosition) => {
    if (!isRecord(rawTrack)) {
      notes.push({ sourceField: `timeline.${kind}Tracks[${trackPosition}]`, reason: "轨道对象无效，已跳过" });
      return;
    }
    const source = `timeline.${kind}Tracks[${trackPosition}]`;
    noteUnknownFields(rawTrack, TRACK_FIELDS, source, notes);
    const id = stringOrFallback(rawTrack.id, `${source}.id`, `${kind}-track-${trackPosition + 1}`, notes);
    const track: TrackSnapshot = {
      id,
      index: integerOrFallback(rawTrack.index, `${source}.index`, trackPosition + 1, notes),
      kind,
      name: stringOrFallback(rawTrack.name, `${source}.name`, `${kind} ${trackPosition + 1}`, notes),
    };
    tracks.push(track);
    if (!Array.isArray(rawTrack.clips)) {
      notes.push({ sourceField: `${source}.clips`, reason: "片段数组缺失，按空数组处理" });
      return;
    }
    rawTrack.clips.forEach((rawClip, clipPosition) => mapClip(rawClip, source, id, clipPosition, clips, notes));
  });
}

function mapClip(value: unknown, trackSource: string, trackId: string, position: number, clips: ClipSnapshot[], notes: MappingNote[]): void {
  if (!isRecord(value)) {
    notes.push({ sourceField: `${trackSource}.clips[${position}]`, reason: "片段对象无效，已跳过" });
    return;
  }
  const source = `${trackSource}.clips[${position}]`;
  noteUnknownFields(value, CLIP_FIELDS, source, notes);
  const rawTimecode = typeof value.rawTimecode === "string" ? value.rawTimecode : typeof value.timecode === "string" ? value.timecode : undefined;
  if (value.rawTimecode !== undefined && typeof value.rawTimecode !== "string") notes.push({ sourceField: `${source}.rawTimecode`, reason: "原始时间码类型无效，已丢弃" });
  clips.push({
    id: stringOrFallback(value.id, `${source}.id`, `${trackId}-clip-${position + 1}`, notes),
    trackId,
    mediaId: stringOrNull(value.mediaId, `${source}.mediaId`, notes),
    sourceInFrame: integerOrFallback(value.sourceInFrame, `${source}.sourceInFrame`, 0, notes),
    sourceOutFrame: integerOrFallback(value.sourceOutFrame, `${source}.sourceOutFrame`, 0, notes),
    timelineStartFrame: integerOrFallback(value.timelineStartFrame, `${source}.timelineStartFrame`, 0, notes),
    durationFrames: integerOrFallback(value.durationFrames, `${source}.durationFrames`, 0, notes),
    ...(rawTimecode === undefined ? {} : { rawTimecode }),
  });
}

function mapMarkers(values: unknown, notes: MappingNote[]): MarkerSnapshot[] {
  if (!Array.isArray(values)) {
    notes.push({ sourceField: "timeline.markers", reason: "标记数组缺失，按空数组处理" });
    return [];
  }
  return values.flatMap((value, position) => {
    if (!isRecord(value)) {
      notes.push({ sourceField: `timeline.markers[${position}]`, reason: "标记对象无效，已跳过" });
      return [];
    }
    const source = `timeline.markers[${position}]`;
    noteUnknownFields(value, MARKER_FIELDS, source, notes);
    return [{
      id: stringOrFallback(value.id, `${source}.id`, `marker-${position + 1}`, notes),
      timelineFrame: integerOrFallback(value.frame, `${source}.frame`, 0, notes),
      name: stringOrFallback(value.name, `${source}.name`, `Marker ${position + 1}`, notes),
      ...(value.note === undefined ? {} : { note: stringOrFallback(value.note, `${source}.note`, "", notes) }),
    }];
  });
}

function mapSubtitles(values: unknown, notes: MappingNote[]): SubtitleSnapshot[] {
  if (!Array.isArray(values)) {
    notes.push({ sourceField: "timeline.subtitles", reason: "字幕数组缺失，按空数组处理" });
    return [];
  }
  return values.flatMap((value, position) => {
    if (!isRecord(value)) {
      notes.push({ sourceField: `timeline.subtitles[${position}]`, reason: "字幕对象无效，已跳过" });
      return [];
    }
    const source = `timeline.subtitles[${position}]`;
    noteUnknownFields(value, SUBTITLE_FIELDS, source, notes);
    return [{
      id: stringOrFallback(value.id, `${source}.id`, `subtitle-${position + 1}`, notes),
      startFrame: integerOrFallback(value.startFrame, `${source}.startFrame`, 0, notes),
      endFrame: integerOrFallback(value.endFrame, `${source}.endFrame`, 0, notes),
      text: stringOrFallback(value.text, `${source}.text`, "", notes),
      ...(value.trackId === undefined ? {} : { trackId: stringOrFallback(value.trackId, `${source}.trackId`, "", notes) }),
    }];
  });
}

function mapMedia(values: unknown, notes: MappingNote[]): MediaReference[] {
  if (!Array.isArray(values)) {
    notes.push({ sourceField: "media", reason: "媒体引用数组缺失，按空数组处理" });
    return [];
  }
  return values.flatMap((value, position) => {
    if (!isRecord(value)) {
      notes.push({ sourceField: `media[${position}]`, reason: "媒体引用对象无效，已跳过" });
      return [];
    }
    const source = `media[${position}]`;
    noteUnknownFields(value, MEDIA_FIELDS, source, notes);
    const availability = value.availability === "online" || value.availability === "missing" || value.availability === "unknown" ? value.availability : "unknown";
    if (value.availability !== undefined && availability === "unknown" && value.availability !== "unknown") notes.push({ sourceField: `${source}.availability`, reason: "未知可用性枚举，降级为 unknown" });
    return [{
      id: stringOrFallback(value.id, `${source}.id`, `media-${position + 1}`, notes),
      location: stringOrNull(value.location, `${source}.location`, notes),
      durationFrames: nullableInteger(value.durationFrames, `${source}.durationFrames`, notes),
      availability,
    }];
  });
}

function fingerprintFor(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function noteUnknownFields(value: Record<string, unknown>, known: Set<string>, prefix: string, notes: MappingNote[]): void {
  for (const field of Object.keys(value).sort()) {
    if (!known.has(field)) notes.push({ sourceField: prefix ? `${prefix}.${field}` : field, reason: "协议字段未映射，已保留在 mappingNotes" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

function integerOrFallback(value: unknown, field: string, fallback: number, notes: MappingNote[]): number {
  const result = finiteInteger(value);
  if (result === null) notes.push({ sourceField: field, reason: `帧位置缺失或无效，使用 ${fallback}` });
  return result ?? fallback;
}

function nullableInteger(value: unknown, field: string, notes: MappingNote[]): number | null {
  if (value === undefined || value === null) {
    notes.push({ sourceField: field, reason: "数值缺失，无法映射" });
    return null;
  }
  const result = finiteInteger(value);
  if (result === null) notes.push({ sourceField: field, reason: "数值无效，无法映射" });
  return result;
}

function stringOrNull(value: unknown, field: string, notes: MappingNote[]): string | null {
  if (value === undefined || value === null) {
    notes.push({ sourceField: field, reason: "字符串字段缺失" });
    return null;
  }
  if (typeof value !== "string") {
    notes.push({ sourceField: field, reason: "字符串字段类型无效，按未知处理" });
    return null;
  }
  return value;
}

function stringOrFallback(value: unknown, field: string, fallback: string, notes: MappingNote[]): string {
  if (typeof value === "string" && value.length > 0) return value;
  notes.push({ sourceField: field, reason: `字符串字段缺失或为空，使用 ${fallback || "空字符串"}` });
  return fallback;
}


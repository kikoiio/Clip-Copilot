/** 中文标签表：阶段机、产物类型、状态。 */
import type { Phase } from "./types.ts";

export const PHASE_LABELS: Record<Phase, string> = {
  assets: "素材登记",
  score_draft: "配乐草稿",
  score_review: "配乐审阅",
  video_draft: "剪辑草稿",
  video_review: "剪辑审阅",
  final_verify: "终版核验",
  done: "已交付",
};

export const PHASE_ORDER: Phase[] = [
  "assets",
  "score_draft",
  "score_review",
  "video_draft",
  "video_review",
  "final_verify",
  "done",
];

export const ARTIFACT_KIND_LABELS: Record<string, string> = {
  lmms_project: "LMMS 工程",
  audio_preview: "配乐 WAV",
  audio_final: "终版配乐",
  kdenlive_project: "Kdenlive 工程",
  video_preview: "粗剪预览",
  video_final: "终版视频",
};

export function artifactKindLabel(kind: string): string {
  return ARTIFACT_KIND_LABELS[kind] ?? kind;
}

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase as Phase] ?? phase;
}

export function reviewLabel(review: string): string {
  if (review === "approved") return "已批准";
  if (review === "changes_requested") return "要求修改";
  return "待审阅";
}

export function bytesLabel(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function statusLabel(status: string): string {
  if (status === "pass") return "通过";
  if (status === "warn") return "告警";
  if (status === "fail") return "硬伤";
  if (status === "needs_human" || status === "needs_observation") return "待人工";
  if (status === "draft") return "草稿";
  if (status === "confirmed") return "已确认";
  if (status === "open") return "待处理";
  if (status === "acknowledged") return "已确认";
  if (status === "ignored") return "已忽略";
  if (status === "resolved") return "已解决";
  if (status === "pending") return "待审阅";
  return status;
}

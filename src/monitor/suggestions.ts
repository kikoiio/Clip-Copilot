import type {
  AnalysisResult,
  MonitorState,
  NotificationLevel,
  SuggestionRecord,
} from "./types.ts";

function nextSuggestionId(): string { return `suggestion-${randomUUID()}`; }

/** Reconcile only keys that analysis actually checked; unrelated advice stays open. */
export function reconcileSuggestions(
  current: MonitorState,
  analysis: AnalysisResult,
  _initial: boolean,
  now = new Date().toISOString(),
): { next: MonitorState; newlyOpened: SuggestionRecord[] } {
  const next = structuredClone(current);
  const checked = new Set(analysis.checkedKeys);
  const active = new Map(analysis.findings.map((finding) => [finding.key, finding]));
  const newlyOpened: SuggestionRecord[] = [];

  for (const record of next.suggestions) {
    if (record.status === "resolved" || !checked.has(record.key)) continue;
    const finding = active.get(record.key);
    if (finding) {
      Object.assign(record, finding, { lastSeenAt: now });
    } else {
      record.status = "resolved";
      record.resolvedAt = now;
      next.metrics.resolved += 1;
    }
  }

  for (const finding of analysis.findings) {
    const open = next.suggestions.find((record) => record.key === finding.key && record.status !== "resolved");
    if (open) continue;
    const episode = next.suggestions.reduce((max, record) =>
      record.key === finding.key ? Math.max(max, record.episode) : max, next.revision) + 1;
    const record: SuggestionRecord = {
      ...finding,
      id: nextSuggestionId(),
      episode,
      status: "open",
      firstSeenAt: now,
      lastSeenAt: now,
    };
    next.suggestions.push(record);
    newlyOpened.push(record);
  }
  return { next, newlyOpened };
}

export function decideSuggestion(
  current: MonitorState,
  id: string,
  decision: "acknowledge" | "ignore",
): MonitorState {
  const next = structuredClone(current);
  const record = next.suggestions.find((item) => item.id === id);
  if (!record) throw new Error(`建议 ${id} 不存在`);
  if (record.status === "resolved") throw new Error(`建议 ${id} 已解决，不能再处理`);
  const target = decision === "acknowledge" ? "acknowledged" : "ignored";
  if (record.status !== target) {
    record.status = target;
    next.metrics[decision === "acknowledge" ? "acknowledged" : "ignored"] += 1;
  }
  return next;
}

export function shouldNotify(record: SuggestionRecord, level: NotificationLevel): boolean {
  if (level === "silent" || record.status !== "open" || record.notificationAttemptedAt) return false;
  if (level === "all") return true;
  return record.priority === "high" && (
    record.category === "reference_missing"
    || record.category === "render_failed"
    || record.category === "stage_blocked"
  );
}

export function notificationCandidates(
  records: readonly SuggestionRecord[],
  level: NotificationLevel,
  initial: boolean,
): SuggestionRecord[] {
  return initial ? [] : records.filter((record) => shouldNotify(record, level));
}

/** Reserve before invoking the external notifier, giving each episode at most one attempt. */
export function reserveNotificationAttempt(
  current: MonitorState,
  id: string,
  now = new Date().toISOString(),
): MonitorState {
  const next = structuredClone(current);
  const record = next.suggestions.find((item) => item.id === id);
  if (!record) throw new Error(`建议 ${id} 不存在`);
  if (record.notificationAttemptedAt) {
    next.metrics.duplicateNotificationsSuppressed += 1;
    return next;
  }
  record.notificationAttemptedAt = now;
  next.metrics.notificationAttempts += 1;
  return next;
}

export function recordNotificationResult(current: MonitorState, id: string, sent: boolean, error?: string): MonitorState {
  const next = structuredClone(current);
  const record = next.suggestions.find((item) => item.id === id);
  if (!record || !record.notificationAttemptedAt) throw new Error(`建议 ${id} 没有通知尝试记录`);
  if (record.notificationResult) return next;
  record.notificationResult = sent ? "sent" : "failed";
  if (!sent && error) record.notificationError = error.slice(0, 500);
  next.metrics[sent ? "notificationSent" : "notificationFailed"] += 1;
  return next;
}
import { randomUUID } from "node:crypto";

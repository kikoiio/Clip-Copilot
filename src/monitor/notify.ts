import { spawn } from "node:child_process";
import { loadMonitorState, updateMonitorState } from "./store.ts";
import {
  notificationCandidates,
  recordNotificationResult,
  reserveNotificationAttempt,
  shouldNotify,
} from "./suggestions.ts";
import type { SuggestionRecord } from "./types.ts";

export type NotificationSender = (title: string, body: string) => Promise<void>;

/** Never invoke a shell or let a missing desktop session hold the monitor open. */
export const sendDesktopNotification: NotificationSender = async (title, body) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("notify-send", ["--app-name=Mountain Morning Monitor", "--expire-time=8000", title, body], {
      stdio: "ignore",
      env: process.env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`notify-send 退出码 ${String(code)}${signal ? ` (${signal})` : ""}`));
    });
  });
};

/** Persist the attempt before delivery so a crash cannot produce repeated alerts. */
export async function deliverNotifications(
  workspaceDir: string,
  records: SuggestionRecord[],
  initial: boolean,
  sender: NotificationSender = sendDesktopNotification,
): Promise<void> {
  if (initial) return;
  const snapshot = await loadMonitorState(workspaceDir);
  for (const candidate of notificationCandidates(records, snapshot.config.notificationLevel, false)) {
    let reserved = false;
    await updateMonitorState(workspaceDir, (state) => {
      const current = state.suggestions.find((item) => item.id === candidate.id);
      if (!current || !shouldNotify(current, state.config.notificationLevel)) return state;
      reserved = true;
      return reserveNotificationAttempt(state, candidate.id);
    });
    if (!reserved) continue;
    let error: string | undefined;
    try {
      await sender("山间清晨：工作区需要处理", `${candidate.evidence.slice(0, 160)}\n${candidate.nextAction.slice(0, 160)}`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    await updateMonitorState(workspaceDir, (state) => recordNotificationResult(state, candidate.id, error === undefined, error));
  }
}

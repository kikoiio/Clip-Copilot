import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { loadState } from "../workspace/store.ts";
import { analyzeChanges } from "./analyze.ts";
import { deliverNotifications, type NotificationSender } from "./notify.ts";
import { syncHandoff } from "./repair.ts";
import { scanWorkspace, watchWorkspace, type WorkspaceWatchHandle } from "./scan.ts";
import { acquireMonitorRunLock, loadMonitorState, updateMonitorState, type MonitorRunLock } from "./store.ts";
import { reconcileSuggestions } from "./suggestions.ts";
import type { AnalysisResult, FileChange, MonitorConfig, MonitorState, SuggestionRecord, WorkspaceSnapshot } from "./types.ts";

export interface MonitorEngineOptions {
  stableMs?: number;
  reconcileMs?: number;
  /** Defaults to the real desktop notifier; tests inject a recording stub. */
  notificationSender?: NotificationSender;
  /** Called after the error is also recorded in the affected workspace, where possible. */
  onWorkspaceError?: (workspaceDir: string, error: unknown) => void;
}

interface WorkspaceSession {
  dir: string;
  lock: MonitorRunLock;
  config: MonitorConfig;
  watcher?: WorkspaceWatchHandle;
  refreshTimer?: NodeJS.Timeout;
  refreshing?: Promise<void>;
  stopped: boolean;
  options: MonitorEngineOptions;
}

class ConfigChanged extends Error {}

function configKey(config: MonitorConfig): string {
  return JSON.stringify({
    scopes: [...config.scopes].sort(),
    notificationLevel: config.notificationLevel,
    autoRepairHandoff: config.autoRepairHandoff,
  });
}

async function reportError(dir: string, error: unknown, options: MonitorEngineOptions): Promise<void> {
  if (error instanceof ConfigChanged) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await updateMonitorState(dir, (current) => reconcileSuggestions(current, {
      findings: [{
        key: "analysis_error:monitor",
        category: "analysis_error",
        disposition: "question",
        priority: "normal",
        evidence: `监测 ${dir} 失败：${message}`,
        impact: "此工作区的变化可能尚未分析或同步",
        nextAction: "检查监测错误与工作区文件后，重新运行 monitor run。",
        affectedPaths: ["state.json"],
      }],
      checkedKeys: ["analysis_error:monitor"],
    }, false).next);
  } catch {
    // A damaged monitor record or unavailable write lock must remain untouched.
  }
  options.onWorkspaceError?.(dir, error);
}

async function resolveHandoffIfPresent(dir: string): Promise<void> {
  const current = await loadMonitorState(dir);
  if (!current.suggestions.some((item) => item.key === "handoff_missing:handoff.md" && item.status !== "resolved")) return;
  const info = await lstat(path.join(dir, "handoff.md")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info?.isFile()) return;
  await updateMonitorState(dir, (current) => reconcileSuggestions(current, {
    findings: [], checkedKeys: ["handoff_missing:handoff.md"],
  }, false).next);
}

/** Analysis and persistence finish before notification or handoff work starts. */
async function processSnapshot(
  session: WorkspaceSession,
  changes: FileChange[],
  snapshot: WorkspaceSnapshot,
  initial: boolean,
): Promise<void> {
  const prior = await loadMonitorState(session.dir);
  if (configKey(prior.config) !== configKey(session.config)) throw new ConfigChanged("监测配置已变化，等待重新扫描");
  const creative = (await loadState(session.dir)).state;
  const analysis: AnalysisResult = await analyzeChanges(session.dir, creative, snapshot, changes, initial);
  analysis.checkedKeys.push("analysis_error:monitor");
  let newlyOpened: SuggestionRecord[] = [];
  await updateMonitorState(session.dir, (current) => {
    if (configKey(current.config) !== configKey(session.config)) throw new ConfigChanged("监测配置已变化，等待重新扫描");
    const result = reconcileSuggestions(current, analysis, initial);
    newlyOpened = result.newlyOpened;
    return { ...result.next, baseline: snapshot };
  });
  // The notifier manages its own attempt/result writes. Neither call holds the monitor write lock.
  try { await deliverNotifications(session.dir, newlyOpened, initial, session.options.notificationSender); }
  catch (error) { await reportError(session.dir, error, session.options); }
  try {
    await syncHandoff(session.dir);
    await resolveHandoffIfPresent(session.dir);
  } catch (error) {
    await reportError(session.dir, error, session.options);
  }
}

async function startWatcher(session: WorkspaceSession, options: MonitorEngineOptions): Promise<void> {
  const baseline = (await loadMonitorState(session.dir)).baseline;
  if (!baseline) throw new Error(`工作区 ${session.dir} 缺少监测基线`);
  session.watcher = await watchWorkspace(session.dir, session.config, baseline,
    async (changes, snapshot) => processSnapshot(session, changes, snapshot, false),
    {
      stableMs: options.stableMs,
      reconcileMs: options.reconcileMs,
      onError: (error) => { void reportError(session.dir, error, options); },
    });
}

async function refreshConfig(session: WorkspaceSession, options: MonitorEngineOptions): Promise<void> {
  if (session.stopped) return;
  const persisted = await loadMonitorState(session.dir);
  if (configKey(persisted.config) === configKey(session.config)) return;
  const scopeChanged = JSON.stringify([...persisted.config.scopes].sort()) !== JSON.stringify([...session.config.scopes].sort());
  const repairChanged = persisted.config.autoRepairHandoff !== session.config.autoRepairHandoff;
  if (scopeChanged) {
    await session.watcher?.close();
    session.watcher = undefined;
    session.config = persisted.config;
    const snapshot = await scanWorkspace(session.dir, session.config, persisted.baseline);
    await processSnapshot(session, [], snapshot, true); // newly enabled scope is a quiet baseline
    await startWatcher(session, options);
  } else {
    session.config = persisted.config;
    if (repairChanged) {
      await syncHandoff(session.dir);
      await resolveHandoffIfPresent(session.dir);
    }
  }
}

async function startWorkspace(dir: string, options: MonitorEngineOptions): Promise<WorkspaceSession> {
  const lock = await acquireMonitorRunLock(dir);
  const session: WorkspaceSession = { dir, lock, config: { scopes: [], notificationLevel: "silent", autoRepairHandoff: false }, stopped: false, options };
  try {
    const persisted = await loadMonitorState(dir);
    session.config = persisted.config;
    if (!persisted.baseline) {
      const snapshot = await scanWorkspace(dir, session.config);
      const changes = Object.entries(snapshot.files).map(([filePath, after]) => ({
        path: filePath, kind: "added" as const, after,
      }));
      await processSnapshot(session, changes, snapshot, true);
    }
    await startWatcher(session, options);
    const pollMs = options.reconcileMs ?? 10_000;
    session.refreshTimer = setInterval(() => {
      if (session.refreshing || session.stopped) return;
      session.refreshing = refreshConfig(session, options)
        .catch((error: unknown) => reportError(session.dir, error, options))
        .finally(() => { session.refreshing = undefined; });
    }, pollMs);
    return session;
  } catch (error) {
    session.stopped = true;
    await session.watcher?.close();
    await lock.release();
    throw error;
  }
}

async function stopWorkspace(session: WorkspaceSession): Promise<void> {
  session.stopped = true;
  if (session.refreshTimer) clearInterval(session.refreshTimer);
  await session.refreshing?.catch(() => {});
  try { await session.watcher?.close(); }
  finally { await session.lock.release(); }
}

/**
 * Runs a foreground monitor until `signal` is aborted. One workspace failure is
 * recorded and does not prevent other workspaces from continuing. Every acquired
 * watcher and run lock is released before this promise settles.
 */
export async function watchWorkspaces(
  workspaceDirs: string[],
  signal: AbortSignal,
  options: MonitorEngineOptions = {},
): Promise<void> {
  if (workspaceDirs.length === 0) throw new Error("至少指定一个工作区");
  const normalized: string[] = [];
  const failures: unknown[] = [];
  for (const dir of workspaceDirs) {
    try { normalized.push(await realpath(dir)); }
    catch (error) {
      failures.push(error);
      options.onWorkspaceError?.(path.resolve(dir), error);
    }
  }
  const directories = [...new Set(normalized)].sort();
  const sessions: WorkspaceSession[] = [];
  try {
    for (const dir of directories) {
      if (signal.aborted) break;
      try { sessions.push(await startWorkspace(dir, options)); }
      catch (error) {
        failures.push(error);
        await reportError(dir, error, options);
      }
    }
    if (sessions.length === 0 && !signal.aborted) {
      throw new AggregateError(failures, "所有指定工作区均无法启动监测");
    }
    if (!signal.aborted) await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      if (signal.aborted) resolve();
    });
  } finally {
    const stopped = await Promise.allSettled(sessions.map(stopWorkspace));
    const cleanupErrors = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors.map((item) => item.reason), "监测器关闭时释放资源失败");
  }
}

import { watch, type FSWatcher } from "node:fs";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { FileChange, FileStamp, MonitorConfig, MonitorScope, WorkspaceSnapshot } from "./types.ts";

const DEFAULT_STABLE_MS = 2_000;
const DEFAULT_RECONCILE_MS = 10_000;
export const MAX_SCAN_ENTRIES = 20_000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const SCOPED_DIRECTORIES: readonly MonitorScope[] = ["assets", "projects", "outputs", "evidence"];

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function temporary(name: string): boolean {
  return name.startsWith(".") || name.endsWith("~") || /(?:\.tmp(?:-.+)?|\.part|\.swp|\.bak)$/i.test(name);
}

/** The same filter is used for snapshots and directory watcher registration. */
export function monitoredPath(relativePath: string, config: MonitorConfig): boolean {
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || temporary(part))) return false;
  if (parts.length === 1) return parts[0] === "state.json" && config.scopes.includes("state");
  const [scope, ...rest] = parts;
  if (!SCOPED_DIRECTORIES.includes(scope as MonitorScope) || !config.scopes.includes(scope as MonitorScope)) return false;
  if (rest.some((part) => part === "checkpoints" || part === ".monitor" || part === "handoff.md")) return false;
  if (scope === "projects") return /\.(?:mmp|kdenlive)$/i.test(parts.at(-1)!);
  if (scope === "evidence") {
    const name = parts.at(-1)!;
    return parts.length === 2 && (
      /^check-report-.+\.json$/i.test(name)
      || /^verify-\d+\.json$/i.test(name)
      || /^(?:lmms|kdenlive)-render-.+\.json$/i.test(name)
      || /^(?:lmms|kdenlive)-headless-validate\.json$/i.test(name)
      || /^observation-.+\.json$/i.test(name)
      || name === "final-quality-analysis.json"
    );
  }
  return true;
}

function stampMatches(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs
    && (a.sha256 === undefined || b.sha256 === undefined || a.sha256 === b.sha256);
}

/** Metadata-only snapshot; symlink entries are skipped, including symlinked directories. */
export async function scanWorkspace(
  workspaceDir: string,
  config: MonitorConfig,
  previous?: WorkspaceSnapshot,
): Promise<WorkspaceSnapshot> {
  const root = await realpath(workspaceDir);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error(`工作区不是目录：${workspaceDir}`);
  const files: Record<string, FileStamp> = Object.create(null) as Record<string, FileStamp>;
  let visited = 0;

  async function walk(absoluteDir: string, relativeDir: string): Promise<void> {
    let actual: string;
    try { actual = await realpath(absoluteDir); }
    catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!inside(root, actual)) return;
    let directory;
    try {
      directory = await opendir(absoluteDir);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for await (const entry of directory) {
      if (++visited > MAX_SCAN_ENTRIES) {
        throw new Error(`工作区扫描超过 ${MAX_SCAN_ENTRIES} 个目录项：${workspaceDir}`);
      }
      if (temporary(entry.name) || entry.name === ".monitor" || entry.name === "checkpoints" || entry.name === "handoff.md") continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile() && monitoredPath(relative, config)) {
        try {
          const info = await lstat(absolute);
          if (info.isFile()) files[relative] = { size: info.size, mtimeMs: info.mtimeMs };
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    }
  }

  for (const scope of SCOPED_DIRECTORIES) {
    if (!config.scopes.includes(scope)) continue;
    const absolute = path.join(root, scope);
    try {
      const info = await lstat(absolute);
      if (info.isDirectory()) await walk(absolute, scope);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  if (config.scopes.includes("state")) {
    const file = path.join(root, "state.json");
    try {
      const info = await lstat(file);
      if (info.isFile()) {
        if (++visited > MAX_SCAN_ENTRIES) throw new Error(`工作区扫描超过 ${MAX_SCAN_ENTRIES} 个目录项：${workspaceDir}`);
        files["state.json"] = { size: info.size, mtimeMs: info.mtimeMs };
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  let stateRevision = previous?.stateRevision ?? 0;
  if (files["state.json"] && files["state.json"].size <= MAX_STATE_BYTES
      && !stampMatches(files["state.json"], previous?.files["state.json"])) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
      const revision = (parsed as { revision?: unknown } | null)?.revision;
      if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) stateRevision = revision;
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
    }
  }
  return { scannedAt: new Date().toISOString(), stateRevision, files };
}

/** Returns deterministic, workspace-relative net changes. */
export function diffSnapshots(before: WorkspaceSnapshot | undefined, after: WorkspaceSnapshot): FileChange[] {
  const prior = before?.files ?? {};
  const changes: FileChange[] = [];
  for (const relative of [...new Set([...Object.keys(prior), ...Object.keys(after.files)])].sort()) {
    const oldStamp = prior[relative];
    const newStamp = after.files[relative];
    if (!oldStamp && newStamp) changes.push({ path: relative, kind: "added", after: newStamp });
    else if (oldStamp && !newStamp) changes.push({ path: relative, kind: "removed", before: oldStamp });
    else if (oldStamp && newStamp && !stampMatches(oldStamp, newStamp)) {
      changes.push({ path: relative, kind: "modified", before: oldStamp, after: newStamp });
    }
  }
  return changes;
}

export interface WorkspaceWatchOptions {
  stableMs?: number;
  reconcileMs?: number;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

export interface WorkspaceWatchHandle {
  /** Runs one reconciliation scan, including the stability check. */
  scanNow(): Promise<void>;
  /** Stops timers and file watchers, then waits for any in-flight callback. */
  close(): Promise<void>;
}

/**
 * Watches one workspace. `baseline` is the last persisted snapshot. The callback receives
 * only changes whose stamp stayed constant for `stableMs`; its snapshot applies only those
 * changes, so persisting it cannot silently commit a file that is still being written.
 */
export async function watchWorkspace(
  workspaceDir: string,
  config: MonitorConfig,
  baseline: WorkspaceSnapshot,
  onChanges: (changes: FileChange[], snapshot: WorkspaceSnapshot) => Promise<void>,
  options: WorkspaceWatchOptions = {},
): Promise<WorkspaceWatchHandle> {
  const stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
  const reconcileMs = options.reconcileMs ?? DEFAULT_RECONCILE_MS;
  if (!Number.isFinite(stableMs) || stableMs < 0 || !Number.isFinite(reconcileMs) || reconcileMs <= 0) {
    throw new Error("稳定窗口和补扫周期必须是有效的非负/正毫秒数");
  }
  const root = await realpath(workspaceDir);
  let committed = baseline;
  const pending = new Map<string, { signature: string; since: number }>();
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let eventTimer: NodeJS.Timeout | undefined;
  let stableTimer: NodeJS.Timeout | undefined;
  let active: Promise<void> = Promise.resolve();
  let interval: NodeJS.Timeout | undefined;

  function signature(change: FileChange): string {
    const stamp = change.after;
    return `${change.kind}:${stamp?.size ?? "-"}:${stamp?.mtimeMs ?? "-"}:${stamp?.sha256 ?? "-"}`;
  }

  function queueScan(delayMs = 50): void {
    if (closed || eventTimer) return;
    eventTimer = setTimeout(() => {
      eventTimer = undefined;
      void scanNow().catch((error: unknown) => options.onError?.(error));
    }, delayMs);
  }

  async function registerDirectories(): Promise<void> {
    if (closed) return;
    const desired = new Set<string>([root]);
    let visited = 0;
    async function visit(dir: string): Promise<void> {
      let actual: string;
      try { actual = await realpath(dir); }
      catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      if (!inside(root, actual)) return;
      desired.add(dir);
      let directory;
      try {
        directory = await opendir(dir);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      for await (const entry of directory) {
        if (++visited > MAX_SCAN_ENTRIES) {
          throw new Error(`工作区监听超过 ${MAX_SCAN_ENTRIES} 个目录项：${workspaceDir}`);
        }
        if (!entry.isDirectory() || temporary(entry.name) || entry.name === ".monitor" || entry.name === "checkpoints") continue;
        await visit(path.join(dir, entry.name));
      }
    }
    for (const scope of SCOPED_DIRECTORIES) {
      if (!config.scopes.includes(scope)) continue;
      const dir = path.join(root, scope);
      try {
        const info = await lstat(dir);
        if (info.isDirectory()) await visit(dir);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    for (const [dir, watcher] of watchers) {
      if (!desired.has(dir)) { watcher.close(); watchers.delete(dir); }
    }
    for (const dir of desired) {
      if (closed) return; // close() may have swept while this sample was scanning
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, () => queueScan());
        watcher.on("error", (error: unknown) => {
          watcher.close();
          watchers.delete(dir);
          options.onError?.(error);
        });
        watchers.set(dir, watcher);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  async function sample(): Promise<void> {
    if (closed) return;
    await registerDirectories();
    const current = await scanWorkspace(root, config, committed);
    const differences = diffSnapshots(committed, current);
    const now = Date.now();
    const live = new Set(differences.map((change) => change.path));
    for (const relative of pending.keys()) if (!live.has(relative)) pending.delete(relative);
    const ready: FileChange[] = [];
    let nextDue = Number.POSITIVE_INFINITY;
    for (const change of differences) {
      const value = signature(change);
      const old = pending.get(change.path);
      if (!old || old.signature !== value) {
        pending.set(change.path, { signature: value, since: now });
        nextDue = Math.min(nextDue, now + stableMs);
      } else if (now - old.since >= stableMs) {
        ready.push(change);
      } else {
        nextDue = Math.min(nextDue, old.since + stableMs);
      }
    }
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = undefined;
    if (ready.length) {
      const files = { ...committed.files };
      for (const change of ready) {
        if (change.after) files[change.path] = change.after;
        else delete files[change.path];
      }
      const snapshot: WorkspaceSnapshot = {
        scannedAt: current.scannedAt,
        stateRevision: ready.some((change) => change.path === "state.json") ? current.stateRevision : committed.stateRevision,
        files,
      };
      await onChanges(ready, snapshot);
      committed = snapshot;
      for (const change of ready) pending.delete(change.path);
    }
    if (Number.isFinite(nextDue)) {
      stableTimer = setTimeout(() => {
        stableTimer = undefined;
        void scanNow().catch((error: unknown) => options.onError?.(error));
      }, Math.max(0, nextDue - Date.now()));
    }
  }

  function scanNow(): Promise<void> {
    active = active.catch(() => {}).then(sample);
    return active;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (eventTimer) clearTimeout(eventTimer);
    if (stableTimer) clearTimeout(stableTimer);
    if (interval) clearInterval(interval);
    options.signal?.removeEventListener("abort", abort);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    await active.catch(() => {});
    // An in-flight sample may have registered watchers after the sweep above.
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  }

  function abort(): void { void close(); }
  try {
    await registerDirectories();
    interval = setInterval(() => queueScan(0), reconcileMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) await close();
    else queueScan(0); // close the registration gap after the caller's baseline scan
  } catch (error) {
    await close();
    throw error;
  }
  return { scanNow, close };
}

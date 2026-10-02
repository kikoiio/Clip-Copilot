import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  emptyMonitorState,
  type Finding,
  type MonitorState,
  type SuggestionRecord,
} from "./types.ts";

export const MONITOR_DIR = ".monitor";
export const MONITOR_STATE_FILE = "state.json";
export const MONITOR_WRITE_LOCK = "write.lock";
export const MONITOR_RUN_LOCK = "run.lock";
export const MONITOR_HISTORY_DIR = "history";
export const MAX_MONITOR_STATE_BYTES = 8 * 1024 * 1024;
export const RETAIN_RESOLVED_SUGGESTIONS = 200;
export const RETAIN_REPAIR_RECORDS = 200;

const WRITE_LOCK_TIMEOUT_MS = 2_000;
const LOCK_POLL_MS = 25;

export class MonitorStoreError extends Error {}
export class MonitorLockError extends MonitorStoreError {}

interface LockIdentity {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface MonitorRunLock {
  readonly workspaceDir: string;
  release(): Promise<void>;
}

export type MonitorHistoryRecord =
  | { kind: "suggestion"; revision: number; record: SuggestionRecord }
  | { kind: "repair"; revision: number; record: MonitorState["repairs"][number] };

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MonitorStoreError(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new MonitorStoreError(`${name} 必须是非空字符串`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new MonitorStoreError(`${name} 必须是非负整数`);
  return value as number;
}

function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new MonitorStoreError(`${name} 非法`);
  return value as T;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new MonitorStoreError(`${name} 必须是数组`);
  return value;
}

function strings(value: unknown, name: string): string[] {
  return array(value, name).map((item, index) => string(item, `${name}[${index}]`));
}

function relativePath(value: unknown, name: string): string {
  const text = string(value, name);
  if (path.isAbsolute(text) || text.includes("\\") || text.split("/").includes("..") || text === ".") {
    throw new MonitorStoreError(`${name} 必须是工作区相对路径`);
  }
  return text;
}

function finding(value: unknown, name: string): Finding {
  const item = object(value, name);
  string(item.key, `${name}.key`);
  choice(item.category, ["asset_added", "asset_missing", "asset_changed", "project_changed", "reference_missing", "project_invalid", "artifact_changed", "render_failed", "stage_blocked", "handoff_missing", "analysis_error"], `${name}.category`);
  choice(item.disposition, ["action", "question", "record"], `${name}.disposition`);
  choice(item.priority, ["high", "normal", "info"], `${name}.priority`);
  string(item.evidence, `${name}.evidence`);
  string(item.impact, `${name}.impact`);
  string(item.nextAction, `${name}.nextAction`);
  strings(item.affectedPaths, `${name}.affectedPaths`).forEach((itemPath, index) => relativePath(itemPath, `${name}.affectedPaths[${index}]`));
  return item as unknown as Finding;
}

function suggestion(value: unknown, name: string): SuggestionRecord {
  const item = object(finding(value, name), name);
  string(item.id, `${name}.id`);
  integer(item.episode, `${name}.episode`);
  if (item.episode === 0) throw new MonitorStoreError(`${name}.episode 必须大于 0`);
  choice(item.status, ["open", "acknowledged", "ignored", "resolved"], `${name}.status`);
  string(item.firstSeenAt, `${name}.firstSeenAt`);
  string(item.lastSeenAt, `${name}.lastSeenAt`);
  if (item.resolvedAt !== undefined) string(item.resolvedAt, `${name}.resolvedAt`);
  if (item.notificationAttemptedAt !== undefined) string(item.notificationAttemptedAt, `${name}.notificationAttemptedAt`);
  if (item.notificationResult !== undefined) choice(item.notificationResult, ["sent", "failed"], `${name}.notificationResult`);
  if (item.notificationError !== undefined) string(item.notificationError, `${name}.notificationError`);
  return item as unknown as SuggestionRecord;
}

/** Refuse damaged and unknown records instead of replacing them with defaults. */
export function assertValidMonitorState(value: unknown): MonitorState {
  const state = object(value, "监测记录");
  if (state.schemaVersion !== 1) {
    throw new MonitorStoreError(`监测记录 schemaVersion=${String(state.schemaVersion)}，期望 1（保留原文件）`);
  }
  integer(state.revision, "revision");
  const config = object(state.config, "config");
  const scopes = array(config.scopes, "config.scopes");
  const seenScopes = new Set<string>();
  for (const scope of scopes) {
    const valid = choice(scope, ["assets", "projects", "outputs", "evidence", "state"], "config.scopes 项");
    if (seenScopes.has(valid)) throw new MonitorStoreError("config.scopes 包含重复项");
    seenScopes.add(valid);
  }
  choice(config.notificationLevel, ["silent", "important", "all"], "config.notificationLevel");
  if (typeof config.autoRepairHandoff !== "boolean") throw new MonitorStoreError("config.autoRepairHandoff 必须是布尔值");
  if (state.baseline !== undefined) {
    const baseline = object(state.baseline, "baseline");
    string(baseline.scannedAt, "baseline.scannedAt");
    integer(baseline.stateRevision, "baseline.stateRevision");
    const files = object(baseline.files, "baseline.files");
    for (const [filePath, rawStamp] of Object.entries(files)) {
      relativePath(filePath, "baseline.files 路径");
      const stamp = object(rawStamp, `baseline.files[${filePath}]`);
      integer(stamp.size, `baseline.files[${filePath}].size`);
      if (typeof stamp.mtimeMs !== "number" || !Number.isFinite(stamp.mtimeMs) || stamp.mtimeMs < 0) {
        throw new MonitorStoreError(`baseline.files[${filePath}].mtimeMs 非法`);
      }
      if (stamp.sha256 !== undefined && (typeof stamp.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(stamp.sha256))) {
        throw new MonitorStoreError(`baseline.files[${filePath}].sha256 非法`);
      }
    }
  }
  const ids = new Set<string>();
  for (const [index, rawSuggestion] of array(state.suggestions, "suggestions").entries()) {
    const item = suggestion(rawSuggestion, `suggestions[${index}]`);
    if (ids.has(item.id)) throw new MonitorStoreError(`建议 ID 重复：${item.id}`);
    ids.add(item.id);
  }
  const metrics = object(state.metrics, "metrics");
  for (const key of ["notificationAttempts", "notificationSent", "notificationFailed", "duplicateNotificationsSuppressed", "acknowledged", "ignored", "resolved"]) {
    integer(metrics[key], `metrics.${key}`);
  }
  for (const [index, rawRepair] of array(state.repairs, "repairs").entries()) {
    const item = object(rawRepair, `repairs[${index}]`);
    string(item.at, `repairs[${index}].at`);
    choice(item.action, ["rebuild-handoff"], `repairs[${index}].action`);
    if (typeof item.authorized !== "boolean") throw new MonitorStoreError(`repairs[${index}].authorized 必须是布尔值`);
    choice(item.result, ["verified", "failed"], `repairs[${index}].result`);
    string(item.evidence, `repairs[${index}].evidence`);
  }
  return value as MonitorState;
}

function monitorPath(workspaceDir: string, file: string): string {
  return path.join(path.resolve(workspaceDir), MONITOR_DIR, file);
}

async function ensureMonitorDir(workspaceDir: string): Promise<void> {
  const dir = monitorPath(workspaceDir, ".");
  await mkdir(dir, { recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MonitorStoreError(`${dir} 不是普通目录`);
}

export async function loadMonitorState(workspaceDir: string): Promise<MonitorState> {
  const file = monitorPath(workspaceDir, MONITOR_STATE_FILE);
  let raw: string;
  try {
    const dirInfo = await lstat(path.dirname(file));
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
      throw new MonitorStoreError(`监测目录 ${path.dirname(file)} 不是普通目录`);
    }
    const fileInfo = await lstat(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new MonitorStoreError(`监测记录 ${file} 不是普通文件（保留原文件）`);
    }
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_MONITOR_STATE_BYTES) {
        throw new MonitorStoreError(`监测记录 ${file} 不是普通文件或超过 ${MAX_MONITOR_STATE_BYTES} 字节上限（保留原文件）`);
      }
      const chunks: Buffer[] = [];
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let used = 0;
      while (used <= MAX_MONITOR_STATE_BYTES) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, MAX_MONITOR_STATE_BYTES + 1 - used), used);
        if (bytesRead === 0) break;
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
        used += bytesRead;
      }
      if (used > MAX_MONITOR_STATE_BYTES) {
        throw new MonitorStoreError(`监测记录 ${file} 超过 ${MAX_MONITOR_STATE_BYTES} 字节上限（保留原文件）`);
      }
      raw = Buffer.concat(chunks, used).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMonitorState();
    if (error instanceof MonitorStoreError) throw error;
    throw new MonitorStoreError(`无法读取监测记录 ${file}：${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MonitorStoreError(`监测记录 ${file} 不是合法 JSON（保留原文件）：${String(error)}`);
  }
  return assertValidMonitorState(parsed);
}

function lockIdentity(value: unknown): LockIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Partial<LockIdentity>;
  if (!Number.isSafeInteger(item.pid) || (item.pid ?? 0) <= 0 || typeof item.token !== "string" || item.token.length === 0 || typeof item.acquiredAt !== "string") return undefined;
  return item as LockIdentity;
}

function confirmedDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function removeConfirmedStaleLock(file: string): Promise<boolean> {
  let before;
  let raw: string;
  try {
    before = await lstat(file);
    if (before.size > 4_096) return false;
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  if (!before.isFile() || before.isSymbolicLink()) return false;
  let identity: LockIdentity | undefined;
  try { identity = lockIdentity(JSON.parse(raw)); } catch { return false; }
  if (!identity || !confirmedDead(identity.pid)) return false;
  const after = await lstat(file).catch(() => undefined);
  if (!after || after.ino !== before.ino || after.dev !== before.dev) return false;
  await rm(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return true;
}

interface LockHandle {
  release(): Promise<void>;
}

async function acquireLock(workspaceDir: string, name: string, timeoutMs: number): Promise<LockHandle> {
  await ensureMonitorDir(workspaceDir);
  const file = monitorPath(workspaceDir, name);
  const identity: LockIdentity = { pid: process.pid, token: randomUUID(), acquiredAt: new Date().toISOString() };
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(identity), "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(file, { force: true });
        throw error;
      }
      const info = await handle.stat();
      await handle.close();
      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          const current = await lstat(file).catch(() => undefined);
          if (!current) { released = true; return; }
          if (current.ino !== info.ino || current.dev !== info.dev) throw new MonitorLockError(`锁 ${file} 已被其他进程替换，拒绝释放`);
          let currentIdentity: LockIdentity | undefined;
          try { currentIdentity = lockIdentity(JSON.parse(await readFile(file, "utf8"))); } catch { /* Preserve unknown lock. */ }
          if (currentIdentity?.token !== identity.token) throw new MonitorLockError(`锁 ${file} 所有者已变化，拒绝释放`);
          await rm(file);
          released = true;
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeConfirmedStaleLock(file)) continue;
      if (Date.now() >= deadline) throw new MonitorLockError(`监测锁 ${file} 被占用或所有者无法确认，等待超时`);
      await delay(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

/** One foreground monitor per workspace; independent from short state mutations. */
export async function acquireMonitorRunLock(workspaceDir: string): Promise<MonitorRunLock> {
  const lock = await acquireLock(workspaceDir, MONITOR_RUN_LOCK, 0);
  return { workspaceDir: path.resolve(workspaceDir), release: () => lock.release() };
}

export async function releaseMonitorRunLock(lock: MonitorRunLock): Promise<void> {
  await lock.release();
}

async function saveMonitorState(workspaceDir: string, state: MonitorState): Promise<void> {
  await ensureMonitorDir(workspaceDir);
  const file = monitorPath(workspaceDir, MONITOR_STATE_FILE);
  const temporary = monitorPath(workspaceDir, `.state.json.tmp-${process.pid}-${randomUUID()}`);
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_MONITOR_STATE_BYTES) {
    throw new MonitorStoreError(`监测记录更新超过 ${MAX_MONITOR_STATE_BYTES} 字节上限，拒绝保存`);
  }
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

function historyChunkPath(workspaceDir: string, revision: number): string {
  return monitorPath(workspaceDir, path.join(MONITOR_HISTORY_DIR, `rev-${String(revision).padStart(12, "0")}.jsonl`));
}

function compactMonitorState(state: MonitorState): { state: MonitorState; archive: MonitorHistoryRecord[] } {
  const resolved = state.suggestions
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.status === "resolved")
    .sort((a, b) => (b.record.resolvedAt ?? b.record.lastSeenAt).localeCompare(a.record.resolvedAt ?? a.record.lastSeenAt) || b.index - a.index);
  const keepResolved = new Set(resolved.slice(0, RETAIN_RESOLVED_SUGGESTIONS).map(({ index }) => index));
  const archive: MonitorHistoryRecord[] = [];
  state.suggestions = state.suggestions.filter((record, index) => {
    if (record.status !== "resolved" || keepResolved.has(index)) return true;
    archive.push({ kind: "suggestion", revision: state.revision, record });
    return false;
  });
  if (state.repairs.length > RETAIN_REPAIR_RECORDS) {
    const old = state.repairs.splice(0, state.repairs.length - RETAIN_REPAIR_RECORDS);
    archive.push(...old.map((record) => ({ kind: "repair" as const, revision: state.revision, record })));
  }
  return { state, archive };
}

/** Write a complete immutable revision chunk before the state commit. */
async function prepareHistoryChunk(workspaceDir: string, revision: number, records: MonitorHistoryRecord[]): Promise<void> {
  const file = historyChunkPath(workspaceDir, revision);
  const dir = path.dirname(file);
  const existingDir = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existingDir && (!existingDir.isDirectory() || existingDir.isSymbolicLink())) {
    throw new MonitorStoreError(`${dir} 不是普通目录`);
  }
  if (records.length === 0) {
    // A prior failed attempt may have left an uncommitted chunk for this revision.
    await rm(file, { force: true });
    return;
  }
  await mkdir(dir, { recursive: true });
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new MonitorStoreError(`${dir} 不是普通目录`);
  const serialized = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_MONITOR_STATE_BYTES * 2) {
    throw new MonitorStoreError("监测历史归档块过大，拒绝提交；原记录仍在主状态中");
  }
  const temporary = path.join(dir, `.rev-${revision}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

/** Stream committed history only; chunks left by failed updates remain invisible. */
export async function* iterateMonitorHistory(workspaceDir: string): AsyncGenerator<MonitorHistoryRecord> {
  const committedRevision = (await loadMonitorState(workspaceDir)).revision;
  const dir = monitorPath(workspaceDir, MONITOR_HISTORY_DIR);
  const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MonitorStoreError(`${dir} 不是普通目录`);
  for await (const entry of await opendir(dir)) {
    const match = /^rev-(\d+)\.jsonl$/.exec(entry.name);
    if (!match || !entry.isFile() || Number(match[1]) > committedRevision) continue;
    const chunkPath = path.join(dir, entry.name);
    const chunkInfo = await lstat(chunkPath);
    if (!chunkInfo.isFile() || chunkInfo.isSymbolicLink() || chunkInfo.size > MAX_MONITOR_STATE_BYTES * 2) {
      throw new MonitorStoreError(`监测历史归档 ${chunkPath} 非法或过大`);
    }
    const lines = createInterface({ input: createReadStream(chunkPath, { encoding: "utf8", highWaterMark: 64 * 1024 }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      let item: MonitorHistoryRecord;
      try { item = JSON.parse(line) as MonitorHistoryRecord; } catch { throw new MonitorStoreError(`监测历史归档 ${chunkPath} 不是合法 JSONL`); }
      if (item.revision !== Number(match[1]) || !["suggestion", "repair"].includes(item.kind)) {
        throw new MonitorStoreError(`监测历史归档 ${chunkPath} 修订号或记录类别非法`);
      }
      yield item;
    }
  }
}

/** Re-read under an interprocess lock, then commit exactly one new revision. */
export async function updateMonitorState(
  workspaceDir: string,
  mutate: (current: MonitorState) => MonitorState,
): Promise<MonitorState> {
  const lock = await acquireLock(workspaceDir, MONITOR_WRITE_LOCK, WRITE_LOCK_TIMEOUT_MS);
  try {
    const current = await loadMonitorState(workspaceDir);
    const next = mutate(structuredClone(current));
    if (next === undefined) throw new MonitorStoreError("监测记录更新函数未返回新状态");
    const saved = { ...next, revision: current.revision + 1 };
    assertValidMonitorState(saved);
    const compacted = compactMonitorState(saved);
    await prepareHistoryChunk(workspaceDir, saved.revision, compacted.archive);
    await saveMonitorState(workspaceDir, compacted.state);
    return compacted.state;
  } finally {
    await lock.release();
  }
}

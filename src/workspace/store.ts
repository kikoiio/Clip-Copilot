import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SCHEMA_VERSION,
  migrateStateV1,
  type ArtifactRecord,
  type CheckpointRecord,
  type Goal,
  type WorkspaceState,
} from "../domain.ts";
import { validateResolveWorkspaceContext } from "../editor/workspace.ts";

export const STATE_FILE = "state.json";

export class WorkspaceError extends Error {}

/** Serialize handoff writers across CLI and monitor; render while holding the lock. */
export async function writeHandoffAtomic(
  workspaceDir: string,
  render: () => Promise<string>,
  mode: "always" | "existing" | "missing" = "always",
): Promise<string | undefined> {
  await mkdir(workspaceDir, { recursive: true });
  const file = path.join(workspaceDir, "handoff.md");
  const lockPath = path.join(workspaceDir, ".handoff.write.lock");
  const deadline = Date.now() + 2_000;
  let lock;
  while (!lock) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(String(process.pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFile(lockPath, "utf8").catch(() => "");
      const pid = Number(owner.trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
            await rm(lockPath, { force: true });
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new WorkspaceError(`handoff 写锁被占用：${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const temporary = path.join(workspaceDir, `.handoff.md.tmp-${process.pid}-${Date.now()}`);
  try {
    const exists = await stat(file).then(() => true, () => false);
    if (mode === "existing" && !exists) return undefined;
    if (mode === "missing" && exists) return undefined;
    const content = await render();
    if (!content.trim()) throw new WorkspaceError("handoff 内容为空，拒绝替换");
    const out = await open(temporary, "wx", 0o600);
    try {
      await out.writeFile(content, "utf8");
      await out.sync();
    } finally {
      await out.close();
    }
    await rename(temporary, file);
    return file;
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/** 计算 SHA-256，用于产物指纹与素材标识。 */
export async function sha256File(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function workspacePath(workspaceDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.join(workspaceDir, relativePath);
}

/** 结构检查；损坏或未知版本一律拒绝，不静默修复。v1 报文在内存中迁移为 v2。 */
export function assertValidState(value: unknown): WorkspaceState {
  if (typeof value !== "object" || value === null) {
    throw new WorkspaceError("state.json 不是对象");
  }
  const rawVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  if (rawVersion === 1) {
    const migrated = migrateStateV1(value);
    if (migrated === null) {
      throw new WorkspaceError("state.json 声明为 v1 但无法迁移");
    }
    return migrated;
  }
  const state = value as WorkspaceState;
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new WorkspaceError(`state.json schemaVersion=${String(rawVersion)}，期望 ${SCHEMA_VERSION}（或可迁移的 1）`);
  }
  if (state.workspaceKind !== undefined && state.workspaceKind !== "resolve") {
    throw new WorkspaceError("state.json workspaceKind 非法");
  }
  if (state.workspaceKind === "resolve") {
    if (state.editorContext === undefined) {
      throw new WorkspaceError("Resolve state 缺少 editorContext");
    }
    try {
      validateResolveWorkspaceContext(state.editorContext);
    } catch (error) {
      throw new WorkspaceError(`Resolve editorContext 非法：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (state.editorContext !== undefined) {
    throw new WorkspaceError("未标记 Resolve 的旧状态不得包含 editorContext");
  }
  if (typeof state.revision !== "number" || state.revision < 0) {
    throw new WorkspaceError("state.json revision 非法");
  }
  for (const key of ["phase", "assets", "artifacts", "checkpoints", "decisions", "issues", "nextAction", "updatedAt", "goal"] as const) {
    if (!(key in state)) {
      throw new WorkspaceError(`state.json 缺少字段 ${key}`);
    }
  }
  return state;
}

export interface LoadedState {
  dir: string;
  state: WorkspaceState;
}

export async function loadState(workspaceDir: string): Promise<LoadedState> {
  const file = path.join(workspaceDir, STATE_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new WorkspaceError(`无法读取 ${file}：${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkspaceError(
      `state.json 不是合法 JSON（保留原文件，未做修改）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { dir: workspaceDir, state: assertValidState(parsed) };
}

export async function stateExists(workspaceDir: string): Promise<boolean> {
  try {
    await stat(path.join(workspaceDir, STATE_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子保存：先写同目录临时文件，再 rename 覆盖。
 * expectedRevision 必须等于磁盘上的当前版本，防止旧进程覆盖新状态。
 */
export async function saveState(
  workspaceDir: string,
  next: WorkspaceState,
  expectedRevision: number,
): Promise<WorkspaceState> {
  const file = path.join(workspaceDir, STATE_FILE);
  let diskRevision: number | null = null;
  if (await stateExists(workspaceDir)) {
    const loaded = await loadState(workspaceDir);
    diskRevision = loaded.state.revision;
  }
  if (diskRevision !== null && diskRevision !== expectedRevision) {
    throw new WorkspaceError(
      `版本冲突：磁盘 revision=${diskRevision}，调用方持有 ${expectedRevision}。拒绝旧状态写入。`,
    );
  }
  if (diskRevision === null && expectedRevision !== 0) {
    throw new WorkspaceError(`新建状态必须从 revision=0 开始，收到 ${expectedRevision}`);
  }
  next.revision = expectedRevision + 1;
  next.updatedAt = new Date().toISOString();
  await mkdir(workspaceDir, { recursive: true });
  const tmp = path.join(workspaceDir, `.state.json.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, file);
  return next;
}

export function emptyState(goal: Goal): WorkspaceState {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    goal,
    phase: "assets",
    assets: [],
    artifacts: [],
    checkpoints: [],
    decisions: [],
    issues: [],
    nextAction: "登记素材：使用 ingest 命令逐段登记公开视频。",
    updatedAt: new Date().toISOString(),
  };
}

export function nextId(prefix: string, existing: readonly { id: string }[]): string {
  let max = 0;
  for (const item of existing) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(item.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

/**
 * 登记草稿产物：计算指纹，状态为 draft。
 * 产物文件必须已存在且非空；路径保存为相对工作区的路径。
 */
export async function registerArtifact(
  loaded: LoadedState,
  input: {
    kind: ArtifactRecord["kind"];
    file: string;
    basedOn: string[];
    status?: ArtifactRecord["status"];
  },
): Promise<ArtifactRecord> {
  const absolute = path.resolve(loaded.dir, input.file);
  const info = await stat(absolute).catch(() => null);
  if (!info || !info.isFile() || info.size === 0) {
    throw new WorkspaceError(`产物文件不存在或为空：${absolute}`);
  }
  const relative = path.relative(loaded.dir, absolute);
  const record: ArtifactRecord = {
    id: nextId("artifact", loaded.state.artifacts),
    kind: input.kind,
    path: relative,
    sha256: await sha256File(absolute),
    createdAt: new Date().toISOString(),
    basedOn: input.basedOn,
    status: input.status ?? "draft",
  };
  return record;
}

export interface CheckpointResult {
  state: WorkspaceState;
  checkpoint: CheckpointRecord;
  directory: string;
}

/**
 * 创建检查点：把引用的产物复制到 checkpoints/<id>/，之后该目录不再修改。
 * 传入 reportPaths 时，把 evidence 下的检查报告 JSON 一并冻结进检查点目录，
 * 并在 manifest 登记 reports 数组（报告属检查点材料的固定部分，spec F5/AC4）。
 * 重复提交时先核对已有指纹；不同内容会报错，不会覆盖旧版本。
 */
export async function createCheckpoint(
  loaded: LoadedState,
  input: {
    phase: CheckpointRecord["phase"];
    artifactIds: string[];
    summary: string;
    nextAction: string;
    review?: CheckpointRecord["review"];
    feedback?: string;
    /** 检查报告 JSON 的绝对或工作区相对路径；缺省时不冻结报告，行为与旧版完全一致。 */
    reportPaths?: string[];
  },
): Promise<CheckpointResult> {
  const phase = loaded.state.phase;
  if (phase !== input.phase) {
    throw new WorkspaceError(`当前阶段为 ${phase}，不能提交 ${input.phase} 检查点`);
  }
  const byId = new Map(loaded.state.artifacts.map((a) => [a.id, a]));
  for (const id of input.artifactIds) {
    if (!byId.has(id)) throw new WorkspaceError(`检查点引用的产物 ${id} 不存在`);
  }
  const checkpoint: CheckpointRecord = {
    id: nextId("checkpoint", loaded.state.checkpoints),
    phase: input.phase,
    createdAt: new Date().toISOString(),
    artifactIds: [...input.artifactIds],
    summary: input.summary,
    nextAction: input.nextAction,
    review: input.review ?? "pending",
    ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
  };
  const directory = path.join("checkpoints", checkpoint.id);
  const absoluteDir = path.join(loaded.dir, directory);
  await mkdir(path.dirname(absoluteDir), { recursive: true });
  await mkdir(absoluteDir, { recursive: false }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "EEXIST") {
      throw new WorkspaceError(`检查点目录 ${directory} 已存在，拒绝覆盖`);
    }
    throw err;
  });
  // 复制并立即核对指纹：复制不完整时删除目录并报错。
  for (const id of checkpoint.artifactIds) {
    const artifact = byId.get(id)!;
    const source = workspacePath(loaded.dir, artifact.path);
    const copied = path.join(absoluteDir, path.basename(artifact.path));
    await cp(source, copied);
    const hash = await sha256File(copied);
    if (hash !== artifact.sha256) {
      await rm(absoluteDir, { recursive: true, force: true });
      throw new WorkspaceError(`检查点副本指纹不符（${id}），已回滚`);
    }
  }
  // 冻结检查报告：逐份复制进检查点目录并核对指纹；
  // 材料缺失、文件名重复或复制不完整都属于材料不齐，整体回滚并报错（不静默跳过）。
  const reports: { file: string; sha256: string }[] = [];
  if (input.reportPaths !== undefined) {
    const seen = new Set<string>();
    for (const reportPath of input.reportPaths) {
      const source = workspacePath(loaded.dir, reportPath);
      const info = await stat(source).catch(() => null);
      if (!info || !info.isFile()) {
        await rm(absoluteDir, { recursive: true, force: true });
        throw new WorkspaceError(`检查点引用的检查报告缺失或不是文件：${reportPath}`);
      }
      const name = path.basename(source);
      if (seen.has(name)) {
        await rm(absoluteDir, { recursive: true, force: true });
        throw new WorkspaceError(`检查报告文件名重复（${name}），会在检查点目录内相互覆盖，已回滚`);
      }
      seen.add(name);
      const copied = path.join(absoluteDir, name);
      await cp(source, copied);
      const copiedHash = await sha256File(copied);
      const sourceHash = await sha256File(source);
      if (copiedHash !== sourceHash) {
        await rm(absoluteDir, { recursive: true, force: true });
        throw new WorkspaceError(`检查点检查报告副本指纹不符（${name}），已回滚`);
      }
      reports.push({ file: name, sha256: copiedHash });
    }
  }
  // 摘要与指纹清单，供脱离会话后审计。
  const manifest = {
    checkpoint,
    artifacts: checkpoint.artifactIds.map((aid) => {
      const a = byId.get(aid)!;
      return { id: a.id, kind: a.kind, file: path.basename(a.path), sha256: a.sha256 };
    }),
    // 未传 reportPaths 时不写 reports 字段，保持旧 manifest 结构不变。
    ...(input.reportPaths !== undefined ? { reports } : {}),
  };
  await writeFile(path.join(absoluteDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  loaded.state.checkpoints.push(checkpoint);
  return { state: loaded.state, checkpoint, directory };
}

/** 恢复时逐项核对产物指纹；不符或缺失时返回问题清单。
 *  同一路径存在多条记录时（重开版本后旧记录保留为历史），只核对最新一条。 */
export async function auditArtifacts(loaded: LoadedState): Promise<
  { artifact: ArtifactRecord; problem: string }[]
> {
  const latestByPath = new Map<string, ArtifactRecord>();
  for (const artifact of loaded.state.artifacts) {
    const existing = latestByPath.get(artifact.path);
    if (!existing || artifact.createdAt >= existing.createdAt) {
      latestByPath.set(artifact.path, artifact);
    }
  }
  const problems: { artifact: ArtifactRecord; problem: string }[] = [];
  for (const artifact of latestByPath.values()) {
    const file = workspacePath(loaded.dir, artifact.path);
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      problems.push({ artifact, problem: `文件缺失：${artifact.path}` });
      continue;
    }
    const hash = await sha256File(file);
    if (hash !== artifact.sha256) {
      problems.push({ artifact, problem: `指纹变化：${artifact.path}` });
    }
  }
  return problems;
}

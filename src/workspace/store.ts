import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SCHEMA_VERSION,
  migrateStateV1,
  type ArtifactRecord,
  type CheckpointRecord,
  type WorkspaceState,
} from "../domain.ts";

export const STATE_FILE = "state.json";

export class WorkspaceError extends Error {}

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

export function emptyState(title: string): WorkspaceState {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    goal: {
      title,
      theme: "（未配置：等待任务配置接入）",
      minFrames: 900,
      maxFrames: 1800,
      outputSpec: { width: 1920, height: 1080, fps: 30 },
      moodArc: [],
    },
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
    // 摘要与指纹清单，供脱离会话后审计。
    const manifest = {
      checkpoint,
      artifacts: checkpoint.artifactIds.map((aid) => {
        const a = byId.get(aid)!;
        return { id: a.id, kind: a.kind, file: path.basename(a.path), sha256: a.sha256 };
      }),
    };
    await writeFile(path.join(absoluteDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }
  loaded.state.checkpoints.push(checkpoint);
  return { state: loaded.state, checkpoint, directory };
}

/** 恢复时逐项核对产物指纹；不符或缺失时返回问题清单。 */
export async function auditArtifacts(loaded: LoadedState): Promise<
  { artifact: ArtifactRecord; problem: string }[]
> {
  const problems: { artifact: ArtifactRecord; problem: string }[] = [];
  for (const artifact of loaded.state.artifacts) {
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

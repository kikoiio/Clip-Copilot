/**
 * 内嵌监测宿主（spec F5；plan.md 的 monitor-host.ts 模块）。
 * 每个工作区独立一路现有 watchWorkspaces——运行锁互斥由锁本身保证，
 * 启动前显式探测同一把运行锁，让「GUI 与 CLI monitor run 冲突」得到确定性提示。
 * 轮询差分监测记录后把建议变化推给界面；不修改监测引擎的任何行为。
 */
import path from "node:path";
import { watchWorkspaces } from "../monitor/engine.ts";
import { acquireMonitorRunLock, loadMonitorState, type MonitorRunLock } from "../monitor/store.ts";
import type { MonitorMetrics, MonitorState, SuggestionRecord } from "../monitor/types.ts";

export interface MonitorHostEntry {
  dir: string;
  running: boolean;
  error?: string;
}

export interface MonitorUpdate {
  dir: string;
  suggestions: SuggestionRecord[];
  metrics: MonitorMetrics | null;
  /** 监测进程启动失败或运行中报错时的可读原因。 */
  error?: string;
}

export type MonitorListener = (update: MonitorUpdate) => void;

export type WorkspaceWatcher = (dirs: string[], signal: AbortSignal) => Promise<void>;

export interface MonitorHostOptions {
  /** 轮询监测记录的间隔，默认 5s（与引擎 10s reconcile 定时器匹配）。 */
  pollIntervalMs?: number;
  /** 监测记录读取器，测试可注入替身。 */
  loadMonitor?: (dir: string) => Promise<MonitorState>;
  /** 监测进程启动器，测试可注入替身；默认为现有引擎 watchWorkspaces。 */
  watch?: WorkspaceWatcher;
}

interface Session {
  dir: string;
  controller: AbortController;
  pollTimer?: NodeJS.Timeout;
  watchPromise?: Promise<void>;
  signature: string;
  error?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(errorMessage).join("；");
  }
  return error instanceof Error ? error.message : String(error);
}

export class MonitorHost {
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Set<MonitorListener>();
  readonly #pollIntervalMs: number;
  readonly #loadMonitor: (dir: string) => Promise<MonitorState>;
  readonly #watch: WorkspaceWatcher;

  constructor(options: MonitorHostOptions = {}) {
    this.#pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.#loadMonitor = options.loadMonitor ?? loadMonitorState;
    this.#watch = options.watch ?? ((dirs, signal) => watchWorkspaces(dirs, signal, {
      onWorkspaceError: (dir, error) => {
        this.#reportWorkspaceError(path.resolve(dir), error);
      },
    }));
  }

  /** 订阅建议变化推送；返回退订函数。 */
  onUpdate(listener: MonitorListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 开启一个工作区的监测；运行锁被占时返回 running:false 与可读原因，不抛出。 */
  async start(dir: string): Promise<MonitorHostEntry> {
    const resolved = path.resolve(dir);
    if (this.#sessions.has(resolved)) return this.#entry(resolved);

    // 与引擎共用同一把运行锁：先显式探测，把「已被 CLI monitor run 占用」变成
    // 确定性的失败条目（spec AC5），探测成功后立刻释放、由引擎重新获取。
    let probe: MonitorRunLock;
    try {
      probe = await acquireMonitorRunLock(resolved);
    } catch (error) {
      return { dir: resolved, running: false, error: errorMessage(error) };
    }
    await probe.release();

    const controller = new AbortController();
    const session: Session = { dir: resolved, controller, signature: "" };
    this.#sessions.set(resolved, session);
    session.watchPromise = this.#watch([resolved], controller.signal)
      .catch((error) => {
        // 启动失败（目录缺失等）或运行中止止后的清理失败：上报并移除会话。
        if (controller.signal.aborted) return;
        session.error = errorMessage(error);
        this.#sessions.delete(resolved);
        clearInterval(session.pollTimer);
        this.#emit({ dir: resolved, suggestions: [], metrics: null, error: session.error });
      });
    session.pollTimer = setInterval(() => {
      void this.#pollOnce(session);
    }, this.#pollIntervalMs);
    session.pollTimer.unref?.();
    // 立即推一次当前建议，界面开启后无需等下一个轮询周期。
    await this.#pollOnce(session);
    return this.#entry(resolved);
  }

  /** 停止一个工作区的监测并等待运行锁释放（之后 CLI 可立即接管）。 */
  async stop(dir: string): Promise<MonitorHostEntry> {
    const resolved = path.resolve(dir);
    const session = this.#sessions.get(resolved);
    if (!session) return { dir: resolved, running: false };
    clearInterval(session.pollTimer);
    session.controller.abort();
    await session.watchPromise?.catch(() => {});
    this.#sessions.delete(resolved);
    return { dir: resolved, running: false };
  }

  list(): MonitorHostEntry[] {
    return [...this.#sessions.keys()].map((dir) => this.#entry(dir));
  }

  /** 停止全部监测并等待所有锁释放；应用退出时调用。 */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#sessions.keys()].map((dir) => this.stop(dir)));
  }

  #entry(dir: string): MonitorHostEntry {
    const session = this.#sessions.get(dir);
    if (!session) return { dir, running: false };
    return session.error !== undefined
      ? { dir, running: false, error: session.error }
      : { dir, running: true };
  }

  async #pollOnce(session: Session): Promise<void> {
    let state: MonitorState;
    try {
      state = await this.#loadMonitor(session.dir);
    } catch {
      // 单次读取失败（文件被占用/损坏）静默跳过，下个周期重试。
      return;
    }
    const signature = JSON.stringify({
      suggestions: state.suggestions.map((item) => [item.key, item.status]),
      metrics: state.metrics,
      config: state.config,
    });
    if (signature === session.signature) return;
    session.signature = signature;
    this.#emit({ dir: session.dir, suggestions: state.suggestions, metrics: state.metrics });
  }

  #reportWorkspaceError(resolvedDir: string, error: unknown): void {
    const session = this.#sessions.get(resolvedDir);
    const message = errorMessage(error);
    if (session && session.error === undefined) session.error = message;
    this.#emit({ dir: resolvedDir, suggestions: [], metrics: null, error: message });
  }

  #emit(update: MonitorUpdate): void {
    for (const listener of this.#listeners) {
      try {
        listener(update);
      } catch {
        // 单个监听器异常不影响其他订阅者与轮询循环。
      }
    }
  }
}

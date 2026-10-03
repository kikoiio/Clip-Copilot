/**
 * 分层感知引擎（阶段 5 task T5；plan.md「src/sense/engine.ts」）。
 * 合成「实例观测 + 自动保存 glob」为每工作区 WorkspaceSoftwareState，
 * 差分推送变化（与 MonitorHost 推送同型）；只保留当前状态（N4 资源边界）。
 */
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapInstances, collectProjectBasenames } from "./mapping.ts";
import { readCmdlineProjectPath, type InstanceApp, type SpiSource } from "./atspi.ts";
import type { SenseUpdate, SoftwareInstance, WorkspaceSoftwareState } from "./types.ts";

export interface SenseEngineOptions {
  source: SpiSource;
  /** 工作区根目录。 */
  workspacesRoot: string;
  /** 工作区目录列表的读取回调（随工作区增删动态读取）。 */
  listWorkspaceDirs: () => string[];
  /** 缓存根（Kdenlive stalefiles 探测），默认按 XDG_CACHE_HOME/~/.cache 级联。 */
  cacheRoot?: string;
}

export interface EngineSnapshot {
  states: Map<string, WorkspaceSoftwareState>;
  /** 观测到但未能映射到工作区的实例（知与不知的「不知道」部分）。 */
  unmapped: SoftwareInstance[];
  /** 全局降级（如 AT-SPI 不可用）；per-state 降级另见各 state.degraded。 */
  globalDegraded: string[];
}

export class SenseEngine {
  readonly #options: SenseEngineOptions;
  #started = false;
  #closed = false;
  #states = new Map<string, WorkspaceSoftwareState>();
  #knownDirs = new Set<string>();
  #unmapped: SoftwareInstance[] = [];
  #listeners = new Set<(update: SenseUpdate) => void>();

  constructor(options: SenseEngineOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#options.source.start((apps) => {
      if (!this.#closed) this.#ingest(apps);
    }).then(() => {
      // 助手在首个有效快照前退出时也发布明确降级状态，而不是让界面误显示为未启用。
      if (!this.#closed && this.#options.source.degradedReason()) this.#ingest([]);
    }).catch(() => {
      if (!this.#closed) this.#ingest([]);
    });
  }

  async stop(): Promise<void> {
    this.#closed = true;
    this.#listeners.clear();
    await this.#options.source.stop();
  }

  onChange(listener: (update: SenseUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getState(dir: string): WorkspaceSoftwareState | null {
    return this.#states.get(dir) ?? null;
  }

  snapshot(): EngineSnapshot {
    const globalDegraded: string[] = [];
    const reason = this.#options.source.degradedReason();
    if (reason) globalDegraded.push(reason);
    return { states: new Map(this.#states), unmapped: [...this.#unmapped], globalDegraded };
  }

  #ingest(apps: InstanceApp[]): void {
    const root = this.#options.workspacesRoot;
    const dirs = this.#options.listWorkspaceDirs();
    const basenames = new Map<string, Set<string>>();
    for (const dir of dirs) basenames.set(dir, collectProjectBasenames(dir));

    const observations = apps.map((app) => ({
      pid: app.pid,
      title: app.title,
      focused: app.focused,
      cmdlineProjectPath: readCmdlineProjectPath(app.pid),
    }));
    const resolutions = mapInstances(observations, root, basenames);

    // 按工作区聚合实例
    const byDir = new Map<string, SoftwareInstance[]>();
    const ambiguousDirs = new Set<string>();
    this.#unmapped = [];
    for (const resolution of resolutions) {
      if (resolution.unresolvedReason === "ambiguous" && resolution.parsed) {
        for (const [dir, names] of basenames) if (names.has(resolution.parsed.basename)) ambiguousDirs.add(dir);
      }
      if (!resolution.parsed) continue;
      if (!resolution.workspaceDir) {
        this.#unmapped.push({
          pid: resolution.observation.pid,
          projectBasename: resolution.parsed.basename,
          projectPath: null,
          dirty: resolution.parsed.dirty,
          focused: resolution.observation.focused,
        });
        continue;
      }
      const instances = byDir.get(resolution.workspaceDir) ?? [];
      instances.push({
        pid: resolution.observation.pid,
        projectBasename: resolution.parsed.basename,
        projectPath:
          resolution.matchedBy === "cmdline"
            ? path.resolve(resolution.observation.cmdlineProjectPath!)
            : resolution.workspaceDir && resolution.parsed
              ? path.join(resolution.workspaceDir, "projects", `${resolution.parsed.basename}.kdenlive`)
              : null,
        dirty: resolution.parsed.dirty,
        focused: resolution.observation.focused,
      });
      byDir.set(resolution.workspaceDir, instances);
    }

    // 涉及目录 = 本轮有实例的目录 ∪ 上轮有状态但现在可能已退出的目录
    // 每轮为所有工作区发布运行/未运行状态；这样空桌面也能明确显示「未运行」。
    const touched = new Set<string>([...dirs, ...byDir.keys(), ...this.#knownDirs]);
    const cacheDirs = this.#stalefilesDirs();

    for (const dir of touched) {
      const instances = byDir.get(dir) ?? [];
      const running = instances.length > 0;
      const degraded: string[] = [];
      if (ambiguousDirs.has(dir)) degraded.push("project-mapping-ambiguous");
      const sourceDegraded = this.#options.source.degradedReason();
      if (sourceDegraded) degraded.push(sourceDegraded);
      let unsavedSignal: boolean | null = null;
      let unsavedSource: WorkspaceSoftwareState["unsavedSource"] = null;

      if (running) {
        const dirtyFlags = instances.map((i) => i.dirty);
        if (dirtyFlags.some((d) => d === true)) {
          unsavedSignal = true;
          unsavedSource = "title";
        } else if (dirtyFlags.every((d) => d === false)) {
          unsavedSignal = false;
          unsavedSource = "title";
        } else {
          // 主信号不可读 → 次级信号（autosave glob）
          const probe = this.#detectAutosave(dir, basenames.get(dir)!);
          if (!probe.observable) degraded.push("autosave-unobservable");
          unsavedSignal = probe.present;
          unsavedSource = probe.present ? "autosave" : null;
        }
      }
      if (instances.some((i) => i.focused === null)) degraded.push("focus-unknown");
      if (instances.some((i) => i.pid === 0)) degraded.push("pid-unknown");

      const state: WorkspaceSoftwareState = {
        workspaceDir: dir,
        running,
        instances,
        unsavedSignal,
        unsavedSource,
        degraded,
        observedAt: new Date().toISOString(),
      };

      const previous = this.#states.get(dir);
      if (!previous || !statesEqual(previous, state)) {
        this.#states.set(dir, state);
        if (running) this.#knownDirs.add(dir);
        else this.#knownDirs.delete(dir);
        const update: SenseUpdate = { dir, state };
        for (const listener of this.#listeners) {
          try {
            listener(update);
          } catch {
            // 消费者异常不影响引擎
          }
        }
      }
    }
  }

  #stalefilesDirs(): string[] {
    const explicit = this.#options.cacheRoot;
    const fallbackRoot = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
    const candidates = explicit ? [explicit, path.join(explicit, "stalefiles")] : [fallbackRoot, path.join(fallbackRoot, "kdenlive", "stalefiles")];
    return candidates.filter((dir) => existsSync(dir));
  }

  #detectAutosave(workspaceDir: string, basenames: Set<string>): { present: boolean; observable: boolean } {
    for (const dir of this.#stalefilesDirs()) {
      try {
        const hit = readdirSync(dir).some(
          (f) => f.endsWith(".autosave") && basenames.has(f.slice(0, -".autosave".length)),
        );
        if (hit) return { present: true, observable: true };
      } catch {
        // 目录不可读 → 尝试下一个候选
      }
    }
    try {
      const adjacent = readdirSync(path.join(workspaceDir, "projects")).some((f) => f.endsWith(".autosave"));
      return { present: adjacent, observable: true };
    } catch {
      return { present: false, observable: false };
    }
  }
}

function statesEqual(a: WorkspaceSoftwareState, b: WorkspaceSoftwareState): boolean {
  return (
    a.running === b.running &&
    a.unsavedSignal === b.unsavedSignal &&
    a.unsavedSource === b.unsavedSource &&
    a.degraded.length === b.degraded.length &&
    a.degraded.every((item, i) => item === b.degraded[i]) &&
    a.instances.length === b.instances.length &&
    a.instances.every((instance, i) => {
      const other = b.instances[i]!;
      return (
        instance.pid === other.pid &&
        instance.projectBasename === other.projectBasename &&
        instance.projectPath === other.projectPath &&
        instance.dirty === other.dirty &&
        instance.focused === other.focused
      );
    })
  );
}

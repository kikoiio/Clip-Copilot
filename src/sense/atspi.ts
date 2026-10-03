/**
 * AT-SPI 助手进程管理（阶段 5 task T3；plan.md「src/sense/atspi.ts」）。
 * 职责：spawn spi-helper.py、NDJSON 编解码、cmdline 富化、不可用归一；
 * 解析与映射不在本层（见 mapping.ts）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SpiEvent } from "./types.ts";

export interface InstanceApp {
  pid: number;
  title: string;
  focused: boolean | null;
}

export interface SpiSource {
  /** 启动助手并进入观测；首次产出（或不可用）后 resolve。 */
  start(onInstances: (apps: InstanceApp[]) => void): Promise<void>;
  stop(): Promise<void>;
  /** 不可用原因；可用时为 null。 */
  degradedReason(): string | null;
}

export function helperPathForModule(moduleFile: string): string {
  const moduleDir = path.dirname(moduleFile);
  const adjacent = path.join(moduleDir, "spi-helper.py");
  if (existsSync(adjacent)) return adjacent;
  // tsc emits JavaScript under dist/ but does not copy the Python helper. In
  // this repository development layout, walk back to src/sense explicitly.
  return path.resolve(moduleDir, "../../../src/sense/spi-helper.py");
}

const HELPER_PATH = helperPathForModule(fileURLToPath(import.meta.url));

/** /proc/<pid>/cmdline 富化：读取启动参数里第一个 .kdenlive 路径（Linux 专用，失败为 null）。 */
export function readCmdlineProjectPath(pid: number): string | null {
  if (pid <= 0 || process.platform !== "linux") return null;
  try {
    // 同步读取可接受：单文件、百字节级、1s 轮询。
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const parts = raw.toString("utf8").split("\0").filter(Boolean);
    return parts.find((p) => p.endsWith(".kdenlive")) ?? null;
  } catch {
    return null;
  }
}

export class PythonSpiSource implements SpiSource {
  #child: ChildProcessWithoutNullStreams | null = null;
  #degraded: string | null = null;
  #helperPath: string;
  #pythonBin: string;

  constructor(opts: { helperPath?: string; pythonBin?: string } = {}) {
    this.#helperPath = opts.helperPath ?? HELPER_PATH;
    this.#pythonBin = opts.pythonBin ?? "python3";
  }

  async start(onInstances: (apps: InstanceApp[]) => void): Promise<void> {
    const child = spawn(this.#pythonBin, [this.#helperPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    let firstOutput: ((value: void) => void) | null = null;
    const firstReady = new Promise<void>((resolve) => {
      firstOutput = resolve;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // 调试信息走 stderr，仅透传到诊断，不污染协议。
      if (process.env.GUI_SENSE_DEBUG) process.stderr.write(`[spi-helper] ${chunk}`);
    });
    child.on("exit", (code, signal) => {
      if (this.#degraded === null) this.#degraded = `spi-helper-exited(code=${code ?? "null"},signal=${signal ?? "none"})`;
      this.#child = null;
      firstOutput?.();
    });
    child.on("error", (error) => {
      this.#degraded = `spi-helper-spawn-failed: ${error.message}`;
      this.#child = null;
      firstOutput?.();
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let event: SpiEvent;
      try {
        event = JSON.parse(trimmed) as SpiEvent;
      } catch {
        return; // 坏行容错：忽略，等待下一个合法事件
      }
      if (event.type === "error") {
        this.#degraded = event.reason;
        firstOutput?.();
        return;
      }
      if (event.type === "instances") {
        firstOutput?.();
        if (!Array.isArray(event.apps)) return;
        const valid = event.apps.filter((app) =>
          Number.isInteger(app.pid) && typeof app.title === "string" &&
          (typeof app.focused === "boolean" || app.focused === null));
        onInstances(valid);
        return;
      }
    });

    child.stdin.write(`${JSON.stringify({ cmd: "watch", intervalMs: 1000 })}\n`);
    await firstReady;
    if (this.#degraded) {
      // 不可用即终止助手，转降级路径
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      child.stdin.end();
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    forceKill.unref();
    await closed;
    clearTimeout(forceKill);
  }

  degradedReason(): string | null {
    return this.#degraded;
  }
}

export function createPythonSpiSource(opts?: { helperPath?: string; pythonBin?: string }): SpiSource {
  return new PythonSpiSource(opts);
}

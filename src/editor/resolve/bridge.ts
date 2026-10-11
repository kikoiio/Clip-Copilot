import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AdapterCallOptions } from "../contracts.ts";
import {
  makeProbeRequest,
  parseResolveProbeResponse,
  type ResolveProbeRequest,
  type ResolveProbeResponse,
} from "./protocol.ts";

export interface ResolveBridge {
  request(request: ResolveProbeRequest, options: AdapterCallOptions): Promise<ResolveProbeResponse>;
}

export interface ResolveProcessBridgeOptions {
  command?: string;
  probePath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** A one-shot stdin/stdout bridge. It never opens a network listener. */
export class ResolveProcessBridge implements ResolveBridge {
  private readonly command: string;
  private readonly probePath: string;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(options: ResolveProcessBridgeOptions = {}) {
    this.command = options.command ?? process.env.RESOLVE_PYTHON ?? "python3";
    this.probePath = options.probePath ?? defaultProbePath();
    this.cwd = options.cwd;
    this.env = options.env;
  }

  request(request: ResolveProbeRequest, options: AdapterCallOptions): Promise<ResolveProbeResponse> {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.command, [this.probePath], {
          cwd: this.cwd,
          env: { ...process.env, ...this.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        resolve(failure("offline", errorMessage(error), true));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => finish(failure("timeout", `Resolve probe timed out after ${timeoutMs}ms`, true), true), timeoutMs);
      const onAbort = (): void => finish(failure("timeout", "Resolve probe call was cancelled", true), true);
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (response: ResolveProbeResponse, kill: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (kill && child.exitCode === null) child.kill("SIGTERM");
        resolve(response);
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => finish(failure("offline", errorMessage(error), true), false));
      child.once("close", (code) => {
        if (settled) return;
        const text = stdout.trim();
        if (!text) {
          const reason = stderr.trim() || `Resolve probe exited with code ${String(code)}`;
          finish(failure(code === 0 ? "protocol" : "offline", reason, code !== 0), false);
          return;
        }
        try {
          const decoded: unknown = JSON.parse(text);
          finish(parseResolveProbeResponse(decoded, request.operation), false);
        } catch (error) {
          const detail = errorMessage(error);
          finish(failure("protocol", stderr.trim() ? `${detail}; ${stderr.trim()}` : detail, false), false);
        }
      });

      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      child.stdin?.end(`${JSON.stringify(request)}\n`);
    });
  }
}

export function createResolveProcessBridge(options: ResolveProcessBridgeOptions = {}): ResolveProcessBridge {
  return new ResolveProcessBridge(options);
}

export function resolveProbePath(): string {
  return defaultProbePath();
}

function defaultProbePath(): string {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  return path.join(sourceRoot, "probe.py");
}

function failure(
  kind: "offline" | "unsupported" | "protocol" | "timeout",
  reason: string,
  retryable: boolean,
): ResolveProbeResponse {
  return { ok: false, error: { kind, reason, retryable } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

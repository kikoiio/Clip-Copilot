import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** 单次进程调用的完整结果，包含可保存为证据的输出。 */
export interface RunResult {
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** 默认 30 分钟；与 plan.md 的渲染超时上限一致。 */
  timeoutMs?: number;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CAPTURE = 2 * 1024 * 1024;

/** 保留开头与结尾、丢弃中段，避免长时间渲染日志占满内存。 */
function cap(text: string): string {
  if (text.length <= MAX_CAPTURE) return text;
  const head = text.slice(0, MAX_CAPTURE / 2);
  const tail = text.slice(-MAX_CAPTURE / 2);
  return `${head}\n...[已省略 ${text.length - MAX_CAPTURE} 字节]...\n${tail}`;
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  return await new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout: cap(stdout),
        stderr: cap(stderr),
      });
    };
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += `\n[进程启动失败] ${String(err)}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}

export function assertOk(result: RunResult, what: string): RunResult {
  if (result.timedOut) {
    throw new Error(`${what} 超时（>${Math.round(result.durationMs / 1000)}s）`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} 失败：退出码 ${result.exitCode}\nstderr: ${result.stderr.slice(-2000)}`,
    );
  }
  return result;
}

export const LMMS_APPIMAGE =
  process.env.LMMS_APPIMAGE ??
  "/home/neo/Applications/lmms-1.2.2-linux-x86_64.AppImage";
export const KDENLIVE_APPIMAGE =
  process.env.KDENLIVE_APPIMAGE ??
  "/home/neo/Applications/kdenlive-26.08.1-x86_64.AppImage";

function appImageEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { APPIMAGE_EXTRACT_AND_RUN: "1", ...extra };
}

export function runLmms(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runProcess(LMMS_APPIMAGE, args, { ...options, env: appImageEnv(options.env) });
}

export function runKdenlive(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runProcess(KDENLIVE_APPIMAGE, args, {
    ...options,
    env: appImageEnv({ QT_QPA_PLATFORM: "offscreen", ...options.env }),
  });
}

export function runFfmpeg(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runProcess("ffmpeg", args, options);
}

export function runFfprobe(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runProcess("ffprobe", args, options);
}

/** 把一次调用的输出保存到证据目录，返回 JSON 文件路径。 */
export async function saveRunEvidence(
  evidenceDir: string,
  name: string,
  result: RunResult,
): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `${name}.json`);
  await writeFile(file, JSON.stringify(result, null, 2), "utf8");
  return file;
}

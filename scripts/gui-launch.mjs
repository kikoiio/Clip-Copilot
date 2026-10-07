import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function isSandboxFailure(stderr) {
  return /setuid_sandbox_host\.cc[^\n]*The SUID sandbox helper binary was found, but is not configured correctly/.test(stderr)
    || /Failed to move to new namespace:[^\n]*Operation not permitted/.test(stderr)
    || /zygote_host_impl_linux\.cc[^\n]*No usable sandbox!/.test(stderr);
}

// Keep the development workaround here, outside the packaged application.
export async function launchGui({
  executable,
  args = [],
  platform = process.platform,
  env = process.env,
  spawnProcess = spawn,
  signalSource = process,
  stderr = process.stderr,
} = {}) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  let child;
  let interrupted = false;
  const forwardSignal = (signal) => {
    interrupted = true;
    child?.kill(signal);
  };
  const onInt = () => forwardSignal("SIGINT");
  const onTerm = () => forwardSignal("SIGTERM");
  signalSource.on("SIGINT", onInt);
  signalSource.on("SIGTERM", onTerm);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let diagnostic = "";
      const childArgs = attempt === 0 ? [".", ...args] : ["--no-sandbox", ".", ...args];
      const result = await new Promise((resolve, reject) => {
        child = spawnProcess(executable, childArgs, {
          cwd: projectRoot,
          env: childEnv,
          stdio: ["inherit", "inherit", "pipe"],
        });
        child.stderr.on("data", (chunk) => {
          stderr.write(chunk);
          // Only startup diagnostics are needed; bound memory even for noisy apps.
          if (diagnostic.length < 65536) diagnostic += chunk.toString().slice(0, 65536 - diagnostic.length);
        });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const sandboxDisabled = args.includes("--no-sandbox");
      if (attempt !== 0 || result.code === 0 || interrupted || platform !== "linux"
          || sandboxDisabled || !isSandboxFailure(diagnostic)) return result;
      stderr.write("[gui] Linux 沙箱不可用，本地开发启动将使用 --no-sandbox 重试一次（Chromium 沙箱已关闭）。\n");
    }
  } finally {
    signalSource.removeListener("SIGINT", onInt);
    signalSource.removeListener("SIGTERM", onTerm);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const require = createRequire(import.meta.url);
    const result = await launchGui({ executable: require("electron"), args: process.argv.slice(2) });
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code ?? 1;
  } catch (error) {
    console.error(`[gui] Electron 启动失败：${error.message}`);
    process.exitCode = 1;
  }
}

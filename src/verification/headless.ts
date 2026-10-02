/**
 * 无界面「打开并处理」验证（阶段 3 模块 B，spec F3）。
 *
 * 用两款交付软件本身对工程文件做无界面渲染，验证「软件能打开并处理该工程」：
 * 工程**原位读取**，不复制工程——适配器 v2 的资源引用相对工程文件位置解析
 * （如 ../assets/...），复制必致引用全部失效、验证必然误报（与 spec F3 字面
 * 表述的偏差已随 plan 一并批准）；「不污染交付」的意图由「输出写 tmpDir +
 * finally 中删除」达成，成功与否都清理临时输出。
 *
 * 渲染参数形态与 renderScoreWav / renderVideoMp4 完全一致（刻意不直接复用那两个
 * 函数：它们失败时抛错，而本模块需要返回 fail 的 CheckResult）；成功判据亦同：
 * 退出码 0 且输出文件存在非空（LMMS 另要求大于 44 字节，即至少是有效 WAV 头）。
 * 失败 / 超时 / 输出缺失 / 进程启动失败（AppImage 缺失等）一律返回 fail 的
 * CheckResult，不抛异常——无界面验证是检查项，不是流程步骤。
 *
 * 接口契约见 docs/spec_docs/phase-3/plan.md 的「模块 B」。
 */

import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CheckResult } from "../domain.ts";
import {
  KDENLIVE_APPIMAGE,
  LMMS_APPIMAGE,
  runKdenlive,
  runLmms,
  saveRunEvidence,
  type RunResult,
} from "../infra/process.ts";
import { DEEP_CHECK_DEFAULTS } from "./deep.ts";

/** 工具标识（N3 可追溯）：与 AppImage 文件名中的版本对应。 */
const LMMS_TOOL = "LMMS 1.2.2 AppImage";
const KDENLIVE_TOOL = "Kdenlive 26.08.1 AppImage";

/** argv 拼接成可复现的命令行文本；含空白的部分加引号。 */
function argvText(argv0: string, args: string[]): string {
  return [argv0, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/**
 * 失败证据明细：进程启动失败单独点出（AppImage 缺失时 runProcess 会把
 * 「[进程启动失败]」写进 stderr），后跟退出码、是否超时、输出状态、耗时与
 * stderr 尾部（约 500 字符，足以定位而不过量）。
 */
function failDetails(run: RunResult, outputBytes: number | null, expectText: string): string {
  const startup = run.stderr.includes("[进程启动失败]");
  const output = outputBytes === null ? "缺失" : `${outputBytes}B`;
  return [
    startup ? "进程启动失败" : "渲染失败",
    `退出码 ${run.exitCode}`,
    run.timedOut ? "已超时" : "未超时",
    `输出 ${output}（判据：${expectText}）`,
    `耗时 ${(run.durationMs / 1000).toFixed(1)}s`,
    `stderr 尾部: ${run.stderr.slice(-500) || "（空）"}`,
  ].join("，");
}

/** 输出文件信息：存在且是文件时返回字节数，否则 null。 */
async function outputBytesOrNull(file: string): Promise<number | null> {
  const info = await stat(file).catch(() => null);
  return info !== null && info.isFile() ? info.size : null;
}

/** LMMS 无界面验证：原位渲染工程为 WAV，成功返回 pass，其余一律 fail。 */
export async function headlessValidateLmmsProject(
  projectFile: string,
  tmpDir: string,
  evidenceDir?: string,
): Promise<CheckResult> {
  // 输出带 pid 与时间戳，避免同目录并发验证互相覆盖。
  const tmpOut = path.join(tmpDir, `lmms-headless-${process.pid}-${Date.now()}.wav`);
  // 参数形态与 renderScoreWav 一致；-l 让导出止于内容结尾（不渲染垫尾小节）。
  const args = ["render", projectFile, "-f", "wav", "-o", tmpOut, "-s", "44100", "-l"];
  const command = argvText(LMMS_APPIMAGE, args);
  const threshold = `退出码 0 且 ${DEEP_CHECK_DEFAULTS.headlessTimeoutMs}ms 内完成、输出 WAV 大于 44 字节`;
  try {
    const run = await runLmms(args, { timeoutMs: DEEP_CHECK_DEFAULTS.headlessTimeoutMs });
    if (evidenceDir) {
      await saveRunEvidence(evidenceDir, "lmms-headless-validate", run);
    }
    const bytes = await outputBytesOrNull(tmpOut);
    if (run.exitCode === 0 && bytes !== null && bytes > 44) {
      return {
        id: "headless:lmms",
        status: "pass",
        evidence: `LMMS 无界面渲染通过：输出 ${bytes}B，耗时 ${(run.durationMs / 1000).toFixed(1)}s`,
        threshold,
        command,
        tool: LMMS_TOOL,
      };
    }
    return {
      id: "headless:lmms",
      status: "fail",
      evidence: `LMMS 无界面验证失败：${failDetails(run, bytes, "WAV > 44 字节")}`,
      threshold,
      command,
      tool: LMMS_TOOL,
    };
  } catch (err) {
    return {
      id: "headless:lmms",
      status: "fail",
      evidence: `LMMS 无界面验证异常：${err instanceof Error ? err.message : String(err)}`,
      threshold,
      command,
      tool: LMMS_TOOL,
    };
  } finally {
    // 成功与否都删除临时输出（spec F3：不污染交付）。
    await rm(tmpOut, { force: true });
  }
}

/** Kdenlive 无界面验证：原位渲染工程为 MP4，成功返回 pass，其余一律 fail。 */
export async function headlessValidateKdenliveProject(
  projectFile: string,
  tmpDir: string,
  evidenceDir?: string,
): Promise<CheckResult> {
  const tmpOut = path.join(tmpDir, `kdenlive-headless-${process.pid}-${Date.now()}.mp4`);
  // 参数形态与 renderVideoMp4 一致（默认 MP4-H264/AAC 预设）。
  const args = [projectFile, tmpOut, "--render"];
  const command = argvText(KDENLIVE_APPIMAGE, args);
  const threshold = `退出码 0 且 ${DEEP_CHECK_DEFAULTS.headlessTimeoutMs}ms 内完成、输出 MP4 非空`;
  try {
    const run = await runKdenlive(args, { timeoutMs: DEEP_CHECK_DEFAULTS.headlessTimeoutMs });
    if (evidenceDir) {
      await saveRunEvidence(evidenceDir, "kdenlive-headless-validate", run);
    }
    const bytes = await outputBytesOrNull(tmpOut);
    if (run.exitCode === 0 && bytes !== null && bytes > 0) {
      return {
        id: "headless:kdenlive",
        status: "pass",
        evidence: `Kdenlive 无界面渲染通过：输出 ${bytes}B，耗时 ${(run.durationMs / 1000).toFixed(1)}s`,
        threshold,
        command,
        tool: KDENLIVE_TOOL,
      };
    }
    return {
      id: "headless:kdenlive",
      status: "fail",
      evidence: `Kdenlive 无界面验证失败：${failDetails(run, bytes, "MP4 非空")}`,
      threshold,
      command,
      tool: KDENLIVE_TOOL,
    };
  } catch (err) {
    return {
      id: "headless:kdenlive",
      status: "fail",
      evidence: `Kdenlive 无界面验证异常：${err instanceof Error ? err.message : String(err)}`,
      threshold,
      command,
      tool: KDENLIVE_TOOL,
    };
  } finally {
    // 成功与否都删除临时输出（spec F3：不污染交付）。
    await rm(tmpOut, { force: true });
  }
}

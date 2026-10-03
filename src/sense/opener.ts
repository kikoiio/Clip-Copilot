/**
 * 授权操作「打开工程」（阶段 5 F6；plan.md opener.ts）。
 * 语义：经确认卡批准后，以工程路径 spawn Kdenlive（新实例）——可靠、可留痕、零软件内写入；
 * 该工作区已有实例运行时报告现状，不重复打开；失败零副作用。
 */
import { readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { KDENLIVE_APPIMAGE } from "../infra/process.ts";

export interface OpenOutcome {
  ok: boolean;
  /** 人可读结果（回填确认流/对话）。 */
  message: string;
  pid?: number;
}

export interface OpenProjectOptions {
  /** 工作区当前软件实例（来自感知引擎）；空数组=未运行。 */
  runningInstances: { projectPath: string | null; projectBasename: string }[];
  /** AppImage 路径；默认取 KDENLIVE_APPIMAGE 环境解析。 */
  appImagePath?: string;
  /** spawn 替身（测试注入）。 */
  spawnImpl?: typeof spawn;
  /** 时间源（测试注入）。 */
  now?: () => Date;
}

/** 解析工作区最新的工程文件（mtime 最大）。 */
export async function latestProject(workspaceDir: string): Promise<string | null> {
  const projectsDir = path.join(workspaceDir, "projects");
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".kdenlive")) continue;
    try {
      const info = await stat(path.join(projectsDir, entry));
      if (!best || info.mtimeMs > best.mtime) best = { file: entry, mtime: info.mtimeMs };
    } catch {
      // 单个文件 stat 失败跳过
    }
  }
  return best ? path.join(projectsDir, best.file) : null;
}

/** 执行授权「打开工程」。调用前必须已走确认流（本函数不做确认）。 */
export async function openProjectInKdenlive(workspaceDir: string, options: OpenProjectOptions): Promise<OpenOutcome> {
  // 已有实例运行：报告现状，不重复打开（plan.md 契约）。
  if (options.runningInstances.length > 0) {
    const describe = options.runningInstances
      .map((i) => `工程 ${i.projectBasename}${i.projectPath ? `（${i.projectPath}）` : "（路径未知）"}`)
      .join("；");
    return { ok: true, message: `Kdenlive 已在运行该工作区工程：${describe}。未重复打开。` };
  }

  const project = await latestProject(workspaceDir);
  if (!project) {
    return { ok: false, message: `工作区 ${workspaceDir} 的 projects/ 下没有 .kdenlive 工程，无法打开。` };
  }

  const appImage = options.appImagePath ?? KDENLIVE_APPIMAGE;
  const spawnImpl = options.spawnImpl ?? spawn;
  let pid: number;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnImpl(appImage, [project], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
        QT_ACCESSIBILITY: "1",
      },
    });
  } catch (error) {
    return { ok: false, message: `Kdenlive 打开失败：${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    return { ok: false, message: `Kdenlive 打开失败：${error instanceof Error ? error.message : String(error)}` };
  }
  pid = child.pid ?? 0;
  if (pid === 0) {
    return { ok: false, message: `Kdenlive 打开失败：进程未启动（AppImage 路径 ${appImage}）` };
  }
  child.unref();

  const recorded = await writeEvidence(workspaceDir, { action: "open_project", project, appImage, pid, at: (options.now ?? (() => new Date()))().toISOString() });
  return {
    ok: true,
    message: `已在 Kdenlive 中打开工程：${path.basename(project)}（pid ${pid}）。${recorded ? "操作记录已保存。" : "警告：工程已打开，但操作记录写入失败。"}`,
    pid,
  };
}

async function writeEvidence(workspaceDir: string, record: Record<string, unknown>): Promise<boolean> {
  const evidenceDir = path.join(workspaceDir, "evidence");
  try {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, `software-open-${Date.now()}.json`), JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

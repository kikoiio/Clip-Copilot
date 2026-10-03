/**
 * 实例→工作区映射（阶段 5 F1；plan.md 映射契约，纯函数便于单测）。
 *
 * 标题契约（探针实测）：`<工程basename> * / <profile> — Kdenlive`，`*` 为未保存脏标记。
 * 绑定优先级：cmdline 工程路径落在工作区目录内 → 直接绑定；
 * 否则 basename 与工作区 `projects/<basename>.kdenlive` 唯一匹配；多义/未匹配不猜。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SpiObservation } from "./types.ts";

export interface ParsedTitle {
  basename: string;
  dirty: boolean | null;
}

/** 解析 Kdenlive 主窗口标题；非主窗口（Offscreen 等）返回 null。 */
export function parseTitle(title: string): ParsedTitle | null {
  if (!title.includes("Kdenlive")) return null;
  // `final */ HD 1080p 30 fps — Kdenlive` / `final / HD 1080p 30 fps — Kdenlive`
  const match = /^(?<base>.*?)\s*(?<dirty>\*)?\s*\/\s*(?<profile>.+?)\s*—\s*Kdenlive$/u.exec(title);
  if (match?.groups) {
    const basename = match.groups.base!.trim();
    if (basename === "") return null;
    return { basename, dirty: match.groups.dirty === "*" };
  }
  // Older/limited accessibility title variants may omit profile and dirty
  // marker; retain the basename but report dirty as unknown for autosave fallback.
  const reduced = /^(?<base>.+?)\s+—\s+Kdenlive$/u.exec(title);
  const basename = reduced?.groups?.base?.trim();
  return basename ? { basename, dirty: null } : null;
}

export type MatchedBy = "cmdline" | "basename" | null;

export interface InstanceResolution {
  observation: SpiObservation;
  parsed: ParsedTitle | null;
  /** 绑定到的工作区目录（绝对路径）；未绑定为 null。 */
  workspaceDir: string | null;
  matchedBy: MatchedBy;
  /** 绑定失败原因：ambiguous=basename 多义；unmatched=无匹配工程。 */
  unresolvedReason: "ambiguous" | "unmatched" | null;
}

/**
 * 把实例观测映射到工作区。
 * workspaceProjectBasenames: 工作区目录 → 其 projects/ 下现有 .kdenlive basename 集合。
 */
export function mapInstances(
  observations: SpiObservation[],
  workspacesRoot: string,
  workspaceProjectBasenames: Map<string, Set<string>>,
): InstanceResolution[] {
  return observations.map((observation) => {
    const parsed = parseTitle(observation.title);
    if (!parsed) {
      return { observation, parsed: null, workspaceDir: null, matchedBy: null, unresolvedReason: null };
    }
    // 1) cmdline 工程路径直接绑定：仅当其文件 basename 与标题一致（cmdline 是启动期
    //    参数，软件内「另开工程」后会陈旧；标题始终反映当前文档）。
    if (observation.cmdlineProjectPath) {
      const abs = path.resolve(observation.cmdlineProjectPath);
      const parent = path.dirname(path.dirname(abs)); // <root>/<dir>/projects/<file>
      if (
        parent.startsWith(`${workspacesRoot}${path.sep}`) &&
        workspaceProjectBasenames.has(parent) &&
        path.basename(abs, ".kdenlive") === parsed.basename
      ) {
        return { observation, parsed, workspaceDir: parent, matchedBy: "cmdline", unresolvedReason: null };
      }
    }
    // 2) basename 唯一匹配；多义不猜。
    const candidates = [...workspaceProjectBasenames.entries()]
      .filter(([, basenames]) => basenames.has(parsed.basename))
      .map(([dir]) => dir);
    if (candidates.length === 1) {
      const workspaceDir = candidates[0]!;
      return { observation, parsed, workspaceDir, matchedBy: "basename", unresolvedReason: null };
    }
    return {
      observation,
      parsed,
      workspaceDir: null,
      matchedBy: null,
      unresolvedReason: candidates.length > 1 ? "ambiguous" : "unmatched",
    };
  });
}

/** 收集工作区 projects/ 下的 .kdenlive basename 集合（目录不存在返回空集）。 */
export function collectProjectBasenames(workspaceDir: string): Set<string> {
  const projectsDir = path.join(workspaceDir, "projects");
  const out = new Set<string>();
  if (!existsSync(projectsDir)) return out;
  // 由 engine 注入 readdir 结果更利于测试；此处直接读目录（目录小、频率 1s 可接受）。
  try {
    for (const entry of readdirSync(projectsDir)) {
      if (entry.endsWith(".kdenlive")) out.add(entry.slice(0, -".kdenlive".length));
    }
  } catch {
    // 读取失败按空集处理，下一轮重试
  }
  return out;
}

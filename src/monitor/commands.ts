import path from "node:path";
import { loadState } from "../workspace/store.ts";
import { watchWorkspaces } from "./engine.ts";
import { syncHandoff } from "./repair.ts";
import { decideSuggestion } from "./suggestions.ts";
import { iterateMonitorHistory, loadMonitorState, updateMonitorState } from "./store.ts";
import type { MonitorScope, NotificationLevel } from "./types.ts";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少取值`);
  return value;
}

function workspace(args: string[]): string {
  const value = flag(args, "--workspace");
  if (!value) throw new Error("缺少 --workspace 参数");
  return path.resolve(value);
}

function workspaces(args: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--workspace 缺少取值");
      found.push(path.resolve(value));
      i++;
    }
  }
  if (found.length === 0) throw new Error("monitor run 至少需要一个 --workspace");
  const unique = [...new Set(found)];
  if (unique.length !== found.length) throw new Error("工作区重复指定");
  return unique;
}

function scopes(raw: string): MonitorScope[] {
  const allowed: MonitorScope[] = ["assets", "projects", "outputs", "evidence", "state"];
  const result = raw.split(",") as MonitorScope[];
  if (result.length === 0 || result.some((item) => !allowed.includes(item)) || new Set(result).size !== result.length) {
    throw new Error(`--scope 必须是互不重复的范围：${allowed.join(",")}`);
  }
  return result;
}

function notification(raw: string): NotificationLevel {
  if (raw !== "silent" && raw !== "important" && raw !== "all") {
    throw new Error("--notification 必须是 silent|important|all");
  }
  return raw;
}

async function run(args: string[]): Promise<number> {
  const dirs = workspaces(args);
  for (const dir of dirs) await loadState(dir);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log(`监测中：${dirs.join("、")}；按 Ctrl-C 停止`);
    await watchWorkspaces(dirs, controller.signal, {
      onWorkspaceError: (dir, error) => console.error(`[监测异常] ${dir}: ${error instanceof Error ? error.message : String(error)}`),
    });
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function config(args: string[]): Promise<number> {
  const dir = workspace(args);
  await loadState(dir);
  const scopeRaw = flag(args, "--scope");
  const levelRaw = flag(args, "--notification");
  const repairRaw = flag(args, "--auto-repair-handoff");
  if (repairRaw !== undefined && repairRaw !== "on" && repairRaw !== "off") {
    throw new Error("--auto-repair-handoff 必须是 on|off");
  }
  const parsedScopes = scopeRaw === undefined ? undefined : scopes(scopeRaw);
  const parsedLevel = levelRaw === undefined ? undefined : notification(levelRaw);
  const state = parsedScopes || parsedLevel || repairRaw
    ? await updateMonitorState(dir, (current) => {
      if (parsedScopes) current.config.scopes = parsedScopes;
      if (parsedLevel) current.config.notificationLevel = parsedLevel;
      if (repairRaw) current.config.autoRepairHandoff = repairRaw === "on";
      return current;
    })
    : await loadMonitorState(dir);
  console.log(JSON.stringify(state.config, null, 2));
  return 0;
}

async function suggestions(args: string[]): Promise<number> {
  const dir = workspace(args);
  const state = await loadMonitorState(dir);
  if (args.includes("--all")) {
    for await (const item of iterateMonitorHistory(dir)) {
      if (item.kind === "suggestion") console.log(JSON.stringify(item.record));
    }
    for (const item of state.suggestions) console.log(JSON.stringify(item));
  } else {
    console.log(JSON.stringify(state.suggestions.filter((item) => item.status !== "resolved"), null, 2));
  }
  return 0;
}

async function decide(args: string[]): Promise<number> {
  const dir = workspace(args);
  const id = flag(args, "--id");
  const decision = flag(args, "--decision");
  if (!id || (decision !== "acknowledge" && decision !== "ignore")) {
    throw new Error("需要 --id <建议ID> --decision acknowledge|ignore");
  }
  const state = await updateMonitorState(dir, (current) => decideSuggestion(current, id, decision));
  await syncHandoff(dir);
  console.log(JSON.stringify(state.suggestions.find((item) => item.id === id), null, 2));
  return 0;
}

async function metrics(args: string[]): Promise<number> {
  const state = await loadMonitorState(workspace(args));
  console.log(JSON.stringify(state.metrics, null, 2));
  return 0;
}

export async function cmdMonitor(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "run": return await run(rest);
    case "config": return await config(rest);
    case "suggestions": return await suggestions(rest);
    case "decide": return await decide(rest);
    case "metrics": return await metrics(rest);
    default: throw new Error("monitor 子命令：run|config|suggestions|decide|metrics");
  }
}

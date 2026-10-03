/**
 * IPC 路由装配（plan.md 的 ipc.ts 模块）：GuiApi 的每个方法对应一个
 * `gui:*` 通道；处理异常统一折叠为 { ok:false, error } 而非 reject。
 * 监测与 AI 的事件经 webContents.send 推送（main.ts 注入 send 回调）。
 */
import { ipcMain, shell } from "electron";
import path from "node:path";
import type { AiOrchestrator } from "./ai/orchestrator.ts";
import type { MonitorHost } from "./monitor-host.ts";
import { defaultWorkspacesRoot, getWorkspaceDetail, listWorkspaces } from "./read.ts";
import type { WriteActionSpec } from "./bridge.ts";
import { runAction } from "./bridge.ts";
import { PROVIDER_PRESETS, SettingsStore, type SaveProviderInput } from "./secrets.ts";

export interface GuiServices {
  settings: SettingsStore;
  host: MonitorHost;
  ai: AiOrchestrator;
  send: (channel: string, payload: unknown) => void;
}

const WRITE_ACTION_KINDS = new Set<WriteActionSpec["kind"]>([
  "render",
  "verify",
  "checkpoint",
  "review",
  "waive",
  "observe",
  "reopen",
  "monitor_config",
  "monitor_decide",
]);

function assertValidActionSpec(spec: unknown): WriteActionSpec {
  const candidate = spec as WriteActionSpec;
  if (
    candidate === null || typeof candidate !== "object" ||
    typeof candidate.kind !== "string" || !WRITE_ACTION_KINDS.has(candidate.kind) ||
    typeof candidate.label !== "string" ||
    !Array.isArray(candidate.argv) || !candidate.argv.every((item) => typeof item === "string") ||
    typeof candidate.effectHint !== "string"
  ) {
    throw new Error("动作描述不合法（kind/label/argv/effectHint）");
  }
  if (!candidate.argv.includes("--workspace")) {
    throw new Error("动作参数缺少 --workspace");
  }
  return candidate;
}

function mediaUrl(dir: string, relPath: string): string {
  const absolute = path.resolve(dir, relPath);
  const root = defaultWorkspacesRoot();
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("媒体路径必须位于 workspaces/ 目录内");
  }
  return `app://media/${encodeURIComponent(Buffer.from(absolute, "utf8").toString("base64url"))}`;
}

function statusOf(settings: SettingsStore) {
  return async () => {
    const current = await settings.getSettings();
    const active = current.providers.find((item) => item.id === current.activeProviderId);
    return { configured: active !== undefined, activeProvider: active?.preset ?? null };
  };
}

export function registerGuiIpc(services: GuiServices): void {
  const { settings, host, ai, send } = services;

  const handle = (channel: string, fn: (payload: never) => Promise<unknown> | unknown): void => {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      try {
        return { ok: true, value: await (fn as (p: unknown) => Promise<unknown> | unknown)(payload) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  };

  handle("gui:listWorkspaces", () => listWorkspaces());
  handle("gui:getWorkspace", (payload: { dir: string }) => getWorkspaceDetail(payload.dir));
  handle("gui:mediaUrl", (payload: { dir: string; relPath: string }) => mediaUrl(payload.dir, payload.relPath));
  handle("gui:revealInFolder", (payload: { absolutePath: string }) => {
    shell.showItemInFolder(payload.absolutePath);
    return true;
  });
  handle("gui:openPath", async (payload: { absolutePath: string }) => {
    if (!payload.absolutePath.startsWith(`${defaultWorkspacesRoot()}${path.sep}`)) {
      throw new Error("只能打开 workspaces/ 目录内的文件");
    }
    const error = await shell.openPath(payload.absolutePath);
    if (error) throw new Error(`系统打开失败：${error}`);
    return true;
  });
  handle("gui:runAction", async (payload: { spec: unknown }) => {
    const spec = assertValidActionSpec(payload.spec);
    return await runAction(spec);
  });

  handle("gui:monitorStart", (payload: { dir: string }) => host.start(payload.dir));
  handle("gui:monitorStop", (payload: { dir: string }) => host.stop(payload.dir));
  handle("gui:monitorList", () => host.list());

  // send 立即返回：完整回答可能持续数分钟，过程经 gui:aiEvent 推送。
  handle("gui:aiSend", (payload: { dir: string; text: string }) => {
    void ai.send(payload.dir, payload.text).catch(() => {});
    return true;
  });
  handle("gui:aiConfirm", (payload: { dir: string; confirmationId: string; approved: boolean }) =>
    ai.confirm(payload.dir, payload.confirmationId, payload.approved));
  handle("gui:aiCancel", (payload: { dir: string }) => {
    ai.cancel(payload.dir);
    return true;
  });
  handle("gui:aiHistory", (payload: { dir: string }) => ai.history(payload.dir));
  handle("gui:aiStatus", () => statusOf(settings)());

  handle("gui:getSettings", async () => ({
    settings: await settings.getSettings(),
    presets: PROVIDER_PRESETS,
  }));
  handle("gui:saveProvider", (payload: SaveProviderInput) => settings.saveProvider(payload));
  handle("gui:setActiveProvider", (payload: { id: string }) => settings.setActive(payload.id));

  host.onUpdate((update) => send("gui:monitorUpdate", update));
  ai.onUpdate((event) => send("gui:aiEvent", event));
}

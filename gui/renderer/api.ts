/** GuiApi 的渲染进程封装：invoke 结果解包（{ok,value,error} → 值或抛错）。 */
import type {
  ActionResult,
  AiEvent,
  AiStoredMessage,
  MonitorHostEntry,
  SaveProviderInput,
  Settings,
  WorkspaceDetail,
  WorkspaceSummary,
  WriteActionSpec,
} from "./types.ts";

interface IpcResponse<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

interface GuiBridge {
  invoke: (channel: string, payload?: unknown) => Promise<IpcResponse<unknown>>;
  onMonitorUpdate: (listener: (payload: unknown) => void) => () => void;
  onAiEvent: (listener: (payload: unknown) => void) => () => void;
}

declare global {
  interface Window {
    gui: GuiBridge;
  }
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const response = await window.gui.invoke(channel, payload);
  if (!response.ok) throw new Error(response.error ?? "未知错误");
  return response.value as T;
}

export const gui = {
  listWorkspaces: () => call<WorkspaceSummary[]>("gui:listWorkspaces"),
  getWorkspace: (dir: string) => call<WorkspaceDetail>("gui:getWorkspace", { dir }),
  mediaUrl: (dir: string, relPath: string) => call<string>("gui:mediaUrl", { dir, relPath }),
  revealInFolder: (absolutePath: string) => call<boolean>("gui:revealInFolder", { absolutePath }),
  openPath: (absolutePath: string) => call<boolean>("gui:openPath", { absolutePath }),
  runAction: (spec: WriteActionSpec) => call<ActionResult>("gui:runAction", { spec }),

  monitorStart: (dir: string) => call<MonitorHostEntry>("gui:monitorStart", { dir }),
  monitorStop: (dir: string) => call<MonitorHostEntry>("gui:monitorStop", { dir }),
  monitorList: () => call<MonitorHostEntry[]>("gui:monitorList"),

  aiSend: (dir: string, text: string) => call<boolean>("gui:aiSend", { dir, text }),
  aiConfirm: (dir: string, confirmationId: string, approved: boolean) =>
    call<boolean>("gui:aiConfirm", { dir, confirmationId, approved }),
  aiCancel: (dir: string) => call<boolean>("gui:aiCancel", { dir }),
  aiHistory: (dir: string) => call<AiStoredMessage[]>("gui:aiHistory", { dir }),
  aiStatus: () => call<{ configured: boolean; activeProvider: string | null }>("gui:aiStatus"),

  getSettings: () => call<{ settings: Settings; presets: import("./types.ts").ProviderPreset[] }>("gui:getSettings"),
  saveProvider: (input: SaveProviderInput) => call<Settings>("gui:saveProvider", input),
  setActiveProvider: (id: string) => call<Settings>("gui:setActiveProvider", { id }),

  onMonitorUpdate: (listener: (payload: import("./types.ts").MonitorUpdate) => void) =>
    window.gui.onMonitorUpdate(listener as (payload: unknown) => void),
  onAiEvent: (listener: (payload: AiEvent) => void) =>
    window.gui.onAiEvent(listener as (payload: unknown) => void),
};

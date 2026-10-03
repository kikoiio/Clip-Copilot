/**
 * 预加载脚本（plan.md 的 preload.ts 模块）：以最小面向暴露 GuiApi——
 * 单一 invoke 通道转发 + 两个事件订阅；所有校验在主进程侧完成。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Listener = (payload: unknown) => void;

function subscribe(channel: string, listener: Listener): () => void {
  const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

const api = {
  invoke: (channel: string, payload?: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> =>
    ipcRenderer.invoke(channel, payload),
  onMonitorUpdate: (listener: Listener): (() => void) => subscribe("gui:monitorUpdate", listener),
  onSenseUpdate: (listener: Listener): (() => void) => subscribe("gui:senseUpdate", listener),
  onAiEvent: (listener: Listener): (() => void) => subscribe("gui:aiEvent", listener),
};

contextBridge.exposeInMainWorld("gui", api);

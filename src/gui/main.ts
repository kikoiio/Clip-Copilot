import { app, BrowserWindow, net, protocol } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AiOrchestrator } from "./ai/orchestrator.ts";
import { MonitorHost } from "./monitor-host.ts";
import { registerGuiIpc } from "./ipc.ts";
import { defaultWorkspacesRoot } from "./read.ts";
import { defaultSecretBox, SettingsStore } from "./secrets.ts";

// dist/src/gui/main.js → dist/gui-renderer/index.html（构建产物布局见 gui/renderer/vite.config.ts）
const RENDERER_INDEX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../gui-renderer/index.html",
);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
  ".mmp": "text/plain; charset=utf-8",
  ".kdenlive": "text/plain; charset=utf-8",
};

function registerMediaProtocol(): void {
  const root = defaultWorkspacesRoot();
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "media") {
      return new Response("未知的 app:// 子路径", { status: 404 });
    }
    const absolute = Buffer.from(decodeURIComponent(url.pathname.slice(1)), "base64url").toString("utf8");
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      return new Response("媒体路径必须位于工作区目录内", { status: 403 });
    }
    const mime = MIME_BY_EXTENSION[path.extname(absolute).toLowerCase()] ?? "application/octet-stream";
    try {
      const response = await net.fetch(pathToFileURL(absolute).toString());
      return new Response(response.body, { status: response.status, headers: { "content-type": mime } });
    } catch (error) {
      return new Response(`读取媒体失败：${error instanceof Error ? error.message : String(error)}`, { status: 404 });
    }
  });
}

async function createWindow(preloadPath: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "AI 创作工作台",
    autoHideMenuBar: true,
    webPreferences: { preload: preloadPath },
  });
  // 开发钩子：GUI_TAB 指定初始页签（自动化截图检查用）。
  const initialTab = process.env.GUI_TAB;
  await win.loadFile(RENDERER_INDEX, initialTab ? { query: { tab: initialTab } } : undefined);
  return win;
}

const gotLock = app.requestSingleInstanceLock();
let runningHost: MonitorHost | undefined;
let runningAi: AiOrchestrator | undefined;
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.setName("ai-creation-workbench");
  app.whenReady().then(() => {
    void bootstrap();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
    });
  });
  app.on("window-all-closed", () => {
    app.quit();
  });
  app.on("before-quit", (event) => {
    // 优雅释放运行锁与 AI 会话；dispose 完成后再真正退出。
    if (!runningHost && !runningAi) return;
    event.preventDefault();
    void (async () => {
      await runningHost?.dispose();
      runningAi?.dispose();
      runningHost = undefined;
      runningAi = undefined;
      app.exit(0);
    })();
  });
}

async function bootstrap(): Promise<void> {
  if (runningHost) return; // activate 重复触发时只启动一次
  const userDataDir = app.getPath("userData");
  const preloadPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs");
  let secretBox;
  try {
    secretBox = await defaultSecretBox();
  } catch {
    secretBox = null; // safeStorage 不可用时按 N5 降级：密钥保存会在 UI 明确报错
  }
  const settings = new SettingsStore(userDataDir, secretBox);
  const host = new MonitorHost();
  const ai = new AiOrchestrator({
    settings,
    sessionsDir: path.join(userDataDir, "sessions"),
  });
  runningHost = host;
  runningAi = ai;

  registerMediaProtocol();
  const win = await createWindow(preloadPath);
  registerGuiIpc({
    settings,
    host,
    ai,
    send: (channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
}

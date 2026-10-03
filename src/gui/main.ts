import { app, BrowserWindow, protocol } from "electron";
import { createReadStream, existsSync, promises as fsp, readdirSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AiOrchestrator } from "./ai/orchestrator.ts";
import { MonitorHost } from "./monitor-host.ts";
import { registerGuiIpc } from "./ipc.ts";
import { defaultWorkspacesRoot, getWorkspaceDetail } from "./read.ts";
import { defaultSecretBox, SettingsStore } from "./secrets.ts";
import { setSoftwareGate, setSoftwareOpenHandler } from "./bridge.ts";
import { createPythonSpiSource } from "../sense/atspi.ts";
import { SenseEngine } from "../sense/engine.ts";
import { openProjectInKdenlive } from "../sense/opener.ts";

// app:// 必须在应用就绪前注册为特权协议：<video>/<audio> 的流式播放依赖
// stream（分段请求）与 standard（合法 URL 语义），否则媒体元素拿不到数据。
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

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
    const info = await fsp.stat(absolute).catch(() => null);
    if (!info?.isFile()) {
      return new Response("媒体文件不存在", { status: 404 });
    }
    const mime = MIME_BY_EXTENSION[path.extname(absolute).toLowerCase()] ?? "application/octet-stream";
    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
      // 视频拖动进度条依赖 206 分段响应；超界按 416 报告可用范围。
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      let start = match?.[1] ? Number(match[1]) : 0;
      let end = match?.[2] ? Number(match[2]) : info.size - 1;
      if (Number.isNaN(start) || start >= info.size) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${info.size}` } });
      }
      end = Math.min(Number.isNaN(end) ? info.size - 1 : end, info.size - 1);
      const partial = Readable.toWeb(createReadStream(absolute, { start, end })) as unknown as NonNullable<ConstructorParameters<typeof Response>[0]>;
      return new Response(partial, {
        status: 206,
        headers: {
          "content-type": mime,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${info.size}`,
          "accept-ranges": "bytes",
        },
      });
    }
    const body = Readable.toWeb(createReadStream(absolute)) as unknown as NonNullable<ConstructorParameters<typeof Response>[0]>;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": mime,
        "content-length": String(info.size),
        "accept-ranges": "bytes",
      },
    });
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
  // 开发钩子：GUI_TAB 指定初始页签，GUI_AUTOPLAY=1 自动选中可播放产物（自动化验证用）。
  const query: Record<string, string> = {};
  if (process.env.GUI_TAB) query.tab = process.env.GUI_TAB;
  if (process.env.GUI_AUTOPLAY) query.autoplay = process.env.GUI_AUTOPLAY;
  await win.loadFile(RENDERER_INDEX, Object.keys(query).length > 0 ? { query } : undefined);
  return win;
}

const gotLock = app.requestSingleInstanceLock();
let runningHost: MonitorHost | undefined;
let runningAi: AiOrchestrator | undefined;
let runningSense: SenseEngine | undefined;
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
    if (!runningHost && !runningAi && !runningSense) return;
    event.preventDefault();
    void (async () => {
      await runningHost?.dispose();
      runningAi?.dispose();
      await runningSense?.stop();
      runningHost = undefined;
      runningAi = undefined;
      runningSense = undefined;
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
  // 软件感知（阶段 5）：GUI_SENSE=off 或环境缺失时整体降级，其余功能不受影响。
  const workspacesRoot = defaultWorkspacesRoot();
  const sense = process.env.GUI_SENSE === "off"
    ? null
    : new SenseEngine({
        source: createPythonSpiSource(),
        workspacesRoot,
        listWorkspaceDirs: () =>
          readdirSync(workspacesRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(path.join(workspacesRoot, entry.name, "state.json")))
            .map((entry) => path.join(workspacesRoot, entry.name)),
      });
  runningSense = sense ?? undefined;
  sense?.start();

  // 冲突避让（F5）：写操作经命令桥单点检查软件占用；「打开工程」走授权执行器。
  setSoftwareGate(
    sense
      ? {
          occupied: (dir, kind) => {
            if (kind !== "render" && kind !== "checkpoint" && kind !== "reopen") return null;
            const state = sense.getState(path.resolve(dir));
            if (!state?.running && !state?.degraded.includes("project-mapping-ambiguous")) return null;
            return {
              instances: state.instances.map((i) => ({
                pid: i.pid,
                projectBasename: i.projectBasename,
                projectPath: i.projectPath,
              })),
            };
          },
        }
      : null,
  );
  setSoftwareOpenHandler(async (dir) => {
    if (!sense) {
      return { ok: false, message: "软件感知未启用，无法确认工程是否已在 Kdenlive 中打开；为避免重复启动，本次未执行。" };
    }
    const state = sense.getState(path.resolve(dir));
    if (!state || state.degraded.some((item) => item.startsWith("atspi-unavailable") || item.startsWith("spi-helper-") || item === "project-mapping-ambiguous")) {
      return { ok: false, message: "Kdenlive 当前状态未知或工程映射有歧义；为避免重复打开，本次未执行。" };
    }
    return openProjectInKdenlive(dir, { runningInstances: state.instances });
  });

  const host = new MonitorHost({
    // 通知时机门（F5/AC5）：创作软件窗口聚焦中 → 桌面通知降级为仅入清单。
    suppressDesktopNotification: () => {
      const snap = sense?.snapshot();
      if (!snap) return false;
      if (snap.unmapped.some((i) => i.focused === true)) return true;
      for (const state of snap.states.values()) {
        if (state.instances.some((i) => i.focused)) return true;
      }
      return false;
    },
  });
  const ai = new AiOrchestrator({
    settings,
    sessionsDir: path.join(userDataDir, "sessions"),
    readDetail: (dir) => getWorkspaceDetail(dir, sense?.getState(path.resolve(dir)) ?? null),
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
    sense: sense
      ? {
          getState: (dir) => sense.getState(path.resolve(dir)),
          onChange: (listener) => sense.onChange((update) => listener(update.dir)),
        }
      : undefined,
  });
}

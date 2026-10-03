import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/src/gui/main.js → dist/gui-renderer/index.html（构建产物布局见 gui/renderer/vite.config.ts）
const RENDERER_INDEX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../gui-renderer/index.html",
);

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "AI 创作工作台",
    autoHideMenuBar: true,
  });
  await win.loadFile(RENDERER_INDEX);
}

app.whenReady().then(() => {
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

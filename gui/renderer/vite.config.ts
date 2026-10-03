import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// root 固定在本目录，产物输出到 dist/gui-renderer/，供 Electron 主进程按相对路径加载。
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/gui-renderer",
    emptyOutDir: true,
  },
});

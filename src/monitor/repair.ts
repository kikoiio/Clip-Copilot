import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeHandoff } from "../workflow/coordinator.ts";
import { loadState } from "../workspace/store.ts";
import { reconcileSuggestions } from "./suggestions.ts";
import { loadMonitorState, updateMonitorState } from "./store.ts";
import type { RepairRecord } from "./types.ts";

const HANDOFF_KEY = "handoff_missing:handoff.md";

export async function syncHandoff(workspaceDir: string): Promise<void> {
  const file = path.join(workspaceDir, "handoff.md");
  const before = await stat(file).catch(() => undefined);
  if (before) {
    await writeHandoff(await loadState(workspaceDir), "existing");
    return;
  }
  // Authorization is re-read here, independent of the caller's earlier snapshot.
  const monitor = await loadMonitorState(workspaceDir);
  if (!monitor.config.autoRepairHandoff) return;
  const at = new Date().toISOString();
  let record: RepairRecord;
  try {
    const loaded = await loadState(workspaceDir);
    const written = await writeHandoff(loaded, "missing");
    if (!written) return; // Another writer already restored it.
    const content = await readFile(file, "utf8");
    if (!content.trim() || !content.includes(`revision ${loaded.state.revision}`)
      || !content.includes("## 主动建议")) {
      throw new Error("重建结果未通过非空、修订号或建议摘要验证");
    }
    record = { at, action: "rebuild-handoff", authorized: true, result: "verified", evidence: "缺失的 handoff.md 已重建，非空、修订号与建议摘要已核对" };
    await updateMonitorState(workspaceDir, (state) => {
      const result = reconcileSuggestions(state, { findings: [], checkedKeys: [HANDOFF_KEY] }, false);
      result.next.repairs.push(record);
      return result.next;
    });
  } catch (error) {
    record = {
      at, action: "rebuild-handoff", authorized: true, result: "failed",
      evidence: `handoff.md 重建失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 600),
    };
    await updateMonitorState(workspaceDir, (state) => { state.repairs.push(record); return state; });
    throw error;
  }
}

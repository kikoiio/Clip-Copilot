import type { ResolveWorkspaceState } from "../../domain.ts";
import type { AdapterCallOptions, EditorAdapter } from "../contracts.ts";
import { isResolveWorkspaceState, refreshResolveWorkspaceContext } from "../workspace.ts";
import { loadState, saveState, type LoadedState, WorkspaceError } from "../../workspace/store.ts";

export interface ResolveRefreshOptions extends AdapterCallOptions {
  /** Defaults to the loaded state's revision; exposed for race tests/callers. */
  expectedRevision?: number;
}

export interface ResolveRefreshResult {
  loaded: LoadedState;
  state: ResolveWorkspaceState;
}

/** Refresh a marked Resolve workspace and persist either success or degradation. */
export async function refreshResolveWorkspace(
  workspaceDir: string,
  adapter: EditorAdapter,
  options: ResolveRefreshOptions,
): Promise<ResolveRefreshResult> {
  const loaded = await loadState(workspaceDir);
  if (!isResolveWorkspaceState(loaded.state)) {
    throw new WorkspaceError("工作区没有合法的 Resolve 标记，拒绝进入 Resolve 刷新路径");
  }
  const context = await refreshResolveWorkspaceContext(loaded.state.editorContext, adapter, options);
  const next = {
    ...loaded.state,
    workspaceKind: "resolve" as const,
    editorContext: context,
  };
  const saved = await saveState(
    workspaceDir,
    next,
    options.expectedRevision ?? loaded.state.revision,
  );
  if (!isResolveWorkspaceState(saved)) {
    throw new WorkspaceError("Resolve 刷新后状态校验失败");
  }
  return { loaded, state: saved };
}

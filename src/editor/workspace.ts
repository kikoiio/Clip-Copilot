import type { ResolveWorkspaceState, WorkspaceState } from "../domain.ts";
import {
  type AdapterCallOptions,
  type EditorAdapter,
  type EditorHealth,
  type ProjectIdentity,
  type ResolveWorkspaceContext,
} from "./contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHealth(value: unknown): value is EditorHealth {
  if (!isRecord(value) || !["online", "offline", "unknown"].includes(String(value.state))) return false;
  if (typeof value.checkedAt !== "string") return false;
  if (value.version !== undefined && typeof value.version !== "string") return false;
  if (value.edition !== undefined && !["free", "studio", "unknown"].includes(String(value.edition))) return false;
  return value.reason === undefined || typeof value.reason === "string";
}

function isIdentity(value: unknown): value is ProjectIdentity {
  if (!isRecord(value) || typeof value.projectName !== "string") return false;
  return ["projectId", "databaseId", "timelineId", "timelineName"].every(
    (key) => value[key] === null || typeof value[key] === "string",
  );
}

export function validateResolveWorkspaceContext(value: unknown): ResolveWorkspaceContext {
  if (
    !isRecord(value) ||
    value.kind !== "resolve" ||
    !("identity" in value) ||
    !("latestSnapshot" in value) ||
    !isHealth(value.health)
  ) {
    throw new Error("Resolve editorContext 缺少 kind 或合法 health");
  }
  if (value.identity !== null && !isIdentity(value.identity)) {
    throw new Error("Resolve editorContext.identity 非法");
  }
  if (value.latestSnapshot !== null) {
    if (!isRecord(value.latestSnapshot) || typeof value.latestSnapshot.fingerprint !== "string") {
      throw new Error("Resolve editorContext.latestSnapshot 非法");
    }
  }
  return value as unknown as ResolveWorkspaceContext;
}

export function isResolveWorkspaceState(state: WorkspaceState): state is ResolveWorkspaceState {
  if (state.workspaceKind !== "resolve" || state.editorContext === undefined) return false;
  try {
    validateResolveWorkspaceContext(state.editorContext);
    return true;
  } catch {
    return false;
  }
}

export async function refreshResolveWorkspaceContext(
  previous: ResolveWorkspaceContext,
  adapter: EditorAdapter,
  options: AdapterCallOptions,
): Promise<ResolveWorkspaceContext> {
  const health = await adapter.getHealth(options).catch((error: unknown): EditorHealth => ({
    state: "unknown",
    checkedAt: new Date().toISOString(),
    reason: error instanceof Error ? error.message : String(error),
  }));
  if (health.state !== "online") {
    return { ...previous, health };
  }

  const result = await adapter.readProjectSnapshot(options).catch((error: unknown) => ({
    ok: false as const,
    error: {
      capabilityId: "read.project_snapshot",
      kind: "protocol" as const,
      reason: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  }));
  if (!result.ok) {
    return {
      ...previous,
      health: {
        ...health,
        state: result.error.kind === "offline" ? "offline" : "unknown",
        reason: result.error.reason,
      },
    };
  }
  return {
    kind: "resolve",
    identity: result.value.identity,
    latestSnapshot: result.value,
    health,
  };
}

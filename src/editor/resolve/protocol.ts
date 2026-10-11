import type {
  ResolveCompatibility,
  ResolveEdition,
  ResolveRuntimeInfo,
} from "../contracts.ts";
import type { ResolveProjectSummaryResponse } from "./mapping.ts";

export const RESOLVE_PROTOCOL_VERSION = 1 as const;

export type ResolveProbeOperation = "health" | "project_snapshot";

export interface ResolveProbeRequest {
  protocolVersion: typeof RESOLVE_PROTOCOL_VERSION;
  operation: ResolveProbeOperation;
}

export type ResolveProbeErrorKind = "offline" | "unsupported" | "protocol" | "timeout";

export interface ResolveProbeError {
  kind: ResolveProbeErrorKind;
  reason: string;
  retryable: boolean;
}

export type ResolveProbeResponse =
  | {
      ok: true;
      runtime: ResolveRuntimeInfo;
      summary?: ResolveProjectSummaryResponse;
    }
  | {
      ok: false;
      runtime?: ResolveRuntimeInfo;
      error: ResolveProbeError;
    };

export function makeProbeRequest(operation: ResolveProbeOperation): ResolveProbeRequest {
  return { protocolVersion: RESOLVE_PROTOCOL_VERSION, operation };
}

/** Validate one decoded probe response before it enters the adapter layer. */
export function parseResolveProbeResponse(
  value: unknown,
  operation: ResolveProbeOperation,
): ResolveProbeResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Resolve probe response must be an object with boolean ok");
  }

  if (value.ok) {
    const runtime = parseRuntime(value.runtime);
    if (operation === "project_snapshot" && !isRecord(value.summary)) {
      throw new Error("Resolve project_snapshot response is missing summary");
    }
    return {
      ok: true,
      runtime,
      ...(value.summary === undefined ? {} : { summary: value.summary as ResolveProjectSummaryResponse }),
    };
  }

  const error = parseError(value.error);
  const runtime = value.runtime === undefined ? undefined : parseRuntime(value.runtime);
  return { ok: false, ...(runtime === undefined ? {} : { runtime }), error };
}

function parseRuntime(value: unknown): ResolveRuntimeInfo {
  if (!isRecord(value)) throw new Error("Resolve probe response is missing runtime");
  if (typeof value.version !== "string" || typeof value.build !== "string") {
    throw new Error("Resolve runtime version/build must be strings");
  }
  if (!isOneOf<ResolveEdition>(value.edition, ["free", "studio", "unknown"])) {
    throw new Error("Resolve runtime edition is invalid");
  }
  if (value.platform !== "linux-x64") {
    throw new Error("Resolve runtime platform is unsupported");
  }
  if (!isOneOf<ResolveCompatibility>(value.compatibility, ["supported", "unsupported", "unknown"])) {
    throw new Error("Resolve runtime compatibility is invalid");
  }
  if (typeof value.checkedAt !== "string") throw new Error("Resolve runtime checkedAt must be a string");
  return value as unknown as ResolveRuntimeInfo;
}

function parseError(value: unknown): ResolveProbeError {
  if (!isRecord(value) || !isOneOf<ResolveProbeErrorKind>(value.kind, ["offline", "unsupported", "protocol", "timeout"])) {
    throw new Error("Resolve probe error kind is invalid");
  }
  if (typeof value.reason !== "string" || typeof value.retryable !== "boolean") {
    throw new Error("Resolve probe error reason/retryable is invalid");
  }
  return value as unknown as ResolveProbeError;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

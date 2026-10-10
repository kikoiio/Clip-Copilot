import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assessCapability,
  getEditorCapabilities,
} from "../capabilities.ts";
import type {
  AdapterCallOptions,
  AdapterResult,
  EditorAdapter,
  EditorCapability,
  EditorHealth,
  TimelineSnapshot,
} from "../contracts.ts";
import {
  mapResolveProjectSummary,
  type ResolveProjectSummaryResponse,
} from "./mapping.ts";

export type ResolveFixtureMode = "online" | "offline" | "protocol" | "unsupported";

export interface ResolveFixtureAdapterOptions {
  /** Selects the deterministic failure mode used by protocol tests. */
  mode?: ResolveFixtureMode;
  /** Override the bundled response without connecting to Resolve. */
  summary?: ResolveProjectSummaryResponse;
  /** Fixed timestamps keep repeated fixture calls byte-for-byte comparable. */
  checkedAt?: string;
  capturedAt?: string;
  /** Artificial latency used to exercise timeout and cancellation handling. */
  delayMs?: number;
  offlineReason?: string;
  protocolReason?: string;
  unsupportedCapabilityId?: string;
}

export const RESOLVE_FIXTURE_TIMESTAMP = "2026-10-11T00:00:00.000Z";

const FIXTURE_PATH = path.resolve(process.cwd(), "tests/fixtures/resolve/project-summary.json");

/**
 * A protocol-only Resolve adapter. It reads a checked-in JSON response and
 * never starts a process, opens a socket, or requires Resolve to be installed.
 */
export class ResolveFixtureAdapter implements EditorAdapter {
  readonly editorKind = "resolve" as const;
  readonly mode: ResolveFixtureMode;
  private readonly summary: ResolveProjectSummaryResponse;
  private readonly checkedAt: string;
  private readonly capturedAt: string;
  private readonly delayMs: number;
  private readonly offlineReason: string;
  private readonly protocolReason: string;
  private readonly unsupportedCapabilityId: string;

  constructor(options: ResolveFixtureAdapterOptions = {}) {
    this.mode = options.mode ?? "online";
    this.summary = options.summary ?? readFixtureSummary();
    this.checkedAt = options.checkedAt ?? RESOLVE_FIXTURE_TIMESTAMP;
    this.capturedAt = options.capturedAt ?? RESOLVE_FIXTURE_TIMESTAMP;
    this.delayMs = Math.max(0, options.delayMs ?? 0);
    this.offlineReason = options.offlineReason ?? "Resolve fixture adapter is offline";
    this.protocolReason = options.protocolReason ?? "Resolve fixture protocol response is invalid";
    this.unsupportedCapabilityId = options.unsupportedCapabilityId ?? "read.project_snapshot";
  }

  async getHealth(options: AdapterCallOptions): Promise<EditorHealth> {
    const failure = await this.wait(options, "read.health");
    if (failure) {
      return {
        state: "unknown",
        checkedAt: this.checkedAt,
        reason: failure.reason,
      };
    }
    if (this.mode === "offline") {
      return {
        state: "offline",
        checkedAt: this.checkedAt,
        reason: this.offlineReason,
      };
    }
    if (this.mode === "protocol") {
      return {
        state: "online",
        checkedAt: this.checkedAt,
        reason: "Fixture transport is online; protocol failure is simulated on snapshot read",
      };
    }
    return { state: "online", checkedAt: this.checkedAt };
  }

  getCapabilities(): readonly EditorCapability[] {
    return getEditorCapabilities();
  }

  async readProjectSnapshot(
    options: AdapterCallOptions,
  ): Promise<AdapterResult<TimelineSnapshot>> {
    const capabilityId = "read.project_snapshot";
    const failure = await this.wait(options, capabilityId);
    if (failure) return { ok: false, error: failure };

    if (this.mode === "offline") {
      return {
        ok: false,
        error: {
          capabilityId,
          kind: "offline",
          reason: this.offlineReason,
          retryable: true,
        },
      };
    }
    if (this.mode === "protocol") {
      return {
        ok: false,
        error: {
          capabilityId,
          kind: "protocol",
          reason: this.protocolReason,
          retryable: false,
        },
      };
    }
    if (this.mode === "unsupported") {
      return {
        ok: false,
        error: {
          capabilityId: this.unsupportedCapabilityId,
          kind: "unsupported",
          reason: `Fixture does not support capability ${this.unsupportedCapabilityId}`,
          retryable: false,
        },
      };
    }

    const snapshot = mapResolveProjectSummary(this.summary, { capturedAt: this.capturedAt });
    return { ok: true, value: snapshot };
  }

  /** Evaluate any catalog capability without exposing a write operation. */
  assess(capabilityId: string, options: AdapterCallOptions = { timeoutMs: 0 }): ReturnType<typeof assessCapability> {
    const health: EditorHealth = this.mode === "offline"
      ? { state: "offline", checkedAt: this.checkedAt, reason: this.offlineReason }
      : { state: "online", checkedAt: this.checkedAt };
    return assessCapability(capabilityId, health, this.satisfiedPrerequisites());
  }

  private satisfiedPrerequisites(): string[] {
    if (this.mode !== "online") return [];
    return ["resolve_adapter_available", "resolve_connected", "active_project", "active_timeline", "snapshot_available", "mapping_rules_known"];
  }

  private async wait(
    options: AdapterCallOptions,
    capabilityId: string,
  ): Promise<Extract<AdapterResult<never>, { ok: false }>["error"] | null> {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 0;
    const signal = options.signal;
    if (signal?.aborted) return timeoutError(capabilityId, "Fixture adapter call was cancelled");

    const delayMs = this.delayMs;
    if (timeoutMs <= 0) return timeoutError(capabilityId, "Fixture adapter call timed out after 0ms");
    if (delayMs === 0) return null;

    return await new Promise<Extract<AdapterResult<never>, { ok: false }>["error"] | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error: Extract<AdapterResult<never>, { ok: false }>["error"] | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (timeout !== undefined) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        resolve(error);
      };
      const onAbort = (): void => finish(timeoutError(capabilityId, "Fixture adapter call was cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => finish(null), delayMs);
      if (timeoutMs < delayMs) {
        timeout = setTimeout(() => finish(timeoutError(capabilityId, `Fixture adapter call timed out after ${timeoutMs}ms`)), timeoutMs);
      }
    });
  }
}

export function createResolveFixtureAdapter(options: ResolveFixtureAdapterOptions = {}): ResolveFixtureAdapter {
  return new ResolveFixtureAdapter(options);
}

export const createFixtureResolveAdapter = createResolveFixtureAdapter;
export const createFixtureAdapter = createResolveFixtureAdapter;

function readFixtureSummary(): ResolveProjectSummaryResponse {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ResolveProjectSummaryResponse;
}

function timeoutError(
  capabilityId: string,
  reason: string,
): Extract<AdapterResult<never>, { ok: false }>["error"] {
  return { capabilityId, kind: "timeout", reason, retryable: true };
}

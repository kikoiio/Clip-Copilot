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
  ResolveRuntimeInfo,
  TimelineSnapshot,
} from "../contracts.ts";
import {
  mapResolveProjectSummary,
  type ResolveProjectSummaryResponse,
} from "./mapping.ts";
import type { ResolveBridge } from "./bridge.ts";
import {
  createResolveSupportPolicy,
  type ResolveSupportPolicy,
} from "./compatibility.ts";
import {
  makeProbeRequest,
  type ResolveProbeError,
  type ResolveProbeResponse,
} from "./protocol.ts";

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

export interface ResolveAdapterOptions {
  bridge: ResolveBridge;
  supportPolicy: ResolveSupportPolicy;
  defaultTimeoutMs?: number;
  now?: () => string;
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

  getRuntimeInfo(): ResolveRuntimeInfo {
    return fixtureRuntime(this.checkedAt);
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

/** Real read-only Resolve adapter backed by the one-shot process bridge. */
export class ResolveAdapter implements EditorAdapter {
  readonly editorKind = "resolve" as const;
  private readonly bridge: ResolveBridge;
  private readonly supportPolicy: ResolveSupportPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => string;
  private runtime: ResolveRuntimeInfo | undefined;

  constructor(options: ResolveAdapterOptions) {
    this.bridge = options.bridge;
    this.supportPolicy = options.supportPolicy;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async getHealth(options: AdapterCallOptions): Promise<EditorHealth> {
    const response = await this.bridge.request(makeProbeRequest("health"), this.withDefaultTimeout(options));
    if (!response.ok) {
      this.runtime = response.runtime;
      return healthFromFailure(response.error, response.runtime);
    }
    this.runtime = withCompatibility(response.runtime, this.supportPolicy);
    const runtime = this.runtime;
    if (runtime.compatibility !== "supported") {
      return {
        state: "unknown",
        checkedAt: runtime.checkedAt,
        version: runtime.version,
        edition: runtime.edition,
        reason: compatibilityReason(runtime),
      };
    }
    return {
      state: "online",
      checkedAt: runtime.checkedAt,
      version: runtime.version,
      edition: runtime.edition,
    };
  }

  getRuntimeInfo(): ResolveRuntimeInfo | undefined {
    return this.runtime;
  }

  getCapabilities(): readonly EditorCapability[] {
    return getEditorCapabilities();
  }

  async readProjectSnapshot(options: AdapterCallOptions): Promise<AdapterResult<TimelineSnapshot>> {
    const response = await this.bridge.request(makeProbeRequest("project_snapshot"), this.withDefaultTimeout(options));
    if (!response.ok) {
      this.runtime = response.runtime ?? this.runtime;
      return { ok: false, error: adapterError("read.project_snapshot", response.error) };
    }
    this.runtime = withCompatibility(response.runtime, this.supportPolicy);
    if (this.runtime.compatibility !== "supported") {
      return {
        ok: false,
        error: {
          capabilityId: "read.project_snapshot",
          kind: "unsupported",
          reason: compatibilityReason(this.runtime),
          retryable: false,
        },
      };
    }
    if (response.summary === undefined) {
      return {
        ok: false,
        error: {
          capabilityId: "read.project_snapshot",
          kind: "protocol",
          reason: "Resolve project_snapshot response is missing summary",
          retryable: false,
        },
      };
    }
    return { ok: true, value: mapResolveProjectSummary(response.summary, { capturedAt: this.now() }) };
  }

  private withDefaultTimeout(options: AdapterCallOptions): AdapterCallOptions {
    return { ...options, timeoutMs: options.timeoutMs > 0 ? options.timeoutMs : this.defaultTimeoutMs };
  }
}

export function createResolveAdapter(options: ResolveAdapterOptions): ResolveAdapter {
  return new ResolveAdapter(options);
}

export function createResolveFixtureAdapter(options: ResolveFixtureAdapterOptions = {}): ResolveFixtureAdapter {
  return new ResolveFixtureAdapter(options);
}

export const createFixtureResolveAdapter = createResolveFixtureAdapter;
export const createFixtureAdapter = createResolveFixtureAdapter;

function readFixtureSummary(): ResolveProjectSummaryResponse {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ResolveProjectSummaryResponse;
}

function fixtureRuntime(checkedAt: string): ResolveRuntimeInfo {
  return {
    version: "21.0.0-fixture",
    build: "21.0.0-fixture.001",
    edition: "free",
    platform: "linux-x64",
    compatibility: "supported",
    checkedAt,
  };
}

function withCompatibility(
  runtime: ResolveRuntimeInfo,
  policy: ResolveSupportPolicy,
): ResolveRuntimeInfo {
  return { ...runtime, compatibility: policy.assess(runtime) };
}

function healthFromFailure(error: ResolveProbeError, runtime: ResolveRuntimeInfo | undefined): EditorHealth {
  return {
    state: error.kind === "offline" ? "offline" : "unknown",
    checkedAt: runtime?.checkedAt ?? new Date().toISOString(),
    ...(runtime?.version === undefined ? {} : { version: runtime.version }),
    ...(runtime?.edition === undefined ? {} : { edition: runtime.edition }),
    reason: error.reason,
  };
}

function adapterError(capabilityId: string, error: ResolveProbeError): Extract<AdapterResult<never>, { ok: false }>["error"] {
  return { capabilityId, kind: error.kind, reason: error.reason, retryable: error.retryable };
}

function compatibilityReason(runtime: ResolveRuntimeInfo): string {
  if (runtime.compatibility === "unsupported") return `Resolve runtime ${runtime.version}/${runtime.build} is unsupported on ${runtime.platform}`;
  if (runtime.edition === "studio") return "Studio runtime is recorded but not part of the Free baseline verification";
  if (runtime.edition === "unknown") return "Resolve edition is unknown";
  return `Resolve build ${runtime.build} has not been verified`;
}

function timeoutError(
  capabilityId: string,
  reason: string,
): Extract<AdapterResult<never>, { ok: false }>["error"] {
  return { capabilityId, kind: "timeout", reason, retryable: true };
}

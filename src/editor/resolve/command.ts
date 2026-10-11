import path from "node:path";
import type { EditorAdapter } from "../contracts.ts";
import { createResolveAdapter } from "./adapter.ts";
import { createResolveSupportPolicy } from "./compatibility.ts";
import { createResolveProcessBridge } from "./bridge.ts";
import { refreshResolveWorkspace } from "./service.ts";

export interface ResolveCommandDependencies {
  adapter?: EditorAdapter;
  refresh?: typeof refreshResolveWorkspace;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  verifiedBuilds?: readonly string[];
}

/** Explicit, read-only Resolve CLI entry point. Dependencies are injectable for tests. */
export async function cmdResolve(
  args: string[],
  dependencies: ResolveCommandDependencies = {},
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "read") throw new Error("resolve 子命令：read --workspace <目录> [--timeout-ms <毫秒>]");

  const parsed = parseReadArgs(rest);
  const adapter = dependencies.adapter ?? createResolveAdapter({
    bridge: createResolveProcessBridge(),
    supportPolicy: createResolveSupportPolicy({
      acceptedBuilds: dependencies.verifiedBuilds ?? verifiedBuildsFromEnvironment(),
      baselineEdition: "free",
    }),
  });
  const refresh = dependencies.refresh ?? refreshResolveWorkspace;
  const result = await refresh(path.resolve(parsed.workspace), adapter, { timeoutMs: parsed.timeoutMs });
  const context = result.state.editorContext;
  const snapshot = context.latestSnapshot;
  const report = {
    workspace: path.resolve(parsed.workspace),
    health: context.health.state,
    checkedAt: context.health.checkedAt,
    runtime: context.runtime ?? null,
    identity: context.identity,
    snapshot: snapshot === null ? null : {
      fingerprint: snapshot.fingerprint,
      capturedAt: snapshot.capturedAt,
      counts: {
        tracks: snapshot.tracks.length,
        clips: snapshot.clips.length,
        markers: snapshot.markers.length,
        subtitles: snapshot.subtitles.length,
        media: snapshot.media.length,
      },
      mappingNotes: snapshot.mappingNotes,
    },
    degradationReason: context.health.reason ?? null,
  };
  (dependencies.stdout ?? ((text) => process.stdout.write(`${text}\n`)))(JSON.stringify(report, null, 2));
  return context.health.state === "online" && snapshot !== null ? 0 : 1;
}

function parseReadArgs(args: string[]): { workspace: string; timeoutMs: number } {
  const allowed = new Set(["--workspace", "--timeout-ms"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!allowed.has(flag)) throw new Error(`resolve read 不支持参数：${flag}`);
    if (values.has(flag)) throw new Error(`参数 ${flag} 重复指定`);
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${flag} 缺少取值`);
    values.set(flag, value);
  }
  const workspace = values.get("--workspace");
  if (!workspace) throw new Error("resolve read 缺少 --workspace 参数");
  const timeoutText = values.get("--timeout-ms");
  const timeoutMs = timeoutText === undefined ? 15_000 : Number(timeoutText);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("--timeout-ms 必须是 1 到 120000 之间的整数");
  }
  return { workspace, timeoutMs };
}

function verifiedBuildsFromEnvironment(): string[] {
  return (process.env.RESOLVE_VERIFIED_BUILDS ?? "")
    .split(",")
    .map((build) => build.trim())
    .filter(Boolean);
}

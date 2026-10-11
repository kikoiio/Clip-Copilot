import type {
  ResolveCompatibility,
  ResolveEdition,
  ResolveRuntimeInfo,
} from "../contracts.ts";

export interface ResolveSupportPolicy {
  targetPlatform: "linux-x64";
  acceptedMajor: 21;
  acceptedBuilds: readonly string[];
  baselineEdition: "free";
  assess(runtime: ResolveRuntimeInfo): ResolveCompatibility;
}

export interface ResolveSupportPolicyOptions {
  acceptedBuilds: readonly string[];
  baselineEdition?: "free";
}

export function createResolveSupportPolicy(options: ResolveSupportPolicyOptions): ResolveSupportPolicy {
  const acceptedBuilds = [...new Set(options.acceptedBuilds.filter((build) => build.trim().length > 0))];
  const policy: ResolveSupportPolicy = {
    targetPlatform: "linux-x64",
    acceptedMajor: 21,
    acceptedBuilds,
    baselineEdition: options.baselineEdition ?? "free",
    assess(runtime) {
      return assessResolveRuntime(runtime, policy);
    },
  };
  return policy;
}

export function assessResolveRuntime(
  runtime: ResolveRuntimeInfo,
  policy: Pick<ResolveSupportPolicy, "targetPlatform" | "acceptedMajor" | "acceptedBuilds" | "baselineEdition">,
): ResolveCompatibility {
  if (runtime.platform !== policy.targetPlatform) return "unsupported";
  const major = majorVersion(runtime.version);
  if (major !== policy.acceptedMajor) return "unsupported";
  if (runtime.edition === "unknown") return "unknown";
  if (runtime.edition === "studio" && policy.baselineEdition === "free") return "unknown";
  if (!policy.acceptedBuilds.includes(runtime.build)) return "unknown";
  return "supported";
}

export function majorVersion(version: string): number | null {
  const match = /^\s*v?(\d+)(?:\.|$)/.exec(version);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function editionLabel(edition: ResolveEdition): string {
  return edition === "free" ? "Free" : edition === "studio" ? "Studio" : "未知发行版";
}

import type {
  CapabilityStage,
  EditorCapability,
  EditorHealth,
} from "./contracts.ts";

export const EDITOR_CAPABILITIES: readonly EditorCapability[] = Object.freeze([
  {
    id: "read.health",
    stage: "read",
    support: "supported",
    prerequisites: ["resolve_adapter_available"],
    effect: "read_only",
    approval: "none",
    timeoutMs: 5_000,
    idempotent: true,
    degradation: "适配器缺失或连接离线时报告健康状态不可用；不影响已保存工作区上下文。",
  },
  {
    id: "read.project_snapshot",
    stage: "read",
    support: "supported",
    prerequisites: ["resolve_connected", "active_project", "active_timeline"],
    effect: "read_only",
    approval: "none",
    timeoutMs: 15_000,
    idempotent: true,
    degradation: "不可读取时返回明确失败，并保留最近一次成功快照供离线查看。",
  },
  {
    id: "edit.timeline",
    stage: "edit",
    support: "unsupported",
    prerequisites: [
      "resolve_connected",
      "active_project",
      "active_timeline",
      "workspace_write_authorization",
      "recoverable_backup",
    ],
    effect: "mutates_project",
    approval: "required",
    timeoutMs: 30_000,
    idempotent: false,
    degradation: "阶段 0 不执行工程写入；拒绝操作且不修改 Resolve 工程，用户可在编辑器内手动处理。",
  },
  {
    id: "render.output",
    stage: "render",
    support: "unsupported",
    prerequisites: [
      "resolve_connected",
      "active_project",
      "render_profile",
      "output_location_authorized",
      "available_output_capacity",
    ],
    effect: "creates_output",
    approval: "separate",
    timeoutMs: 180_000,
    idempotent: false,
    degradation: "阶段 0 不启动渲染或创建输出；报告不支持，已有输出和工作区状态保持不变。",
  },
  {
    id: "verify.snapshot_mapping",
    stage: "verify",
    support: "conditional",
    prerequisites: ["snapshot_available", "mapping_rules_known"],
    effect: "read_only",
    approval: "none",
    timeoutMs: 10_000,
    idempotent: true,
    degradation: "快照或映射规则缺失时报告未验证及缺少条件；不将其解释为验证通过。",
  },
  {
    id: "verify.resolve_project",
    stage: "verify",
    support: "unevaluated",
    prerequisites: [
      "resolve_connected",
      "supported_resolve_version_selected",
      "edition_requirements_confirmed",
      "verification_profile",
    ],
    effect: "read_only",
    approval: "none",
    timeoutMs: 60_000,
    idempotent: true,
    degradation: "目标版本与发行版尚未确定；阶段 0 仅记录未评估，不声称真实工程验证可用。",
  },
]);

export type CapabilityUnavailableReason =
  | "unknown_capability"
  | "unsupported"
  | "unevaluated"
  | "offline"
  | "health_unknown"
  | "prerequisites_missing";

export type CapabilityAvailability =
  | { available: true; capability: EditorCapability }
  | {
      available: false;
      capability?: EditorCapability;
      reason: CapabilityUnavailableReason;
      message: string;
      missingPrerequisites: string[];
    };

const STAGE_LABELS: Record<CapabilityStage, string> = {
  read: "只读",
  edit: "受控编辑",
  render: "渲染",
  verify: "验证",
};

export function getEditorCapabilities(): readonly EditorCapability[] {
  return EDITOR_CAPABILITIES;
}

export function assessCapability(
  capabilityId: string,
  health: EditorHealth,
  satisfiedPrerequisites: readonly string[] = [],
): CapabilityAvailability {
  const capability = EDITOR_CAPABILITIES.find(({ id }) => id === capabilityId);
  if (!capability) {
    return {
      available: false,
      reason: "unknown_capability",
      message: `未知能力：${capabilityId}`,
      missingPrerequisites: [],
    };
  }

  if (capability.support === "unsupported") {
    return unavailable(capability, "unsupported", `${capability.id}（${STAGE_LABELS[capability.stage]}）在当前阶段明确不支持。`);
  }
  if (capability.support === "unevaluated") {
    return unavailable(capability, "unevaluated", `${capability.id} 尚未评估，不能执行。`);
  }
  if (health.state === "offline") {
    return unavailable(capability, "offline", health.reason ?? "编辑器当前离线。", capability.prerequisites);
  }
  if (health.state !== "online") {
    return unavailable(capability, "health_unknown", health.reason ?? "编辑器连接状态未知。", capability.prerequisites);
  }

  const missingPrerequisites = capability.prerequisites.filter(
    (prerequisite) => !satisfiedPrerequisites.includes(prerequisite),
  );
  if (missingPrerequisites.length > 0) {
    return unavailable(
      capability,
      "prerequisites_missing",
      `条件不足：${missingPrerequisites.join("、")}`,
      missingPrerequisites,
    );
  }

  return { available: true, capability };
}

function unavailable(
  capability: EditorCapability,
  reason: CapabilityUnavailableReason,
  message: string,
  missingPrerequisites: string[] = [],
): CapabilityAvailability {
  return { available: false, capability, reason, message, missingPrerequisites };
}

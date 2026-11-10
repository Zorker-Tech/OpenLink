import type { SubagentModelForcePolicy } from "./subagent-model-policy.ts";

export type ForcedModelAudit = (details: {
  readonly candidateModelId: string;
  readonly modelResolutionReason: string;
  readonly reasonDetails: Record<string, unknown>;
}) => string;

export interface PinnedSubagentModelPorts {
  readonly forceModelId?: string | undefined;
  readonly subagentModelForcePolicy: SubagentModelForcePolicy;
  readonly isModelBlocked: (modelId: string) => boolean;
  readonly isMaxModeCompatible: (modelId: string) => Promise<boolean>;
  readonly logForcedModel: ForcedModelAudit;
}

export interface ForcedSubagentModelInput extends PinnedSubagentModelPorts {
  readonly userRequestedModelId?: string | undefined;
  readonly isModelValid: (modelId: string) => boolean;
}

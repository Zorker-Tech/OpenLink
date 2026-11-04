import type { PinnedSubagentModelPorts } from "./subagent-forced-model-contracts.ts";

export async function resolveUsablePinnedModel(
  ports: PinnedSubagentModelPorts,
): Promise<string | undefined> {
  const candidate = ports.forceModelId;
  if (candidate === undefined || ports.isModelBlocked(candidate)) return undefined;
  if (!await ports.isMaxModeCompatible(candidate)) return undefined;

  return ports.logForcedModel({
    candidateModelId: candidate,
    modelResolutionReason: "force_model",
    reasonDetails: {
      forceModelId: candidate,
      subagentModelForcePolicy: ports.subagentModelForcePolicy,
    },
  });
}

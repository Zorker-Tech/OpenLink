/** Convert counterpart model metadata into the host's Git-guidance capability. */

import type { GitWorkflowModelCapability } from "../../../packages/agent/prompts/git-workflow-rule-policy.ts";
import { slateModelCapabilitiesFromInterop } from "./model-capabilities-adapter.ts";

const GIT_RULES_PROMPT_VERSION = "cursor-0226";

export function adaptGitWorkflowModelCapability(value: unknown): GitWorkflowModelCapability | undefined {
  if (value === null || typeof value !== "object") return undefined;

  const model = slateModelCapabilitiesFromInterop(value);
  if (model === undefined) return undefined;
  const rawTrainingVariant = model.isLegacyAgentMatterhorn === true && model.isRawTrainingSlug === true;
  const needsGitWorkflowRules = !rawTrainingVariant && (
    model.promptVersion === GIT_RULES_PROMPT_VERSION ||
    model.isLegacyAgentMatterhorn === true ||
    model.isLegacyAgentModel2 === true ||
    model.isLegacyAgentModel15 === true
  );

  return { needsGitWorkflowRules };
}

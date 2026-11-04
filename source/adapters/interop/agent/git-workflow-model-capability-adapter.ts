/** Convert counterpart model metadata into the host's Git-guidance capability. */

import type { GitWorkflowModelCapability } from "../../../packages/agent/prompts/git-workflow-rule-policy.ts";

interface InteropGitModelInfo {
  readonly promptVersion?: unknown;
  readonly isComposerMatterhorn?: unknown;
  readonly isRawTrainingSlug?: unknown;
  readonly isComposer2?: unknown;
  readonly isComposer15?: unknown;
}

const GIT_RULES_PROMPT_VERSION = "cursor-0226";

export function adaptGitWorkflowModelCapability(value: unknown): GitWorkflowModelCapability | undefined {
  if (value === null || typeof value !== "object") return undefined;

  const model = value as InteropGitModelInfo;
  const rawTrainingVariant = model.isComposerMatterhorn === true && model.isRawTrainingSlug === true;
  const needsGitWorkflowRules = !rawTrainingVariant && (
    model.promptVersion === GIT_RULES_PROMPT_VERSION ||
    model.isComposerMatterhorn === true ||
    model.isComposer2 === true ||
    model.isComposer15 === true
  );

  return { needsGitWorkflowRules };
}

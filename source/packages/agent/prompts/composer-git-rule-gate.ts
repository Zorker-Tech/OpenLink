/**
 * Whether a model is given the generated git user rules.
 *
 * One family of models was trained without shell access to GitHub, so the git workflow has to be spelled
 * out for it as rules rather than left to a tool it does not have. Which models those are is a property
 * of the catalogue entry — a named prompt version, or a generation known to be in that family — and a
 * background run is excluded, because it works through the platform's own git handling instead.
 */

import { AgentType } from "../utils/agent-config.ts"

interface ComposerGitRuleModelInfo {
  readonly isComposerMatterhorn?: boolean | undefined
  readonly isRawTrainingSlug?: boolean | undefined
  /** A catalogue value: the prompt version a model was trained against. */
  readonly promptVersion?: string | undefined
  readonly isComposer2?: boolean | undefined
  readonly isComposer15?: boolean | undefined
}

const SHELL_LESS_GITHUB_PROMPT_VERSION = "cursor-0226"

export function shouldInjectComposerGitUserRules(
  modelInfo: ComposerGitRuleModelInfo | undefined,
  agentType?: AgentType | undefined,
): boolean {
  if (modelInfo === undefined) return false
  if (modelInfo.isComposerMatterhorn === true && modelInfo.isRawTrainingSlug === true) return false
  const isModelWithoutShellGithubTools = modelInfo.promptVersion === SHELL_LESS_GITHUB_PROMPT_VERSION ||
    modelInfo.isComposerMatterhorn === true ||
    modelInfo.isComposer2 === true ||
    modelInfo.isComposer15 === true
  if (!isModelWithoutShellGithubTools) return false
  if (agentType === AgentType.BACKGROUND) return false
  return true
}

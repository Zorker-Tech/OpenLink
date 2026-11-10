/**
 * Configuration a caller can override per context.
 *
 * Timeouts, evaluation knobs and experimental switches are read in many places and set in few, and
 * the place that sets them (a test harness, an evaluation run, a support session) holds a context,
 * not a config object. So the overrides live on the context: a value is resolved where it is used,
 * falling back to the default, and nothing has to be threaded through the call graph.
 */

import { readContextOverride } from "./config-override-reader.ts"

export { slateConfigOverridesKey } from "./config-override-reader.ts"

export const READ_LINT_TIMEOUT_MS = readContextOverride("read_lint_timeout_ms", 10_000)
export const WRITE_EVAL_TRANSCRIPTS = readContextOverride("writeEvalTranscripts", false)

export const EVAL_ENFORCED_TEMPERATURE = readContextOverride<number | undefined>("evalServiceEnforcedTemperature", undefined)
export const EVAL_ENFORCED_TOP_P = readContextOverride<number | undefined>("evalServiceEnforcedTopP", undefined)
export const EVAL_ENFORCED_TOP_K = readContextOverride<number | undefined>("evalServiceEnforcedTopK", undefined)
export const EVAL_ENFORCED_MIN_P = readContextOverride<number | undefined>("evalServiceEnforcedMinP", undefined)
export const EVAL_ENFORCED_TEMPERATURE_NON_THINKING =
  readContextOverride<number | undefined>("evalServiceEnforcedTemperatureNonThinking", undefined)
export const EVAL_ENFORCED_AGENT_TOKEN_LIMIT =
  readContextOverride<number | undefined>("evalServiceEnforcedAgentTokenLimit", undefined)
export const EVAL_ENFORCED_MAX_TOKENS_BEFORE_SUMMARIZATION =
  readContextOverride<number | undefined>("evalServiceEnforcedMaxTokensBeforeSummarization", undefined)
export const EVAL_ENFORCED_SELF_SUMMARY = readContextOverride<boolean | undefined>("evalServiceEnforcedSelfSummary", undefined)
export const EVAL_ENFORCED_WAIT_FOR_SUMMARIZATION_COMPLETION =
  readContextOverride<string | undefined>("evalServiceEnforcedWaitForSummarizationCompletion", undefined)
export const EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT =
  readContextOverride<number | undefined>("evalServiceEnforcedSelfSummaryTokenLimit", undefined)
export const EVAL_ENFORCED_SUMMARIZATION_MODEL_V3_VARIANT =
  readContextOverride<string | undefined>("evalServiceEnforcedSummarizationModelV3Variant", undefined)
export const EVAL_ENFORCED_EFFORT_LEVEL = readContextOverride<string | undefined>("evalServiceEnforcedEffortLevel", undefined)
export const EVAL_ENFORCED_IS_EAGER_EDITING_MODEL =
  readContextOverride<boolean | undefined>("evalServiceEnforcedIsEagerEditingModel", undefined)

export const DISABLE_SEMANTIC_SEARCH = readContextOverride("disableSemanticSearch", false)
export const ALLOW_PROMPT_TWEAKS = readContextOverride("allowPromptTweaks", false)
export const ALLOW_TASK_TOOL_IN_RL_HARNESS = readContextOverride("allowTaskToolInRlHarness", false)
export const ALLOW_NESTED_TASK_TOOL_IN_RL_HARNESS = readContextOverride("allowNestedTaskToolInRlHarness", false)
export const SUMMARIZATION_FORCE_DETERMINISTIC_FALLBACK =
  readContextOverride<boolean | undefined>("summarizationForceDeterministicFallback", undefined)
export const CANVAS_POST_EDIT_DIAGNOSTICS_TIMEOUT_MS =
  readContextOverride("canvas_post_edit_diagnostics_timeout_ms", 2_000)

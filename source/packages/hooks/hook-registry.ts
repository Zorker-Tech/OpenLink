/**
 * Which validator answers for which step.
 *
 * The table is exhaustive over the step catalogue, so adding a step without deciding how its response
 * is read does not compile. Three groups of steps share a validator because their responses are the
 * same shape: the ones that gate an action, the ones that only observe the outcome, and the two pairs
 * that differ in nothing but their name (reading a tab file is reading a file; a subagent stopping is
 * stopping).
 */

import { HookStep } from "./hook-step.ts"
import { validateHookResponseEnvelope } from "./validators/base-hook-response.ts"
import {
  validateBeforePromptSubmitResponse,
  validateGatedActionResponse,
  validateObservedResponse,
  validatePostToolUseResponse,
  validatePreCompactResponse,
  validatePreToolUseResponse,
  validateReadFileResponse,
  validateSessionStartResponse,
  validateStopResponse,
  validateSubagentStartResponse,
  validateWorkspaceOpenResponse,
} from "../../adapters/interop/hooks/foreign-hook-response-adapter.ts"
import type { ValidationResult } from "./validators/validation.ts"

export type HookResponseValidator = (value: unknown) => ValidationResult

export const HOOK_RESPONSE_VALIDATORS: Readonly<Record<HookStep, HookResponseValidator>> = {
  [HookStep.beforeShellExecution]: validateGatedActionResponse,
  [HookStep.beforeMCPExecution]: validateGatedActionResponse,
  [HookStep.afterShellExecution]: validateObservedResponse,
  [HookStep.afterMCPExecution]: validateObservedResponse,
  [HookStep.beforeReadFile]: validateReadFileResponse,
  [HookStep.afterFileEdit]: validateObservedResponse,
  [HookStep.beforeTabFileRead]: validateReadFileResponse,
  [HookStep.afterTabFileEdit]: validateObservedResponse,
  [HookStep.beforeSubmitPrompt]: validateBeforePromptSubmitResponse,
  [HookStep.stop]: validateStopResponse,
  [HookStep.afterAgentResponse]: validateObservedResponse,
  [HookStep.afterAgentThought]: validateObservedResponse,
  [HookStep.sessionStart]: validateSessionStartResponse,
  [HookStep.sessionEnd]: validateObservedResponse,
  [HookStep.preCompact]: validatePreCompactResponse,
  [HookStep.subagentStart]: validateSubagentStartResponse,
  [HookStep.subagentStop]: validateStopResponse,
  [HookStep.preToolUse]: validatePreToolUseResponse,
  [HookStep.postToolUse]: validatePostToolUseResponse,
  [HookStep.postToolUseFailure]: validatePostToolUseResponse,
  [HookStep.workspaceOpen]: validateWorkspaceOpenResponse,
}

export function validateHookResponse(step: HookStep, value: unknown): ValidationResult {
  return (HOOK_RESPONSE_VALIDATORS[step] ?? validateHookResponseEnvelope)(value)
}

/** The steps whose response may add context to the model's conversation. */
export const HOOK_STEPS_CARRYING_ADDITIONAL_CONTEXT: ReadonlySet<HookStep> = new Set([
  HookStep.sessionStart,
  HookStep.beforeSubmitPrompt,
  HookStep.preToolUse,
  HookStep.postToolUse,
  HookStep.postToolUseFailure,
])

/** The steps that decide whether an action may happen, and can therefore refuse it. */
export const PERMISSION_HOOK_STEPS: readonly HookStep[] = [
  HookStep.beforeShellExecution,
  HookStep.beforeMCPExecution,
  HookStep.beforeReadFile,
  HookStep.beforeTabFileRead,
  HookStep.subagentStart,
  HookStep.preToolUse,
]

/** The steps tied to the life of a workspace rather than to a turn inside it. */
export const WORKSPACE_LIFECYCLE_STEPS: readonly HookStep[] = [HookStep.workspaceOpen]

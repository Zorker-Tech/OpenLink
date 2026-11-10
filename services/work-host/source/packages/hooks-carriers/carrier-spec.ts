/**
 * Which steps may carry context, spelled out as a table the compiler can check.
 *
 * The registry knows which steps accept added context; this narrows that to the steps whose event name
 * a context message may use, and it is written as a table keyed by the narrowed union so the two lists
 * cannot drift apart without a compile error. The runtime check is the belt to that braces: if a step
 * is ever added to the registry without being added here, the table refuses to build rather than
 * quietly shipping a step whose context has nowhere to go.
 */

import { HookStep } from "../hooks/hook-step.ts"
import { HOOK_STEPS_CARRYING_ADDITIONAL_CONTEXT } from "../hooks/hook-registry.ts"

type ContextBearingHookStep =
  | typeof HookStep.sessionStart
  | typeof HookStep.beforeSubmitPrompt
  | typeof HookStep.preToolUse
  | typeof HookStep.postToolUse
  | typeof HookStep.postToolUseFailure

function isContextBearingHookStep(step: HookStep): step is ContextBearingHookStep {
  return step === HookStep.sessionStart ||
    step === HookStep.beforeSubmitPrompt ||
    step === HookStep.preToolUse ||
    step === HookStep.postToolUse ||
    step === HookStep.postToolUseFailure
}

export const HOOK_STEP_CARRIER_SPECS = Object.fromEntries(
  Array.from(HOOK_STEPS_CARRYING_ADDITIONAL_CONTEXT).map(step => {
    if (!isContextBearingHookStep(step)) {
      throw new Error(
        `Hook step ${step} accepts context but is absent from the host's carrier catalog. Add it to carrier-spec.ts.`,
      )
    }
    return [step, { event: step }]
  }),
) as Record<ContextBearingHookStep, { event: ContextBearingHookStep }>

/**
 * What an agent pursuing a long-running goal is told about how to pursue it.
 *
 * A goal that spans turns changes what the agent should do with the end of a turn: stopping is not
 * finishing, a plan is not the work, and the objective is not allowed to shrink to what fits in the
 * budget. The guidelines say all of that, and name the tools that make it visible — the todo tool for
 * the plan, the goal tool for completion — when those tools exist, so an environment without them
 * still gets the rules it can follow.
 */

export interface GoalPursuitToolNames {
  readonly todoWriteToolName?: string
  readonly updateGoalToolName?: string
}

/** What a goal being pursued across turns changes about the end of a turn. */
const CONTINUATION_RULES = `Continuation behavior:
- This goal persists across turns. Ending this turn does not require shrinking the objective to what fits now.
- Keep the full objective intact. If it cannot be finished now, make concrete progress toward the real requested end state, leave the goal active, and do not redefine success around a smaller or easier task.
- Temporary rough edges are acceptable while the work is moving in the right direction. Completion still requires the requested end state to be true and verified.`

/** Where the agent is told to look when it wants to know what is true. */
const WORK_FROM_EVIDENCE = `Work from evidence:
Use the current working tree and external state as authoritative. Previous conversation context can help locate relevant work, but inspect the current state before relying on it. Improve, replace, or remove existing work as needed to satisfy the actual objective.`

/** What counts as movement, and what merely looks like it. */
const FIDELITY_RULES = `Fidelity:
- Optimize each turn for movement toward the requested end state, not for the smallest stable-looking subset or easiest passing change.
- Do not substitute a narrower, safer, smaller, merely compatible, or easier-to-test solution because it is more likely to pass current tests.
- Treat alignment as movement toward the requested end state. An edit is aligned only if it makes the requested final state more true; useful-looking behavior that preserves a different end state is misaligned.`

/** How completion is proven, requirement by requirement. */
const COMPLETION_AUDIT = `Completion audit:
Before deciding that the goal is achieved, treat completion as unproven and verify it against the actual current state:
- Derive concrete requirements from the objective and any referenced files, plans, specifications, issues, or user instructions.
- Preserve the original scope; do not redefine success around the work that already exists.
- For every explicit requirement, numbered item, named artifact, command, test, gate, invariant, and deliverable, identify the authoritative evidence that would prove it, then inspect the relevant current-state sources: files, command output, test results, PR state, rendered artifacts, runtime behavior, or other authoritative evidence.
- For each item, determine whether the evidence proves completion, contradicts completion, shows incomplete work, is too weak or indirect to verify completion, or is missing.
- Match the verification scope to the requirement's scope; do not use a narrow check to support a broad claim.
- Treat tests, manifests, verifiers, green checks, and search results as evidence only after confirming they cover the relevant requirement.
- Treat uncertain or indirect evidence as not achieved; gather stronger evidence or continue the work.
- The audit must prove completion, not merely fail to find obvious remaining work.

Do not rely on intent, partial progress, memory of earlier work, or a plausible final answer as proof of completion. Marking the goal complete is a claim that the full objective has been finished and can withstand requirement-by-requirement scrutiny. Only mark the goal achieved when current evidence proves every requirement has been satisfied and no required work remains. If the evidence is incomplete, weak, indirect, merely consistent with completion, or leaves any requirement missing, incomplete, or unverified, keep working instead of marking the goal complete.`

/** How the plan is kept visible, when the environment has a tool for it. */
function progressVisibility(todoWriteToolName: string | undefined): string {
  return todoWriteToolName === undefined ? `If the next work is meaningfully multi-step, keep a concise plan tied to the real objective and update it as steps complete or the next best action changes. Skip planning overhead for trivial one-step progress, and do not treat a plan update as a substitute for doing the work.` : `If ${todoWriteToolName} is available and the next work is meaningfully multi-step, use it to show a concise plan tied to the real objective. Keep the plan current as steps complete or the next best action changes. Skip planning overhead for trivial one-step progress, and do not treat a plan update as a substitute for doing the work.`
}

/** What completing the goal takes, when the environment has a tool to say so. */
function updateGoalGuidance(updateGoalToolName: string | undefined): string {
  return updateGoalToolName === undefined ? `Do not mark a goal complete merely because you are stopping work.` : `If the objective is achieved, call ${updateGoalToolName} with status "complete" so usage accounting is preserved.

Do not call ${updateGoalToolName} unless the goal is complete or the user paused the goal and wants to resume. Do not mark a goal complete merely because you are stopping work.`
}

export function buildGoalPursuitGuidelines(toolNames: GoalPursuitToolNames = {}): string {
  const { todoWriteToolName, updateGoalToolName } = toolNames
  return [
    CONTINUATION_RULES,
    WORK_FROM_EVIDENCE,
    `Progress visibility:\n${progressVisibility(todoWriteToolName)}`,
    FIDELITY_RULES,
    `${COMPLETION_AUDIT} ${updateGoalGuidance(updateGoalToolName)}`,
  ].join("\n\n")
}

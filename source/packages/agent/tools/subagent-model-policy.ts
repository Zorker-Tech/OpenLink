/**
 * Which model a subagent is allowed to run on.
 *
 * The parent's own model is not always the right one for the work it delegates, and the platform has
 * three different arrangements: no constraint at all, the parent's model pinned because the credential or
 * the harness only covers that one, or a family of models the request may choose from — where the
 * picker may pick, but only within the family.
 */

const policyValues = ["none", "parent_pin", "request_based_agent"] as const

export type SubagentModelForcePolicy = (typeof policyValues)[number]

export const SubagentModelForcePolicy = Object.freeze({
  None: policyValues[0],
  ParentPin: policyValues[1],
  RequestBasedComposer: policyValues[2],
})

export const SUBAGENT_MODEL_FORCE_POLICIES: readonly SubagentModelForcePolicy[] = [
  SubagentModelForcePolicy.None,
  SubagentModelForcePolicy.ParentPin,
  SubagentModelForcePolicy.RequestBasedComposer,
]

export function isSubagentModelForcePolicy(value: unknown): value is SubagentModelForcePolicy {
  return typeof value === "string" && (SUBAGENT_MODEL_FORCE_POLICIES as readonly string[]).includes(value)
}

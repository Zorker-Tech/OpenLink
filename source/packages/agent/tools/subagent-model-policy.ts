/**
 * Which model a subagent is allowed to run on.
 *
 * The parent's own model is not always the right one for the work it delegates, and the platform has
 * three different arrangements: no constraint at all, the parent's model pinned because the credential or
 * the harness only covers that one, or a family of models the request may choose from — where the
 * picker may pick, but only within the family.
 */

export const SubagentModelForcePolicy = {
  None: "none",
  /** The credential or harness covers one model, so the subagent must use it. */
  ParentPin: "parent_pin",
  /** A request-based session: the family is fixed, and the picker may choose within it. */
  RequestBasedComposer: "request_based_composer",
} as const

export type SubagentModelForcePolicy = (typeof SubagentModelForcePolicy)[keyof typeof SubagentModelForcePolicy]

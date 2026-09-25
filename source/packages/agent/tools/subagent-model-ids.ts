/**
 * The model identifiers a subagent may be asked for by name.
 *
 * A session that asks for "a fast subagent" or "the standard one" is asking for one of these, so the
 * names are here rather than spelled out at every call site — and the identifiers themselves are
 * catalogue values, which is why they are matched rather than invented.
 */

export const SubagentModelId = {
  standard: "composer-2.5",
  fast: "composer-2.5-fast",
} as const

export type SubagentModelId = (typeof SubagentModelId)[keyof typeof SubagentModelId]

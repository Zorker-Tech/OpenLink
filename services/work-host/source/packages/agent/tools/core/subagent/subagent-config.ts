/**
 * Subagent types: their names, and what a subagent is given to start from.
 *
 * A type arrives as a name from a user, a slug from a model, or a message from the platform, and the
 * same type has several spellings: `generalPurpose`, `general-purpose`, `general_purpose_subagent`. They
 * are normalized to one form so that a lookup by name works whatever the caller wrote, with one rename
 * carried along because a type was renamed once and conversations still contain the old name.
 *
 * The mapping is the other half: a caller may want to seed a subagent with part of its own state, and a
 * subagent that was given no mapping starts from an empty structure rather than inheriting the parent's —
 * inheriting by default would mean every subagent silently shares the parent's conversation.
 */

export const GENERAL_PURPOSE_SUBAGENT_TYPE = "generalPurpose" as const

export function normalizeSubagentTypeName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, "")
    .replace(/(?<=.)(subagenttype|subagent|agent|mode|type)$/, "")
  if (normalized === "mediareview") return "videoreview"
  return normalized
}

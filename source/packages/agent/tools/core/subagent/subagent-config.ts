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

import { ConversationStateStructure } from "../../../../proto/generated/agent/v1/agent_pb.ts"
import type { SubagentType } from "../../../../proto/generated/agent/v1/subagents_pb.ts"

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

/** The type's name in the form the platform uses, whatever shape it arrived in. */
export function getSubagentTypeName(subagentType: SubagentType): string {
  if (subagentType.type.case === "custom") return subagentType.type.value.name
  if (subagentType.type.case === "unspecified") return GENERAL_PURPOSE_SUBAGENT_TYPE
  if (subagentType.type.case === "computerUse") return "computerUse"
  if (subagentType.type.case === "explore") return "explore"
  if (subagentType.type.case === "bash" || subagentType.type.case === "shell") return "shell"
  if (subagentType.type.case === "browserUse") return "browser-use"
  if (subagentType.type.case === "debug") return "debug"
  if (subagentType.type.case === "cursorGuide") return "cursor-guide"
  if (subagentType.type.case === "mediaReview") return "videoReview"
  if (subagentType.type.case === "watchVideo") return "watchVideo"
  return subagentType.type.case ?? "unknown"
}

/** The types that watch media, which the platform treats as one family. */
export function isGeminiVideoSubagentType(subagentType: SubagentType | undefined): boolean {
  return subagentType?.type.case === "mediaReview" || subagentType?.type.case === "watchVideo"
}

type ConversationStateMappingConfig = {
  readonly conversationStateMapper?:
    | ((callerState: ConversationStateStructure) => ConversationStateStructure)
    | undefined
}

export function applyConversationStateMapping(
  config: ConversationStateMappingConfig,
  callerState: ConversationStateStructure,
): ConversationStateStructure {
  if (config.conversationStateMapper !== undefined) return config.conversationStateMapper(callerState)
  return new ConversationStateStructure()
}

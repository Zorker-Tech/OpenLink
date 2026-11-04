export const SLATE_SUBAGENT_TYPE_NAMES = [
  "generalPurpose",
  "computerUse",
  "explore",
  "shell",
  "browser-use",
  "debug",
  "videoReview",
  "watchVideo",
  "unknown",
] as const

export type SlateSubagentTypeName =
  | (typeof SLATE_SUBAGENT_TYPE_NAMES)[number]
  | (string & { readonly __slateSubagentType?: never })

export interface SlateSubagentTypeLike {
  readonly type: {
    readonly case?: string | undefined
    readonly value?: unknown | undefined
  }
}

const INTEROP_TYPE_NAMES: Readonly<Record<string, SlateSubagentTypeName>> = Object.freeze({
  unspecified: "generalPurpose",
  computerUse: "computerUse",
  explore: "explore",
  bash: "shell",
  shell: "shell",
  browserUse: "browser-use",
  debug: "debug",
  cursorGuide: "cursor-guide",
  mediaReview: "videoReview",
  watchVideo: "watchVideo",
})

export function slateSubagentTypeName(value: SlateSubagentTypeLike): SlateSubagentTypeName {
  const kind = value.type.case
  if (kind === "custom") {
    const custom = value.type.value as { readonly name?: unknown } | undefined
    return typeof custom?.name === "string" ? custom.name : "unknown"
  }
  if (kind === undefined) return "unknown"
  return INTEROP_TYPE_NAMES[kind] ?? kind
}

export function isVideoReviewSubagentType(value: SlateSubagentTypeLike | undefined): boolean {
  const kind = value?.type.case
  return kind === "mediaReview" || kind === "watchVideo"
}

export function isCustomSubagentType(value: SlateSubagentTypeLike): boolean {
  return value.type.case === "custom"
}

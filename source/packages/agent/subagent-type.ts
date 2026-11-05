/** Subagent identities chosen and consumed by Slate's task system. */
export const SlateSubagentKind = {
  GENERAL_PURPOSE: "general-purpose",
  COMPUTER_USE: "computer-use",
  EXPLORE: "explore",
  SHELL: "shell",
  BROWSER_USE: "browser-use",
  DEBUG: "debug",
  VIDEO_REVIEW: "video-review",
  WATCH_VIDEO: "watch-video",
  GUIDE: "guide",
  ENVIRONMENT_SETUP: "environment-setup",
  CUSTOM: "custom",
  UNKNOWN: "unknown",
} as const

export type KnownSlateSubagentKind = (typeof SlateSubagentKind)[keyof typeof SlateSubagentKind]

/** Open for host-installed task kinds; built-in policy branches use the known values above. */
export type SlateSubagentKindValue = KnownSlateSubagentKind | (string & {})

/** Model-facing names retained by task selection and prompt configuration. */
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
  | (string & { readonly __slateSubagentTypeName?: never })

export interface SlateSubagentTypeCompatibility {
  /** Original generated discriminator retained only for migration and runner projection. */
  readonly legacyDiscriminator?: string
}

/** Slate's identity for a kind of delegated task. */
export interface SlateSubagentType {
  readonly kind: SlateSubagentKindValue
  readonly customName?: string
  readonly compatibility?: SlateSubagentTypeCompatibility
}

export function createSlateSubagentType(
  kind: SlateSubagentKindValue,
  options: {
    readonly customName?: string
    readonly compatibility?: SlateSubagentTypeCompatibility
  } = {},
): SlateSubagentType {
  if (typeof kind !== "string" || kind.trim().length === 0) {
    throw new TypeError("Slate subagent kind must be a non-empty string")
  }
  return {
    kind,
    ...(options.customName === undefined ? {} : { customName: options.customName }),
    ...(options.compatibility === undefined ? {} : { compatibility: { ...options.compatibility } }),
  }
}

const TASK_TYPE_NAMES: Readonly<Record<KnownSlateSubagentKind, SlateSubagentTypeName>> = Object.freeze({
  [SlateSubagentKind.GENERAL_PURPOSE]: "generalPurpose",
  [SlateSubagentKind.COMPUTER_USE]: "computerUse",
  [SlateSubagentKind.EXPLORE]: "explore",
  [SlateSubagentKind.SHELL]: "shell",
  [SlateSubagentKind.BROWSER_USE]: "browserUse",
  [SlateSubagentKind.DEBUG]: "debug",
  [SlateSubagentKind.VIDEO_REVIEW]: "videoReview",
  [SlateSubagentKind.WATCH_VIDEO]: "watchVideo",
  [SlateSubagentKind.GUIDE]: "cursor-guide",
  [SlateSubagentKind.ENVIRONMENT_SETUP]: "vmSetupHelper",
  [SlateSubagentKind.CUSTOM]: "unknown",
  [SlateSubagentKind.UNKNOWN]: "unknown",
})

export function slateSubagentTypeName(value: SlateSubagentType): SlateSubagentTypeName {
  if (value.kind === SlateSubagentKind.CUSTOM) return value.customName ?? "unknown"
  if (value.kind === SlateSubagentKind.BROWSER_USE && value.compatibility?.legacyDiscriminator === "browserUse") {
    return "browser-use"
  }
  if (value.kind === SlateSubagentKind.UNKNOWN) {
    return value.compatibility?.legacyDiscriminator || "unknown"
  }
  return TASK_TYPE_NAMES[value.kind as KnownSlateSubagentKind] ?? value.kind
}

export function isVideoReviewSubagentType(value: SlateSubagentType | undefined): boolean {
  return value?.kind === SlateSubagentKind.VIDEO_REVIEW || value?.kind === SlateSubagentKind.WATCH_VIDEO
}

export function isComputerUseSubagentType(value: SlateSubagentType | undefined): boolean {
  return value?.kind === SlateSubagentKind.COMPUTER_USE
}

export function isCustomSubagentType(value: SlateSubagentType): boolean {
  return value.kind === SlateSubagentKind.CUSTOM
}

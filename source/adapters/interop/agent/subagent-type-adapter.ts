import {
  SubagentType,
  SubagentTypeBash,
  SubagentTypeBrowserUse,
  SubagentTypeComputerUse,
  SubagentTypeCursorGuide,
  SubagentTypeCustom,
  SubagentTypeDebug,
  SubagentTypeExplore,
  SubagentTypeMediaReview,
  SubagentTypeShell,
  SubagentTypeUnspecified,
  SubagentTypeVmSetupHelper,
  SubagentTypeWatchVideo,
} from "../proto/generated/agent/v1/subagents_pb.ts"
import { ConversationStateStructure } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  createSlateSubagentType,
  isVideoReviewSubagentType as isSlateVideoReviewSubagentType,
  slateSubagentTypeName,
  SlateSubagentKind,
  type SlateSubagentType,
} from "../../../packages/agent/subagent-type.ts"
import {
  mapSubagentConversationState as mapSlateSubagentConversationState,
  type ConversationStateMappingPort as SlateConversationStateMappingPort,
} from "../../../packages/agent/subagent-conversation-state.ts"

export type CounterpartSubagentType = SubagentType
export type ConversationStateMapperInterop = (callerState: ConversationStateStructure) => ConversationStateStructure

export interface ConversationStateMappingPort extends SlateConversationStateMappingPort {
  readonly conversationStateMapper?: ConversationStateMapperInterop | undefined
}

/** Converts the generated oneof into Slate's independent kind/name vocabulary. */
export function slateSubagentTypeFromInterop(value: CounterpartSubagentType | undefined): SlateSubagentType {
  if (value === undefined) return createSlateSubagentType(SlateSubagentKind.UNKNOWN)
  switch (value.type.case) {
    case "unspecified":
      return createSlateSubagentType(SlateSubagentKind.GENERAL_PURPOSE, { compatibility: { legacyDiscriminator: "unspecified" } })
    case "computerUse":
      return createSlateSubagentType(SlateSubagentKind.COMPUTER_USE, { compatibility: { legacyDiscriminator: "computerUse" } })
    case "custom":
      return createSlateSubagentType(SlateSubagentKind.CUSTOM, {
        ...(value.type.value.name.length === 0 ? {} : { customName: value.type.value.name }),
        compatibility: { legacyDiscriminator: "custom" },
      })
    case "explore":
      return createSlateSubagentType(SlateSubagentKind.EXPLORE, { compatibility: { legacyDiscriminator: "explore" } })
    case "mediaReview":
      return createSlateSubagentType(SlateSubagentKind.VIDEO_REVIEW, { compatibility: { legacyDiscriminator: "mediaReview" } })
    case "bash":
      return createSlateSubagentType(SlateSubagentKind.SHELL, { compatibility: { legacyDiscriminator: "bash" } })
    case "browserUse":
      return createSlateSubagentType(SlateSubagentKind.BROWSER_USE, { compatibility: { legacyDiscriminator: "browserUse" } })
    case "shell":
      return createSlateSubagentType(SlateSubagentKind.SHELL, { compatibility: { legacyDiscriminator: "shell" } })
    case "vmSetupHelper":
      return createSlateSubagentType(SlateSubagentKind.ENVIRONMENT_SETUP, { compatibility: { legacyDiscriminator: "vmSetupHelper" } })
    case "debug":
      return createSlateSubagentType(SlateSubagentKind.DEBUG, { compatibility: { legacyDiscriminator: "debug" } })
    case "cursorGuide":
      return createSlateSubagentType(SlateSubagentKind.GUIDE, { compatibility: { legacyDiscriminator: "cursorGuide" } })
    case "watchVideo":
      return createSlateSubagentType(SlateSubagentKind.WATCH_VIDEO, { compatibility: { legacyDiscriminator: "watchVideo" } })
    case undefined:
      return createSlateSubagentType(SlateSubagentKind.UNKNOWN, { compatibility: { legacyDiscriminator: "" } })
  }
}

/** Projects Slate's kind/name value into the generated message used by the current runner. */
export function subagentTypeToInterop(value: SlateSubagentType | undefined): SubagentType | undefined {
  if (value === undefined) return undefined
  const discriminator = value.compatibility?.legacyDiscriminator
  switch (discriminator) {
    case "unspecified": return new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified() } })
    case "computerUse": return new SubagentType({ type: { case: "computerUse", value: new SubagentTypeComputerUse() } })
    case "custom": return new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: value.customName ?? "" }) } })
    case "explore": return new SubagentType({ type: { case: "explore", value: new SubagentTypeExplore() } })
    case "mediaReview": return new SubagentType({ type: { case: "mediaReview", value: new SubagentTypeMediaReview() } })
    case "bash": return new SubagentType({ type: { case: "bash", value: new SubagentTypeBash() } })
    case "browserUse": return new SubagentType({ type: { case: "browserUse", value: new SubagentTypeBrowserUse() } })
    case "shell": return new SubagentType({ type: { case: "shell", value: new SubagentTypeShell() } })
    case "vmSetupHelper": return new SubagentType({ type: { case: "vmSetupHelper", value: new SubagentTypeVmSetupHelper() } })
    case "debug": return new SubagentType({ type: { case: "debug", value: new SubagentTypeDebug() } })
    case "cursorGuide": return new SubagentType({ type: { case: "cursorGuide", value: new SubagentTypeCursorGuide() } })
    case "watchVideo": return new SubagentType({ type: { case: "watchVideo", value: new SubagentTypeWatchVideo() } })
  }
  switch (value.kind) {
    case SlateSubagentKind.GENERAL_PURPOSE:
      return new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified() } })
    case SlateSubagentKind.COMPUTER_USE:
      return new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: "computerUse" }) } })
    case SlateSubagentKind.EXPLORE:
      return new SubagentType({ type: { case: "explore", value: new SubagentTypeExplore() } })
    case SlateSubagentKind.SHELL:
      return new SubagentType({ type: { case: "shell", value: new SubagentTypeShell() } })
    case SlateSubagentKind.BROWSER_USE:
      return new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: "browserUse" }) } })
    case SlateSubagentKind.DEBUG:
      return new SubagentType({ type: { case: "debug", value: new SubagentTypeDebug() } })
    case SlateSubagentKind.VIDEO_REVIEW:
      return new SubagentType({ type: { case: "mediaReview", value: new SubagentTypeMediaReview() } })
    case SlateSubagentKind.WATCH_VIDEO:
      return new SubagentType({ type: { case: "watchVideo", value: new SubagentTypeWatchVideo() } })
    case SlateSubagentKind.GUIDE:
      return new SubagentType({ type: { case: "cursorGuide", value: new SubagentTypeCursorGuide() } })
    case SlateSubagentKind.ENVIRONMENT_SETUP:
      return new SubagentType({ type: { case: "vmSetupHelper", value: new SubagentTypeVmSetupHelper() } })
    case SlateSubagentKind.CUSTOM:
      return new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: value.customName ?? "" }) } })
    case SlateSubagentKind.UNKNOWN:
      return new SubagentType()
    default:
      return new SubagentType()
  }
}

/** Converts one host configuration record before it enters the Slate task model. */
export function slateSubagentConfigFromInterop(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, "subagent_type")) return value
  const { subagent_type: interopType, ...fields } = record
  return {
    ...fields,
    subagentType: slateSubagentTypeFromInterop(interopType as SubagentType | undefined),
  }
}

export function subagentTypeNameFromInterop(value: CounterpartSubagentType): string {
  return slateSubagentTypeName(slateSubagentTypeFromInterop(value))
}

export function isVideoReviewSubagentType(value: CounterpartSubagentType | undefined): boolean {
  return isSlateVideoReviewSubagentType(slateSubagentTypeFromInterop(value))
}

export function mapSubagentConversationState(
  config: ConversationStateMappingPort,
  callerState: ConversationStateStructure,
): ConversationStateStructure {
  return mapSlateSubagentConversationState(config, callerState, new ConversationStateStructure())
}

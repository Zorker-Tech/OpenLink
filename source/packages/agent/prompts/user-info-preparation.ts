/**
 * When the first user message has to be rebuilt, and what is read back out of it.
 *
 * The context block is written once and reused for every later turn, so the question this file answers
 * is whether the block still describes the session. It answers it from the message itself rather than
 * from stored state, because the message is what the model saw: the rules it was given, the subagent
 * descriptions it was offered, whether its on-demand tools were listed under a namespace, and which of
 * the generated rules are present. A session whose tools changed needs the block rewritten; one whose
 * rules merely moved does not.
 *
 * The rest of the file reads the metadata the block carries for later turns: how complete the context
 * was when it was written (a later turn that recovers more of it is worth rebuilding for), which
 * summarization epoch it belongs to, whether the cloud worker procedure was left out, whether the
 * conversation has since been summarized, and where the cloud testing sections were placed.
 */

import { PrivacyCapability } from "../../redaction/classification.ts"
import { fromRedactedCoreMessage } from "../../redaction/message-redaction.ts"
import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.ts"
import {
  getGeneratedUserRulesForModel,
  type UserRuleFeatureFlags,
  type UserRuleModelInfo,
  type UserRuleOptions,
} from "./custom-user-rules.ts"
import {
  parseRequestContextCompletenessMetadata,
  parseUserInfoSummarizationEpochMetadata,
  userInfoMatchesAvailableSubagentModels,
  userInfoMatchesAvailableSubagentTypes,
  userInfoMatchesDynamicToolSnapshot,
} from "./user-info-rerender.ts"
import { parseCloudTestingSectionsPlacementMetadata } from "./cloud-testing-sections.ts"
import { renderMultitaskModeEnterUserReminderInner } from "./multitask-mode-reminders.ts"

type UserMessageContent = string | readonly { readonly type: string; readonly text: string }[]

function userMessagePlainText(message: { readonly content: UserMessageContent }): string | undefined {
  const content = message.content
  if (typeof content === "string") return content.length > 0 ? content : undefined
  if (!Array.isArray(content)) return undefined
  const text = content.filter(part => part.type === "text").map(part => part.text).join("\n")
  return text.length > 0 ? text : undefined
}

export type PriorUserInfoMessage = Parameters<typeof fromRedactedCoreMessage>[0] & {
  readonly role: string
  readonly providerOptions?: {
    readonly cursor?: {
      readonly requestContextCompleteness?: unknown
      readonly userInfoSummarizationEpoch?: unknown
      readonly omitCloudWorkerProcedure?: unknown
      readonly isSummary?: unknown
      readonly composer2CloudTestingSectionsPlacement?: unknown
    } | undefined
  } | undefined
}

type UserInfoRerenderOptions = UserRuleOptions & {
  readonly availableSubagentModelsDescription?: string | undefined
  readonly availableSubagentTypesDescription?: string | undefined
  readonly skipDynamicToolSnapshotCheck?: boolean | undefined
  readonly mcpMetaToolOptions?: Parameters<typeof userInfoMatchesDynamicToolSnapshot>[1]
}

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, "")
}

// A generated rule is recognized by its own text, whitespace-insensitively: the block may have been
// reflowed since it was written, and that is not a reason to rebuild the message.
const GENERATED_RULES_PRESENCE_SENTINEL = stripWhitespace(
  getGeneratedUserRulesForModel(undefined, { enableComposer2CustomUserRules: true })[0] ?? "",
)
const FINAL_RESPONSE_RULE_SENTINEL = stripWhitespace(
  getGeneratedUserRulesForModel(undefined, { enableTahomaUserRuleIntervention: true })[0] ?? "",
)
const FRONTEND_DESIGN_RULE_SENTINEL = stripWhitespace(
  getGeneratedUserRulesForModel(undefined, { enableVegaFrontendUserRuleIntervention: true })[0] ?? "",
)

function userInfoHasAnyGeneratedCustomUserRules(content: string): boolean {
  const stripped = stripWhitespace(content)
  return stripped.includes(GENERATED_RULES_PRESENCE_SENTINEL) ||
    stripped.includes(FINAL_RESPONSE_RULE_SENTINEL) ||
    stripped.includes(FRONTEND_DESIGN_RULE_SENTINEL)
}

/** Whether the block carries exactly the generated rules this session's flags and model ask for. */
function userInfoHasExpectedCustomUserRules(
  content: string,
  modelInfo: UserRuleModelInfo | undefined,
  featureFlags: UserRuleFeatureFlags | undefined,
  options: UserInfoRerenderOptions | undefined,
): boolean {
  const stripped = stripWhitespace(content)
  const resolvedFeatureFlags = { enableComposer2CustomUserRules: true, ...featureFlags }
  const rules = getGeneratedUserRulesForModel(modelInfo, resolvedFeatureFlags, options)
  const strippedRules = rules.map(stripWhitespace)
  const expectsFinalResponseRule = featureFlags?.enableTahomaUserRuleIntervention === true
  const hasFinalResponseRule = stripped.includes(FINAL_RESPONSE_RULE_SENTINEL)
  const expectsFrontendDesignRule = featureFlags?.enableVegaFrontendUserRuleIntervention === true
  const hasFrontendDesignRule = stripped.includes(FRONTEND_DESIGN_RULE_SENTINEL)
  const expectsGeneratedRules = strippedRules.some(rule => rule === GENERATED_RULES_PRESENCE_SENTINEL)
  const hasGeneratedRules = stripped.includes(GENERATED_RULES_PRESENCE_SENTINEL)
  if (
    hasFinalResponseRule !== expectsFinalResponseRule ||
    hasFrontendDesignRule !== expectsFrontendDesignRule ||
    hasGeneratedRules !== expectsGeneratedRules
  ) {
    return false
  }
  return rules.length > 0 && strippedRules.every(rule => stripped.includes(rule))
}

export function shouldRerenderUserInfo(
  hasExistingNonSystemMessages: boolean,
  priorMessages: readonly PriorUserInfoMessage[],
  expectedCustomUserRules: readonly string[],
  modelInfo: UserRuleModelInfo | undefined,
  forceRerender: boolean,
  featureFlags: UserRuleFeatureFlags | undefined,
  options: UserInfoRerenderOptions | undefined,
): boolean {
  if (!hasExistingNonSystemMessages || priorMessages.length === 0) return false
  const firstMsg = priorMessages[0]
  if (firstMsg?.role !== "user") return false
  const plainFirst = fromRedactedCoreMessage(firstMsg, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  const contentStr = userMessagePlainText(plainFirst as { readonly content: UserMessageContent })
  if (contentStr === undefined) return false
  if (!contentStr.includes("<user_info>")) return false
  if (forceRerender) return true
  if (!userInfoMatchesAvailableSubagentModels(contentStr, options?.availableSubagentModelsDescription)) return true
  if (!userInfoMatchesAvailableSubagentTypes(contentStr, options?.availableSubagentTypesDescription)) return true
  if (options?.skipDynamicToolSnapshotCheck !== true && !userInfoMatchesDynamicToolSnapshot(contentStr, options?.mcpMetaToolOptions)) {
    return true
  }
  const wantsCustomUserRules = expectedCustomUserRules.length > 0
  if (wantsCustomUserRules) return !userInfoHasExpectedCustomUserRules(contentStr, modelInfo, featureFlags, options)
  // Nothing wants generated rules, so any that are present are stale.
  return userInfoHasAnyGeneratedCustomUserRules(contentStr)
}

export function getFirstUserInfoRequestContextCompleteness(priorMessages: readonly PriorUserInfoMessage[]) {
  const firstMsg = priorMessages[0]
  if (firstMsg?.role !== "user") return undefined
  return parseRequestContextCompletenessMetadata(firstMsg.providerOptions?.cursor?.requestContextCompleteness)
}

export function getFirstUserInfoSummarizationEpoch(priorMessages: readonly PriorUserInfoMessage[]) {
  const firstMsg = priorMessages[0]
  if (firstMsg?.role !== "user") return undefined
  return parseUserInfoSummarizationEpochMetadata(firstMsg.providerOptions?.cursor?.userInfoSummarizationEpoch)
}

export function getFirstUserInfoOmitCloudWorkerProcedure(priorMessages: readonly PriorUserInfoMessage[]): boolean {
  return priorMessages[0]?.providerOptions?.cursor?.omitCloudWorkerProcedure === true
}

export function hasSummaryCarrierMessage(priorMessages: readonly PriorUserInfoMessage[]): boolean {
  return priorMessages.some(message => message.providerOptions?.cursor?.isSummary === true)
}

export function getFirstUserInfoCloudTestingSectionsPlacement(priorMessages: readonly PriorUserInfoMessage[]) {
  const firstMsg = priorMessages[0]
  if (firstMsg?.role !== "user") return undefined
  const placement = parseCloudTestingSectionsPlacementMetadata(
    firstMsg.providerOptions?.cursor?.composer2CloudTestingSectionsPlacement,
  )
  if (placement !== undefined) return placement
  return getFirstUserInfoMessageContent(priorMessages) !== undefined ? "user_info" : undefined
}

export function getFirstUserInfoMessageContent(priorMessages: readonly PriorUserInfoMessage[]) {
  const firstMsg = priorMessages[0]
  if (firstMsg?.role !== "user") return undefined
  const plainFirst = fromRedactedCoreMessage(firstMsg, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  const contentStr = userMessagePlainText(plainFirst as { readonly content: UserMessageContent })
  if (contentStr === undefined || !contentStr.includes("<user_info>")) return undefined
  return contentStr
}

// The reminder is recognized by the opening of its own text, so a reflowed reminder is still found.
const MULTITASK_MODE_ENTER_REMINDER_SENTINEL = stripWhitespace(
  renderMultitaskModeEnterUserReminderInner("Task").slice(0, 40),
)

export function userInfoHasMultitaskModeEnterReminder(content: string): boolean {
  return stripWhitespace(content).includes(MULTITASK_MODE_ENTER_REMINDER_SENTINEL)
}

/**
 * Whether the enter reminder, which used to live in its own message, belongs in the context block: the
 * conversation was summarized (so its own message is gone) while the mode stayed on, and the block does
 * not carry it yet.
 */
export function shouldMigrateMultitaskEnterReminderToUserInfo(params: {
  readonly hasExistingNonSystemMessages: boolean
  readonly previousTurnMode: AgentMode | undefined
  readonly resolvedTurnMode: AgentMode
  readonly priorMessages: readonly PriorUserInfoMessage[]
  readonly firstUserInfoContent: string | undefined
  readonly userInfoAlreadyHasMultitaskEnterReminder: boolean
}): boolean {
  return params.hasExistingNonSystemMessages &&
    params.previousTurnMode === AgentMode.MULTITASK &&
    params.resolvedTurnMode === AgentMode.MULTITASK &&
    params.firstUserInfoContent !== undefined &&
    !params.userInfoAlreadyHasMultitaskEnterReminder &&
    hasSummaryCarrierMessage(params.priorMessages)
}

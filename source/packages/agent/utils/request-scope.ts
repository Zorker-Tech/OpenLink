/**
 * What a request is, as far as the code that runs inside it can tell.
 *
 * A request carries more than an id: who it came from (an agent, a subagent, a client version), which
 * conversation it belongs to, whether it may fall back to a larger model, and the metrics tags that
 * describe the client. All of it lives on the context, so a handler deep in a turn can read what it
 * needs without anything being passed down to it.
 */

import { createKey, type Context } from "../../context/context.ts"
import { INHERITABLE_SPAN_ATTRIBUTES_KEY } from "../../context/telemetry.ts"
import { getInvocationIdFromRequestId, invocationIdGeneratorKey } from "./invocation-id.ts"

export const requestIdKey = createKey<string | undefined>(Symbol("requestId"), undefined)
export const parentRequestIdKey = createKey<string | undefined>(Symbol("parentRequestId"), undefined)
export const rootParentRequestIdKey = createKey<string | undefined>(Symbol("rootParentRequestId"), undefined)
export const parentAgentToolCallIdKey = createKey<string | undefined>(Symbol("parentAgentToolCallId"), undefined)
export const directMetaParentChildSubagentKey = createKey<boolean | undefined>(
  Symbol("directMetaParentChildSubagent"),
  undefined,
)
export const requestModelNameKey = createKey<string | undefined>(Symbol("requestModelName"), undefined)
export const conversationGroupIdKey = createKey<string | undefined>(Symbol("conversationGroupId"), undefined)
export const conversationIdKey = createKey<string | undefined>(Symbol("conversationId"), undefined)
export const bubbleRetryableTaskErrorsKey = createKey<boolean | undefined>(
  Symbol("bubbleRetryableTaskErrors"),
  undefined,
)

export const getRequestId = (ctx: Context): string | undefined => ctx.get(requestIdKey)
export const getParentRequestId = (ctx: Context): string | undefined => ctx.get(parentRequestIdKey)
export const getRootParentRequestId = (ctx: Context): string | undefined => ctx.get(rootParentRequestIdKey)
export const getIsDirectMetaParentChildSubagentFromContext = (ctx: Context): boolean =>
  ctx.get(directMetaParentChildSubagentKey) === true

/** A subagent runs as its own request, with its parent recorded and its own invocation numbering. */
export const createSubagentContext = (
  ctx: Context,
  subagentRequestId: string,
  parentAgentToolCallId: string | undefined,
): Context => {
  const parentRequestId = getRequestId(ctx)
  const rootParentRequestId = getRootParentRequestId(ctx) ?? parentRequestId
  return ctx
    .with(requestIdKey, subagentRequestId)
    .with(invocationIdGeneratorKey, () => getInvocationIdFromRequestId(subagentRequestId))
    .with(parentRequestIdKey, parentRequestId)
    .with(rootParentRequestIdKey, rootParentRequestId)
    .with(directMetaParentChildSubagentKey, undefined)
    .with(parentAgentToolCallIdKey, parentAgentToolCallId)
}

export const getConversationGroupId = (ctx: Context): string | undefined =>
  ctx.get(conversationGroupIdKey) ?? ctx.get(conversationIdKey)
export const getConversationId = (ctx: Context): string | undefined => ctx.get(conversationIdKey)
export const getShouldBubbleRetryableTaskErrorsFromContext = (ctx: Context): boolean =>
  ctx.get(bubbleRetryableTaskErrorsKey) === true

export const clientVersionKey = createKey<string | undefined>(Symbol("clientVersion"), undefined)
const CLIENT_VERSION_SEMVER_REGEX =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const CLIENT_VERSION_PRODUCT_PREFIXES = ["sdk-python-", "sdk-", "agentkit-"]
export const clientTypeKey = createKey<string | undefined>(Symbol("clientType"), undefined)
export const clientRemoteTypeKey = createKey<string | undefined>(Symbol("clientRemoteType"), undefined)
export const clientOsKey = createKey<string | undefined>(Symbol("clientOs"), undefined)
const CLIENT_OS_METRIC_VALUES = new Set(["darwin", "win32", "linux", "ios", "android"])

function normalizeClientOsMetricTag(rawOs: string | undefined): string {
  if (rawOs === undefined || rawOs.trim() === "") return "unknown"
  const os = rawOs.trim().toLowerCase()
  if (os === "windows") return "win32"
  return CLIENT_OS_METRIC_VALUES.has(os) ? os : "other"
}

/**
 * The client's version as a metric tag: a product prefix (`sdk-python-`, `sdk-`) is stripped and the
 * rest has to look like a version, so a client that reports something else does not pollute the metric
 * with unbounded strings.
 */
export function getClientVersionMetricTagsFromContext(ctx: Context): {
  clientversion: string
  clienttype: string
} {
  const rawVersion = ctx.get(clientVersionKey)?.trim()
  let version = "unknown"
  if (rawVersion !== undefined && rawVersion !== "") {
    const lower = rawVersion.toLowerCase()
    const prefix = CLIENT_VERSION_PRODUCT_PREFIXES.find(value => lower.startsWith(value))
    const candidate = prefix === undefined ? rawVersion : rawVersion.slice(prefix.length)
    if (CLIENT_VERSION_SEMVER_REGEX.test(candidate)) version = candidate.replace(/^v/, "")
  }
  return { clientversion: version, clienttype: ctx.get(clientTypeKey) ?? "unknown" }
}

export function getSdkFlavorMetricTagFromContext(ctx: Context): { sdkflavor: string } {
  const rawVersion = ctx.get(clientVersionKey)?.trim().toLowerCase()
  if (rawVersion === undefined) return { sdkflavor: "none" }
  if (rawVersion.startsWith("sdk-python-")) return { sdkflavor: "python" }
  if (rawVersion.startsWith("sdk-")) return { sdkflavor: "ts" }
  if (rawVersion.startsWith("agentkit-")) return { sdkflavor: "agentkit" }
  return { sdkflavor: "none" }
}

export function getClientRemoteTypeMetricTagFromContext(ctx: Context): { remoteType: string } {
  return { remoteType: ctx.get(clientRemoteTypeKey) ?? "unknown" }
}

export function getClientOsMetricTagFromContext(ctx: Context): { os: string } {
  return { os: normalizeClientOsMetricTag(ctx.get(clientOsKey)) }
}

export const membershipTypeKey = createKey<string | undefined>(Symbol("membershipType"), undefined)

export function getMembershipTypeMetricTagsFromContext(ctx: Context): { membershiptype: string } {
  return { membershiptype: ctx.get(membershipTypeKey) ?? "unknown" }
}

export const isAutoKey = createKey<boolean | undefined>(Symbol("isAuto"), undefined)
export const isPremiumKey = createKey<boolean | undefined>(Symbol("isPremium"), undefined)
export const teamIdKey = createKey<number | undefined>(Symbol("teamId"), undefined)
export const isUserApiKeyKey = createKey<boolean | undefined>(Symbol("isUserApiKey"), undefined)
export const maxModeKey = createKey<boolean | undefined>(Symbol("maxMode"), undefined)
export const autoRoutingReasonKey = createKey<string | undefined>(Symbol("autoRoutingReason"), undefined)

const IS_DEV_SPAN_ATTRIBUTE = "user.is_dev"
/** The team id this platform's own deployments belong to; used only to tag internal traffic. */
const INTERNAL_TEAM_ID = 1

export function getIsAutoFromContext(ctx: Context): boolean {
  return ctx.get(isAutoKey) === true
}

export function getIsPremiumFromContext(ctx: Context): boolean {
  return ctx.get(isPremiumKey) === true
}

export function getIsInternalTeamFromContext(ctx: Context): boolean {
  const teamId = ctx.get(teamIdKey)
  return teamId !== undefined && teamId === INTERNAL_TEAM_ID
}

export function getIsUserApiKeyFromContext(ctx: Context): boolean {
  return ctx.get(isUserApiKeyKey) === true
}

export function getIsDevFromContext(ctx: Context): boolean {
  return ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY)[IS_DEV_SPAN_ATTRIBUTE] === true
}

export function getIsSubagentFromContext(ctx: Context): boolean {
  return ctx.get(parentRequestIdKey) !== undefined
}

export function getMaxModeFromContext(ctx: Context): boolean {
  return ctx.get(maxModeKey) === true
}

export function getAutoRoutingReasonFromContext(ctx: Context): string {
  return ctx.get(autoRoutingReasonKey) ?? "unknown"
}

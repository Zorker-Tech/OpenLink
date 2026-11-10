/**
 * What a request is, as far as the code that runs inside it can tell.
 *
 * A request carries more than an id: who it came from (an agent, a subagent, a client version), which
 * conversation it belongs to, whether it may fall back to a larger model, and the metrics tags that
 * describe the client. All of it lives on the context, so a handler deep in a turn can read what it
 * needs without anything being passed down to it.
 */

import { createKey, type Context } from "../../context/context.ts"
import { getInvocationIdFromRequestId, invocationIdGeneratorKey } from "./invocation-id.ts"

export interface RequestLineage {
  readonly requestId?: string | undefined;
  readonly parentRequestId?: string | undefined;
  readonly rootParentRequestId?: string | undefined;
  readonly parentToolCallId?: string | undefined;
  readonly directMetaParentChild?: boolean | undefined;
}

const requestLineageKey = createKey<RequestLineage>(Symbol("slateRequestLineage"), {})
export const requestModelNameKey = createKey<string | undefined>(Symbol("requestModelName"), undefined)
export const conversationGroupIdKey = createKey<string | undefined>(Symbol("conversationGroupId"), undefined)
export const conversationIdKey = createKey<string | undefined>(Symbol("conversationId"), undefined)
export const bubbleRetryableTaskErrorsKey = createKey<boolean | undefined>(
  Symbol("bubbleRetryableTaskErrors"),
  undefined,
)

function patchRequestLineage(ctx: Context, patch: RequestLineage): Context {
  return ctx.with(requestLineageKey, { ...ctx.get(requestLineageKey), ...patch })
}

export const withRequestId = (ctx: Context, requestId: string | undefined): Context =>
  patchRequestLineage(ctx, { requestId })
export const withParentRequestId = (ctx: Context, parentRequestId: string | undefined): Context =>
  patchRequestLineage(ctx, { parentRequestId })
export const withRootParentRequestId = (ctx: Context, rootParentRequestId: string | undefined): Context =>
  patchRequestLineage(ctx, { rootParentRequestId })
export const withParentAgentToolCallId = (ctx: Context, parentToolCallId: string | undefined): Context =>
  patchRequestLineage(ctx, { parentToolCallId })
export const withDirectMetaParentChildSubagent = (ctx: Context, enabled: boolean | undefined): Context =>
  patchRequestLineage(ctx, { directMetaParentChild: enabled })

export const getRequestId = (ctx: Context): string | undefined => ctx.get(requestLineageKey).requestId
export const getParentRequestId = (ctx: Context): string | undefined => ctx.get(requestLineageKey).parentRequestId
export const getRootParentRequestId = (ctx: Context): string | undefined => ctx.get(requestLineageKey).rootParentRequestId
export const getParentAgentToolCallId = (ctx: Context): string | undefined => ctx.get(requestLineageKey).parentToolCallId
export const getIsDirectMetaParentChildSubagentFromContext = (ctx: Context): boolean =>
  ctx.get(requestLineageKey).directMetaParentChild === true

/** A subagent runs as its own request, with its parent recorded and its own invocation numbering. */
export const createSubagentContext = (
  ctx: Context,
  subagentRequestId: string,
  parentAgentToolCallId: string | undefined,
): Context => {
  const parentRequestId = getRequestId(ctx)
  const rootParentRequestId = getRootParentRequestId(ctx) ?? parentRequestId
  return patchRequestLineage(ctx, {
    requestId: subagentRequestId,
    parentRequestId,
    rootParentRequestId,
    parentToolCallId: parentAgentToolCallId,
    directMetaParentChild: undefined,
  })
    .with(invocationIdGeneratorKey, () => getInvocationIdFromRequestId(subagentRequestId))
}

export const getConversationGroupId = (ctx: Context): string | undefined =>
  ctx.get(conversationGroupIdKey) ?? ctx.get(conversationIdKey)
export const getConversationId = (ctx: Context): string | undefined => ctx.get(conversationIdKey)
export const getShouldBubbleRetryableTaskErrorsFromContext = (ctx: Context): boolean =>
  ctx.get(bubbleRetryableTaskErrorsKey) === true

export function getIsSubagentFromContext(ctx: Context): boolean {
  return getParentRequestId(ctx) !== undefined
}

export {
  autoRoutingReasonKey,
  clientOsKey,
  clientRemoteTypeKey,
  clientTypeKey,
  clientVersionKey,
  getAutoRoutingReasonFromContext,
  getClientOsMetricTagFromContext,
  getClientRemoteTypeMetricTagFromContext,
  getClientVersionMetricTagsFromContext,
  getIsAutoFromContext,
  getIsDevFromContext,
  getIsInternalTeamFromContext,
  getIsPremiumFromContext,
  getIsUserApiKeyFromContext,
  getMaxModeFromContext,
  getMembershipTypeMetricTagsFromContext,
  getSdkFlavorMetricTagFromContext,
  isAutoKey,
  isPremiumKey,
  isUserApiKeyKey,
  maxModeKey,
  membershipTypeKey,
  teamIdKey,
} from "../../../shared/observability/request-scope-telemetry.ts"

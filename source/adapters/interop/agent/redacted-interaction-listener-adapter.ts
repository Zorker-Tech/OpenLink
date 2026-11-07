/**
 * An interaction listener that speaks redacted messages.
 *
 * A listener can be written against plain messages while the layer it is plugged into deals in redacted
 * ones (or the other way round), and both directions are needed: the adapters here convert on the way
 * in and out, so a listener never has to know which side of the privacy boundary it sits on. Redacting
 * is the mode's business; reading back a redacted message is an internal read, which is what the
 * purpose used for the conversion says.
 */

import type { InteractionQuery, InteractionResponse, InteractionUpdate } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  fromRedactedInteractionQuery,
  fromRedactedInteractionResponse,
  fromRedactedInteractionUpdate,
  toRedactedInteractionQuery,
  toRedactedInteractionResponse,
  toRedactedInteractionUpdate as toRedactedInteractionUpdateMessage,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import type {
  SlateInteractionQuery,
  SlateInteractionResponse,
} from "../../../packages/agent-core/interaction-queries.ts"
import type {
  SlateTaskProgressUpdate,
  SlateTaskProgressUpdateView,
} from "../../../packages/agent/tools/task-progress-state.ts"
import { taskProgressUpdateForListener } from "./task-progress-protocol-adapter.ts"
import {
  fromInteropInteractionQuery,
  fromInteropInteractionResponse,
  toInteropInteractionQuery,
  toInteropInteractionResponse,
} from "./interaction-query-adapter.ts"

type MaybePromise<T> = T | Promise<T>

export interface InteractionListenerAdapter<Context, Update, Query, Response, ProgressUpdate = never> {
  sendUpdate(ctx: Context, update: Update): MaybePromise<void>
  query(ctx: Context, query: Query): MaybePromise<Response>
  sendTaskProgressUpdate?: ((ctx: Context, toolCallId: string, update: ProgressUpdate) => MaybePromise<void>) | undefined
  enqueuePostTurnEndedWork?: ((work: () => Promise<unknown>) => void) | undefined
  flushPostTurnEndedWork?: ((ctx: Context) => MaybePromise<void>) | undefined
}

type RedactedInteractionUpdate = ReturnType<typeof toRedactedInteractionUpdateMessage>
type RedactedInteractionQuery = ReturnType<typeof toRedactedInteractionQuery>
type RedactedInteractionResponse = ReturnType<typeof toRedactedInteractionResponse>

/** Encodes one Slate interaction update for the privacy-aware Agent transport. */
export function redactInteractionUpdate(update: InteractionUpdate, privacyMode: PrivacyMode): RedactedInteractionUpdate {
  return toRedactedInteractionUpdateMessage(update, privacyMode)
}

/** Wraps a redacted listener so a plain caller can use it: it redacts what it sends and reads replies. */
export function toUnredactedInteractionListener<Context>(
  delegate: InteractionListenerAdapter<
    Context,
    RedactedInteractionUpdate,
    RedactedInteractionQuery,
    RedactedInteractionResponse,
    SlateTaskProgressUpdate
  >,
  privacyMode: PrivacyMode,
): InteractionListenerAdapter<Context, InteractionUpdate, SlateInteractionQuery, SlateInteractionResponse, SlateTaskProgressUpdate> {
  return {
    async sendUpdate(ctx, update) {
      await delegate.sendUpdate(ctx, redactInteractionUpdate(update, privacyMode))
    },
    sendTaskProgressUpdate: delegate.sendTaskProgressUpdate
      ? async (ctx, toolCallId, update) => {
          await delegate.sendTaskProgressUpdate?.(ctx, toolCallId, update)
        }
      : undefined,
    async query(ctx, query) {
      const redactedResponse = await delegate.query(
        ctx,
        toRedactedInteractionQuery(toInteropInteractionQuery(query), privacyMode),
      )
      const wireResponse = (fromRedactedInteractionResponse as unknown as (
        value: RedactedInteractionResponse,
        purpose: PrivacyCapability,
      ) => InteractionResponse)(redactedResponse, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
      return fromInteropInteractionResponse(wireResponse)
    },
    enqueuePostTurnEndedWork: delegate.enqueuePostTurnEndedWork
      ? work => delegate.enqueuePostTurnEndedWork?.(work)
      : undefined,
    flushPostTurnEndedWork: delegate.flushPostTurnEndedWork
      ? ctx => delegate.flushPostTurnEndedWork?.(ctx)
      : undefined,
  }
}

/** Wraps a plain listener so a redacted caller can use it: it reads what it is given and redacts replies. */
export function toRedactedInteractionListener<Context>(
  delegate: InteractionListenerAdapter<Context, InteractionUpdate, SlateInteractionQuery, SlateInteractionResponse, SlateTaskProgressUpdateView>,
  privacyMode: PrivacyMode,
): InteractionListenerAdapter<
  Context,
  RedactedInteractionUpdate,
  RedactedInteractionQuery,
  RedactedInteractionResponse,
  SlateTaskProgressUpdate
> {
  return {
    async sendUpdate(ctx, update) {
      await delegate.sendUpdate(
        ctx,
        (fromRedactedInteractionUpdate as unknown as (
          value: RedactedInteractionUpdate,
          purpose: PrivacyCapability,
        ) => InteractionUpdate)(update, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      )
    },
    sendTaskProgressUpdate: delegate.sendTaskProgressUpdate
      ? async (ctx, toolCallId, update) => {
          await delegate.sendTaskProgressUpdate?.(
            ctx,
            toolCallId,
            taskProgressUpdateForListener(update, privacyMode),
          )
        }
      : undefined,
    async query(ctx, query) {
      const queryMessage = (fromRedactedInteractionQuery as unknown as (
        value: RedactedInteractionQuery,
        purpose: PrivacyCapability,
      ) => InteractionQuery)(query, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
      const response = await delegate.query(
        ctx,
        fromInteropInteractionQuery(queryMessage),
      )
      return toRedactedInteractionResponse(toInteropInteractionResponse(response), privacyMode)
    },
    enqueuePostTurnEndedWork: delegate.enqueuePostTurnEndedWork
      ? work => delegate.enqueuePostTurnEndedWork?.(work)
      : undefined,
    flushPostTurnEndedWork: delegate.flushPostTurnEndedWork
      ? ctx => delegate.flushPostTurnEndedWork?.(ctx)
      : undefined,
  }
}

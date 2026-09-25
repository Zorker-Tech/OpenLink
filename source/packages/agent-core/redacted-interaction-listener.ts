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
  toRedactedInteractionUpdate,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../redaction/classification.ts"
import type { PrivacyMode } from "../redaction/privacy-mode.ts"

type MaybePromise<T> = T | Promise<T>

export interface InteractionListenerAdapter<Context, Update, Query, Response> {
  sendUpdate(ctx: Context, update: Update): MaybePromise<void>
  query(ctx: Context, query: Query): MaybePromise<Response>
  enqueuePostTurnEndedWork?: ((work: () => Promise<unknown>) => void) | undefined
  flushPostTurnEndedWork?: ((ctx: Context) => MaybePromise<void>) | undefined
}

type RedactedInteractionUpdate = ReturnType<typeof toRedactedInteractionUpdate>
type RedactedInteractionQuery = ReturnType<typeof toRedactedInteractionQuery>
type RedactedInteractionResponse = ReturnType<typeof toRedactedInteractionResponse>

/** Wraps a redacted listener so a plain caller can use it: it redacts what it sends and reads replies. */
export function toUnredactedInteractionListener<Context>(
  delegate: InteractionListenerAdapter<
    Context,
    RedactedInteractionUpdate,
    RedactedInteractionQuery,
    RedactedInteractionResponse
  >,
  privacyMode: PrivacyMode,
): InteractionListenerAdapter<Context, InteractionUpdate, InteractionQuery, InteractionResponse> {
  return {
    async sendUpdate(ctx, update) {
      await delegate.sendUpdate(ctx, toRedactedInteractionUpdate(update, privacyMode))
    },
    async query(ctx, query) {
      const redactedResponse = await delegate.query(ctx, toRedactedInteractionQuery(query, privacyMode))
      return (fromRedactedInteractionResponse as unknown as (
        value: RedactedInteractionResponse,
        purpose: PrivacyCapability,
      ) => InteractionResponse)(redactedResponse, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
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
  delegate: InteractionListenerAdapter<Context, InteractionUpdate, InteractionQuery, InteractionResponse>,
  privacyMode: PrivacyMode,
): InteractionListenerAdapter<
  Context,
  RedactedInteractionUpdate,
  RedactedInteractionQuery,
  RedactedInteractionResponse
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
    async query(ctx, query) {
      const response = await delegate.query(
        ctx,
        (fromRedactedInteractionQuery as unknown as (
          value: RedactedInteractionQuery,
          purpose: PrivacyCapability,
        ) => InteractionQuery)(query, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      )
      return toRedactedInteractionResponse(response, privacyMode)
    },
    enqueuePostTurnEndedWork: delegate.enqueuePostTurnEndedWork
      ? work => delegate.enqueuePostTurnEndedWork?.(work)
      : undefined,
    flushPostTurnEndedWork: delegate.flushPostTurnEndedWork
      ? ctx => delegate.flushPostTurnEndedWork?.(ctx)
      : undefined,
  }
}

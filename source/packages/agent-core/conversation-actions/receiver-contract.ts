/**
 * What a conversation-action receiver has to provide.
 *
 * A turn loop needs to know whether the user has queued an action — a steer, a claim on an injection —
 * and to take it exactly once. The queue itself lives outside this module (whoever owns the client's
 * outbox owns it); what is written down here is only the surface the loop consumes, so the loop can be
 * read and tested without the queue implementation.
 */

import type { Context } from "../../context/context.ts"
import type { ConversationAction } from "../../proto/generated/agent/v1/agent_pb.ts"

export interface ConversationActionReceiverEntry {
  readonly action: ConversationAction
}

export interface ConversationActionReceiver {
  /** The next action, without taking it: the loop decides whether it can handle it now. */
  peek(ctx: Context): Promise<ConversationActionReceiverEntry | undefined>
  /** Takes the action peeked at, so it is handled once. */
  pop(ctx: Context): Promise<undefined>
  peekIsClaimedInjection?(): boolean
  failConsumedInjectionDelivery?(): void
  getContextInjectionToolSignal?(): unknown
}

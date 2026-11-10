/**
 * The handler for a cancellation that should never have reached the turn.
 *
 * Cancelling a conversation is handled where the conversation is, not inside the stream that is being
 * cancelled: by the time this handler runs the decision has already been made, and continuing would mean
 * the turn had been cancelled and then kept going anyway. So it refuses loudly rather than quietly doing
 * nothing, because reaching it means a caller routed the action to the wrong place.
 */

import type { SlateCancelActionPayload } from "./cancel-action-contracts.ts"

/** The refusal a cancellation raises when it reaches the turn runner: it was routed to the wrong place. */
const CANCEL_CONVERSATION_ACTION_MISROUTED =
  "Cancel Conversation action should never be routed directly to runStream!";

/** Refuse the call rather than carry on: the cancellation has already been decided somewhere else. */
function refuseMisroutedCancelConversation(): never {
  throw new Error(CANCEL_CONVERSATION_ACTION_MISROUTED);
}

export class CancelActionHandler {
  constructor(
    readonly config: unknown,
    readonly resourceAccessor: unknown,
    readonly interactionListener: unknown,
    readonly summarizationHandler: unknown,
    readonly conversationActionReceiver: unknown,
  ) {}

  /** The turn's arguments are accepted because the handler's signature is the turn's, and none of them is used. */
  async handle(
    _turnContext: unknown,
    _turnAction: SlateCancelActionPayload,
    _promptExecutor: unknown,
    _stateComputer: unknown,
    _availableTools: unknown,
    _stateUpdateListener: unknown,
  ): Promise<never> {
    return refuseMisroutedCancelConversation();
  }
}

/**
 * The receiver for a conversation with no actions behind it.
 *
 * A remote or headless conversation has no client outbox to read from, and the turn loop still asks.
 * Answering "nothing queued" is the honest answer there, and it is what keeps the loop free of a
 * special case for environments without a queue.
 */

import type { Context } from "../../context/context.ts"
import type { AgentActionInbox } from "./action-inbox.ts"

export class NoopConversationActionReceiver<Action = unknown> implements AgentActionInbox<Action> {
  async pop(_context: Context): Promise<undefined> {
    return undefined
  }

  async peek(_context: Context): Promise<undefined> {
    return undefined
  }
}

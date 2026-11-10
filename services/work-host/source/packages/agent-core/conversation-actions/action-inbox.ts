/** The action queue boundary consumed by the conversation turn loop. */

import type { Context } from "../../context/context.ts";

export interface QueuedAgentAction<Action = unknown> {
  readonly action: Action;
}

export interface AgentActionInbox<Action = unknown> {
  /** Observe the next item without claiming it. */
  peek(context: Context): Promise<QueuedAgentAction<Action> | undefined>;
  /** Claim the item that was observed, so it cannot be processed twice. */
  pop(context: Context): Promise<undefined>;
  peekIsClaimedInjection?(): boolean;
  failConsumedInjectionDelivery?(): void;
  getContextInjectionToolSignal?(): unknown;
}

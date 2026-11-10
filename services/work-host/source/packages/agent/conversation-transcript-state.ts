import type { SlateConversationStep } from "./conversation-step-state.ts"
import type { SlateStoredConversationSummary } from "./conversation-summary-state.ts"
import type { SlateStoredShellInvocation, SlateStoredShellResult } from "./shell-state.ts"
import type { SlateUserMessage } from "./user-message-state.ts"
import type { SlateStoredTodoItem } from "./tools/core/todo/contracts.ts"

/** One fully hydrated agent turn in the product's conversation view. */
export interface SlateHydratedAgentTurn {
  readonly kind: "agent"
  readonly userMessage: SlateUserMessage
  readonly steps: readonly SlateConversationStep[]
}

/** One fully hydrated shell turn in the product's conversation view. */
export interface SlateHydratedShellTurn {
  readonly kind: "shell"
  readonly invocation: SlateStoredShellInvocation
  readonly result: SlateStoredShellResult
}

export type SlateHydratedConversationTurn = SlateHydratedAgentTurn | SlateHydratedShellTurn

/** Full conversation content loaded from the blob tree, using Slate domain records. */
export interface SlateHydratedConversation {
  readonly turns: readonly SlateHydratedConversationTurn[]
  readonly todos: readonly SlateStoredTodoItem[]
  readonly summary?: SlateStoredConversationSummary
}

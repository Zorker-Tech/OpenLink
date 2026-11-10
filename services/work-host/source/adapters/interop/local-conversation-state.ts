import { decodeInteropAgentConversationCheckpoint } from "./agent/agent-conversation-protobuf-adapter.ts";

/** Slate-facing view of the persisted conversation snapshot read by recovery. */
export interface ConversationStateSnapshot {
  readonly turns: readonly Uint8Array[];
  readonly todos: readonly Uint8Array[];
  readonly rootPromptMessagesJson: readonly Uint8Array[];
  readonly summary?: Uint8Array;
}

/** Decode the existing stored message and expose only the fields the recovery boundary needs. */
export function decodeConversationStateStructure(bytes: Uint8Array): ConversationStateSnapshot {
  const stored = decodeInteropAgentConversationCheckpoint(bytes);
  return {
    turns: [...stored.turns],
    todos: [...stored.todos],
    rootPromptMessagesJson: [...stored.rootPromptMessagesJson],
    ...(stored.summary === undefined ? {} : { summary: stored.summary }),
  };
}

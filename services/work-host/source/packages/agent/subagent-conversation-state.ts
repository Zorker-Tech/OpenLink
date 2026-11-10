export type SlateConversationStateMapper = {
  bivarianceHack(callerState: unknown): unknown
}["bivarianceHack"]

export interface ConversationStateMappingPort {
  readonly conversationStateMapper?: SlateConversationStateMapper | undefined
}

export function mapSubagentConversationState<State>(
  config: ConversationStateMappingPort,
  callerState: State,
  emptyState: State,
): State {
  return (config.conversationStateMapper?.(callerState) ?? emptyState) as State
}

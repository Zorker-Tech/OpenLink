export interface HostRunnerScopeInput {
  readonly groupMemberTurn?: unknown
  readonly isSharedRoomTurn?: unknown
}

export interface HostRunnerScope {
  readonly groupMemberTurn: boolean
  readonly sharedRoomTurn: boolean
  readonly canAskLocalToolPermission: boolean
  readonly approvalsResolvable: boolean
  readonly hasConversationContext: boolean
}

/** Turn restrictions are derived once so every runner projection uses the same boundary. */
export function deriveHostRunnerScope(input: HostRunnerScopeInput): HostRunnerScope {
  const groupMemberTurn = input.groupMemberTurn === true
  const sharedRoomTurn = input.isSharedRoomTurn === true
  return {
    groupMemberTurn,
    sharedRoomTurn,
    canAskLocalToolPermission: !groupMemberTurn,
    approvalsResolvable: !groupMemberTurn,
    hasConversationContext: !sharedRoomTurn,
  }
}

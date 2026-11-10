import type { GroupDescription, GroupMember, GroupMessage } from "../groups/group-chat.ts"

export interface GroupOrchestratorDeps {
  resolveMembers(ids: readonly string[]): Promise<GroupMember[]>
  readHistory(): readonly GroupMessage[]
  isCurrent(): boolean
  runMemberTurn(args: {
    readonly member: GroupMember
    readonly systemPrompt: string
    readonly prompt: string
  }): Promise<readonly string[]>
  postMemberMessage(member: GroupMember, content: string): void
  finalizeMemberTurn?(member: GroupMember): void
  isSharedRoom?: boolean
}

export interface GroupOrchestrationRequest {
  readonly group: GroupDescription
  readonly memberIds: readonly string[]
}

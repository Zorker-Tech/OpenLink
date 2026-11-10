import type { GroupDescription, GroupMember } from "../groups/group-chat.ts"
import type { GroupOrchestrationRequest, GroupOrchestratorDeps } from "./group-chat-orchestrator-contracts.ts"
import { runGroupMemberTurn } from "./group-chat-member-turn.ts"
import { runGroupMemberRounds } from "./group-chat-rounds.ts"

export type { GroupOrchestrationRequest, GroupOrchestratorDeps } from "./group-chat-orchestrator-contracts.ts"

export class GroupChatOrchestrator {
  constructor(readonly deps: GroupOrchestratorDeps) {}

  run(request: GroupOrchestrationRequest): Promise<void> {
    return runGroupMemberRounds(this.deps, request)
  }

  runOneTurn(
    group: GroupDescription,
    member: GroupMember,
    members: readonly GroupMember[],
  ): Promise<string[]> {
    return runGroupMemberTurn(this.deps, group, member, members)
  }
}

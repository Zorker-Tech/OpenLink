import {
  GROUP_MAX_MEMBER_TURNS,
  GROUP_MAX_ROUNDS,
  orderRoundSpeakers,
  resolveResponders,
  type GroupMember,
} from "../groups/group-chat.ts"
import type { GroupOrchestrationRequest, GroupOrchestratorDeps } from "./group-chat-orchestrator-contracts.ts"
import { runGroupMemberTurn } from "./group-chat-member-turn.ts"

export async function runGroupMemberRounds(
  dependencies: GroupOrchestratorDeps,
  request: GroupOrchestrationRequest,
): Promise<void> {
  const members = await dependencies.resolveMembers(request.memberIds)
  if (members.length === 0) return

  const memberById = new Map(members.map((member) => [member.id, member]))
  let sentCount = 0

  for (let round = 0; round < GROUP_MAX_ROUNDS; round += 1) {
    if (!dependencies.isCurrent()) return
    const chosenMemberIds = resolveResponders(members, dependencies.readHistory())
      .map((member) => member.id)
    let roundMessageCount = 0

    for (const memberId of orderRoundSpeakers(chosenMemberIds, round)) {
      if (sentCount >= GROUP_MAX_MEMBER_TURNS || !dependencies.isCurrent()) return
      const member = memberById.get(memberId)
      if (member == null) continue

      const messages = await runGroupMemberTurn(dependencies, request.group, member, members)
      let reachedConversationLimit = false
      for (const message of messages) {
        dependencies.postMemberMessage(member, message)
        sentCount += 1
        roundMessageCount += 1
        if (sentCount >= GROUP_MAX_MEMBER_TURNS) {
          reachedConversationLimit = true
          break
        }
      }
      dependencies.finalizeMemberTurn?.(member)
      if (reachedConversationLimit) return
    }

    if (roundMessageCount === 0) return
  }
}

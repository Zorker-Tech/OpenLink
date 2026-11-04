import {
  GROUP_MAX_MESSAGES_PER_TURN,
  SHARED_ROOM_HISTORY_LIMIT,
  buildGroupMemberSystemPrompt,
  buildGroupTurnPrompt,
  isPassContent,
  messagesSinceMemberLastSpoke,
  type GroupDescription,
  type GroupMember,
} from "../groups/group-chat.ts"
import type { GroupOrchestratorDeps } from "./group-chat-orchestrator-contracts.ts"

export async function runGroupMemberTurn(
  dependencies: GroupOrchestratorDeps,
  group: GroupDescription,
  member: GroupMember,
  members: readonly GroupMember[],
): Promise<string[]> {
  const peers = members.filter((candidate) => candidate.id !== member.id)
  const history = dependencies.readHistory()
  const newMessages = dependencies.isSharedRoom === true
    ? history.slice(-SHARED_ROOM_HISTORY_LIMIT)
    : messagesSinceMemberLastSpoke(history, member.id)
  const responses = await dependencies.runMemberTurn({
    member,
    systemPrompt: buildGroupMemberSystemPrompt(member, group, peers, {
      isSharedRoom: dependencies.isSharedRoom === true,
    }),
    prompt: buildGroupTurnPrompt({ member, group, peers, newMessages }),
  })

  const delivered: string[] = []
  for (const response of responses) {
    if (isPassContent(response)) continue
    const text = response.trim()
    if (text.length === 0) continue
    delivered.push(text)
    if (delivered.length >= GROUP_MAX_MESSAGES_PER_TURN) break
  }
  return delivered
}

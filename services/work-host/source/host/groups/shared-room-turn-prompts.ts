import {
  buildGroupMemberSystemPrompt,
  buildGroupTurnPrompt,
  type GroupDescription,
  type GroupMember,
} from "./group-chat.ts"
import type { SharedRoomTurnMessage } from "./shared-room-contracts.ts"
import { buildSharedRoomGuardrails } from "./shared-room-guardrails.ts"
import { fromSharedRoomMessages } from "./shared-room-message-projection.ts"

export function buildSharedRoomMemberPrompts(args: {
  readonly member: GroupMember
  readonly group: GroupDescription
  readonly peers: GroupMember[]
  readonly hostName: string
  readonly newMessages: SharedRoomTurnMessage[]
}): { readonly systemPrompt: string; readonly prompt: string } {
  return {
    systemPrompt: buildGroupMemberSystemPrompt(args.member, args.group, args.peers, { isSharedRoom: true })
      + buildSharedRoomGuardrails({ hostName: args.hostName, isForeignHost: true }),
    prompt: buildGroupTurnPrompt({
      member: args.member,
      group: args.group,
      peers: args.peers,
      newMessages: fromSharedRoomMessages(args.newMessages, args.member.id),
    }),
  }
}

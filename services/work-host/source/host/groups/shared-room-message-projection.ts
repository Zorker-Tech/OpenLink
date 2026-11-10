import type { GroupMessage } from "./group-chat.ts"
import { clampBlock, clampLine, SHARED_ROOM_TEXT_LIMIT, SHARED_ROOM_TURN_MESSAGE_LIMIT } from "./shared-room-policy.ts"
import type { SharedRoomTurnMessage } from "./shared-room-contracts.ts"

export function toSharedRoomMessages(
  history: readonly GroupMessage[],
  memberId: string,
): SharedRoomTurnMessage[] {
  return history.slice(-SHARED_ROOM_TURN_MESSAGE_LIMIT).map((message) => {
    if (message.speaker.kind === "user") {
      return {
        speakerKind: "human",
        speakerName: message.speaker.name ? clampLine(message.speaker.name, 120) : "User",
        text: clampBlock(message.content, SHARED_ROOM_TEXT_LIMIT),
      }
    }
    return {
      speakerKind: "agent",
      speakerName: clampLine(message.speaker.name, 120),
      ...(message.speaker.id === memberId ? { isSelf: true as const } : {}),
      text: clampBlock(message.content, SHARED_ROOM_TEXT_LIMIT),
    }
  })
}

export function fromSharedRoomMessages(
  messages: readonly SharedRoomTurnMessage[],
  selfMemberId: string,
): GroupMessage[] {
  return messages.slice(0, SHARED_ROOM_TURN_MESSAGE_LIMIT).map((message) => {
    if (message.speakerKind === "human") {
      return {
        speaker: { kind: "user" as const, name: clampLine(message.speakerName, 120) },
        content: clampBlock(message.text, SHARED_ROOM_TEXT_LIMIT),
      }
    }
    return {
      speaker: {
        kind: "member" as const,
        id: message.isSelf === true ? selfMemberId : `peer:${message.speakerName}`,
        name: clampLine(message.speakerName, 120),
      },
      content: clampBlock(message.text, SHARED_ROOM_TEXT_LIMIT),
    }
  })
}

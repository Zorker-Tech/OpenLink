import { normalizeSharedRoomName } from "../groups/xuser.ts";
import type { TurnMessage } from "./xuser-wire-contracts.ts";
import { wireRecord } from "./xuser-wire-records.ts";

const MAX_TURN_MESSAGES = 24;

export function normalizeTurnMessages(raw: unknown): TurnMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: TurnMessage[] = [];
  for (const candidate of raw.slice(0, MAX_TURN_MESSAGES)) {
    const message = wireRecord(candidate);
    if (message == null || typeof message.text !== "string" || message.text.length === 0) continue;
    messages.push({
      speakerKind: message.speakerKind === "agent" ? "agent" : "human",
      speakerName: normalizeSharedRoomName(typeof message.speakerName === "string" ? message.speakerName : ""),
      ...(message.isSelf === true ? { isSelf: true as const } : {}),
      text: message.text,
    });
  }
  return messages;
}

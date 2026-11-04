export const SHARED_ROOM_MEMBER_TURN_TIMEOUT_MS = 600_000
export const SHARED_ROOM_TURN_MESSAGE_LIMIT = 24
export const SHARED_ROOM_TEXT_LIMIT = 8_000

export function sharedRoomBoxToolsAreEnabled(override?: string | null): boolean {
  return override != null && override.length > 0
    ? override !== "0" && override.toLowerCase() !== "false"
    : true
}

export function clampLine(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, max) : ""
}

export function clampBlock(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

export function normalizeSharedRoomName(name: string): string {
  return clampLine(name, 120) || "Someone"
}

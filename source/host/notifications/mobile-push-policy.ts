export const SLATE_MOBILE_PUSH_FOCUS_FRESHNESS_MS = 5 * 60_000

export interface MobileWindowPresence {
  readonly windowFocusedAtMs?: number | null
}

export function pushPresenceAt(nowMs: number, presence: MobileWindowPresence): {
  readonly nowMs: number
  readonly isWindowFocused: boolean
} {
  const focusedAt = presence.windowFocusedAtMs
  return {
    nowMs,
    isWindowFocused: focusedAt != null && nowMs - focusedAt <= SLATE_MOBILE_PUSH_FOCUS_FRESHNESS_MS,
  }
}

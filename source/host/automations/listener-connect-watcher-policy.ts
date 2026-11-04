import type { PendingConnectionWatch } from "./listener-connect-watcher-contracts.ts"

export const DEFAULT_WATCH_TIMEOUT_MS = 15 * 60 * 1_000

export function beginConnectionWatch(agentId: string, nowMs: number, timeoutMs: number): PendingConnectionWatch {
  return { agentId, expiresAtMs: nowMs + timeoutMs, sawDisconnected: false }
}

export function connectionWatchExpired(watch: PendingConnectionWatch, nowMs: number): boolean {
  return watch.expiresAtMs <= nowMs
}

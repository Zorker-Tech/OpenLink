import type { PollingPolicy } from "../extensions/scheduling.ts"
import type { ListenerPlatform } from "./listener-platforms.ts"

export interface PendingConnectionWatch {
  readonly agentId: string
  readonly expiresAtMs: number
  sawDisconnected: boolean
}

export interface ListenerConnectWatcherDependencies {
  readonly polling: PollingPolicy
  readonly isPlatformConnected: (platform: ListenerPlatform) => Promise<boolean>
  readonly onConnected: (agentId: string, platform: ListenerPlatform) => void
  readonly watchTimeoutMs?: number
  readonly now?: () => number
}

import type { ListenerPlatform } from "./listener-platforms.ts"
import {
  beginConnectionWatch,
  connectionWatchExpired,
  DEFAULT_WATCH_TIMEOUT_MS,
} from "./listener-connect-watcher-policy.ts"
import type { ListenerConnectWatcherDependencies, PendingConnectionWatch } from "./listener-connect-watcher-contracts.ts"

export { DEFAULT_WATCH_TIMEOUT_MS } from "./listener-connect-watcher-policy.ts"
export type { ListenerConnectWatcherDependencies } from "./listener-connect-watcher-contracts.ts"

export class ListenerConnectWatcher {
  readonly pending = new Map<ListenerPlatform, PendingConnectionWatch>()
  private pollingLease: { dispose(): void } | null = null
  private checkingConnections = false
  private paused = false
  private closed = false

  constructor(readonly deps: ListenerConnectWatcherDependencies) {}

  watch(agentId: string, platform: ListenerPlatform): void {
    if (this.closed) return
    const nowMs = (this.deps.now ?? Date.now)()
    const timeoutMs = this.deps.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS
    this.pending.set(platform, beginConnectionWatch(agentId, nowMs, timeoutMs))
    if (this.paused) return
    this.ensurePolling()
    void this.tick()
  }

  suspend(): void {
    if (this.closed || this.paused) return
    this.paused = true
    this.pollingLease?.dispose()
    this.pollingLease = null
  }

  resume(): void {
    if (this.closed || !this.paused) return
    this.paused = false
    if (this.pending.size === 0) return
    this.ensurePolling()
    void this.tick()
  }

  dispose(): void {
    this.closed = true
    this.paused = true
    this.pending.clear()
    this.stopPollingWhenIdle()
  }

  private ensurePolling(): void {
    if (this.pollingLease !== null || this.paused || this.closed) return
    this.pollingLease = this.deps.polling.start(async () => {
      try {
        await this.tick()
      } catch {
      }
    })
  }

  private stopPollingWhenIdle(): void {
    if (this.pending.size > 0 && !this.paused && !this.closed) return
    this.pollingLease?.dispose()
    this.pollingLease = null
  }

  async tick(): Promise<void> {
    if (this.checkingConnections || this.paused || this.closed) return
    this.checkingConnections = true
    try {
      const nowMs = (this.deps.now ?? Date.now)()
      const currentWatches = [...this.pending]
      for (const [platform, watch] of currentWatches) {
        if (connectionWatchExpired(watch, nowMs)) {
          this.pending.delete(platform)
          continue
        }

        let connected: boolean
        try {
          connected = await this.deps.isPlatformConnected(platform)
        } catch {
          continue
        }
        if (this.closed) return
        if (this.pending.get(platform) !== watch) continue
        if (!connected) {
          watch.sawDisconnected = true
          continue
        }
        if (this.paused) continue

        this.pending.delete(platform)
        if (watch.sawDisconnected && !this.closed) this.deps.onConnected(watch.agentId, platform)
      }
    } finally {
      this.checkingConnections = false
      this.stopPollingWhenIdle()
    }
  }
}

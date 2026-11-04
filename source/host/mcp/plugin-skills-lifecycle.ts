import type { PluginAuthBlock, PluginSkillRecord, PluginSkillsCache } from "../skills/plugin-skills-cache.ts"

export interface AuthRenewalPort {
  getAccessToken?(args: { backendUrl: string }): Promise<string>
  getMachineId?(): string
  peekAccessToken(): string | null
  subscribeToRenewal?(listener: (event: { outcome: string; isFirstCredential?: boolean }) => void): () => void
  onDidChange?(listener: () => void): () => void
}

export interface PollingPort {
  start(work: () => void | Promise<void>): { dispose(): void }
}

export interface McpPluginSkillsService {
  sync(trigger: string): Promise<PluginSkillRecord[]>
  handleAuthChange(): void
  dispose(): void
  currentIndex(): PluginSkillsCache | null
  currentAuthBlocked(): PluginAuthBlock[]
}

interface PluginSkillStartupOptions {
  readonly auth: AuthRenewalPort
  readonly service?: { sync(trigger: string): Promise<unknown>; handleAuthChange?(): void }
  readonly pluginSkills?: { start(): void; handleAuthChange(): void; dispose(): void }
  readonly polling?: PollingPort
  readonly onStartupSyncSucceeded?: () => void
}

/** Start synchronization once an account is available, and stop all associated work together. */
export function startPluginSkillsWhenAuthenticated(options: PluginSkillStartupOptions): () => void {
  let started = false
  let stopped = false
  let polling: { dispose(): void } | undefined

  const beginReading = (): void => {
    if (options.polling === undefined) {
      options.pluginSkills?.start()
      return
    }
    let startupRead = true
    polling = options.polling.start(async () => {
      const phase = startupRead ? "startup" : "refresh"
      startupRead = false
      try {
        await options.service?.sync(phase)
        if (phase === "startup" && !stopped) options.onStartupSyncSucceeded?.()
      } catch {
        // The next poll retries a failed read.
      }
    })
  }

  const start = (): void => {
    if (started || stopped) return
    started = true
    beginReading()
  }

  const notifyAccountChanged = (): void => {
    const callback = options.service?.handleAuthChange ?? options.pluginSkills?.handleAuthChange
    callback?.call(options.service ?? options.pluginSkills)
  }

  const onRenewal = (event: { outcome: string; isFirstCredential?: boolean }): void => {
    if (stopped || event.outcome !== "renewed") return
    if (!started) {
      if (options.auth.peekAccessToken() !== null) start()
      return
    }
    if (event.isFirstCredential === true) notifyAccountChanged()
  }

  const stopWatching = options.auth.subscribeToRenewal?.(onRenewal) ??
    options.auth.onDidChange?.(() => onRenewal({ outcome: "renewed", isFirstCredential: true })) ??
    (() => {})
  if (options.auth.peekAccessToken() !== null) start()

  return () => {
    if (stopped) return
    stopped = true
    stopWatching()
    polling?.dispose()
    options.pluginSkills?.dispose()
  }
}

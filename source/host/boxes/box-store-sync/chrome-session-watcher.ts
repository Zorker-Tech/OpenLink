import { statSync, watch, type FSWatcher } from "node:fs"
import {
  advancedSessionMtimes,
  existingSessionMtimes,
  sessionDatabaseNameMatches,
} from "./chrome-session-watcher-state.ts"
import type { ChromeSessionWatcherDependencies } from "./chrome-session-watcher-contracts.ts"

export type { ChromeSessionWatcherDependencies } from "./chrome-session-watcher-contracts.ts"

type CloseableWatcher = Pick<FSWatcher, "close">
type DebouncedAction = (() => void) & { dispose(): void }

export class ChromeSessionWatcher {
  private watcher: CloseableWatcher | undefined
  private stopped = false
  private readonly openWatch: NonNullable<ChromeSessionWatcherDependencies["startWatch"]>
  private readonly notifyAfterQuiet: DebouncedAction
  private readonly readMtime: NonNullable<ChromeSessionWatcherDependencies["statMtimeMs"]>
  private readonly report: NonNullable<ChromeSessionWatcherDependencies["log"]>
  readonly lastMtimes = new Map<string, number>()

  constructor(readonly deps: ChromeSessionWatcherDependencies) {
    this.openWatch = deps.startWatch ?? ((dir, listener) =>
      watch(dir, { persistent: false }, (_event, name) => listener(typeof name === "string" ? name : null)))
    this.notifyAfterQuiet = deps.debounce.wrap(() => {
      if (this.stopped) return
      try {
        deps.onSessionChange()
      } catch (error) {
        this.report(`onSessionChange threw (ignored): ${String(error)}`)
      }
    })
    this.readMtime = deps.statMtimeMs ?? ((filePath) => {
      try {
        return statSync(filePath).mtimeMs
      } catch {
        return undefined
      }
    })
    this.report = deps.log ?? ((message) => console.log(`[session-file-watcher] ${message}`))
  }

  start(): void {
    if (this.stopped || this.watcher !== undefined) return
    this.refreshSessionDbMtimes()
    try {
      this.watcher = this.openWatch(this.deps.watchDir, (filename) => this.handleFsEvent(filename))
      this.report(`watching ${this.deps.watchDir} for session database changes`)
    } catch (error) {
      this.report(`watch could not arm (periodic cycle is the backstop): ${String(error)}`)
    }
  }

  handleFsEvent(filename: string | null): void {
    if (this.stopped) return
    const relevant = filename === null
      ? this.sessionDbChangedSinceLastCheck()
      : this.isSessionDbFile(filename)
    if (relevant) this.notifyAfterQuiet()
  }

  isSessionDbFile(filename: string): boolean {
    return sessionDatabaseNameMatches(this.deps.sessionDbNames, filename)
  }

  sessionDbChangedSinceLastCheck(): boolean {
    const result = advancedSessionMtimes(
      this.deps.watchDir,
      this.deps.sessionDbNames,
      this.lastMtimes,
      this.readMtime,
    )
    for (const [name, mtime] of result.updates) this.lastMtimes.set(name, mtime)
    return result.changed
  }

  refreshSessionDbMtimes(): void {
    const current = existingSessionMtimes(this.deps.watchDir, this.deps.sessionDbNames, this.readMtime)
    for (const [name, mtime] of current) this.lastMtimes.set(name, mtime)
  }

  stop(): void {
    this.stopped = true
    this.notifyAfterQuiet.dispose()
    try {
      this.watcher?.close()
    } catch {
    }
    this.watcher = undefined
  }
}

import type { DebouncePolicy } from "../../extensions/scheduling.ts"

export interface ChromeSessionWatcherDependencies {
  readonly watchDir: string
  readonly sessionDbNames: readonly string[]
  readonly debounce: DebouncePolicy
  readonly onSessionChange: () => void
  readonly startWatch?: (
    dir: string,
    listener: (filename: string | null) => void,
  ) => { close(): void }
  readonly statMtimeMs?: (path: string) => number | undefined
  readonly log?: (message: string) => void
}

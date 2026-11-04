import type { DebouncePolicy } from "../scheduling.ts"

export const SLATE_STATE_BACKSTOP_REL_PATH = "state/store.db"
export const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
export const STATE_BACKSTOP_DEBOUNCE_MS = 5_000

export interface StateBackstopObjectStore {
  put(path: string, bytes: Uint8Array): Promise<void>
  get(path: string): Promise<Uint8Array | null>
}

export interface StateBackstopDeps {
  readonly objectStoreProvider: { forStore(sourceId: string): StateBackstopObjectStore }
  readonly sourceMap: { getOrCreate(agentId: string): Promise<{ sourceId: string }> }
  readonly debounce: DebouncePolicy
  readonly agentsRootDir: string
  readonly maxSnapshotBytes?: number
  readonly readDbBytes: (path: string) => Uint8Array | null
  readonly log?: (message: string) => void
}

export type StateBackstopSnapshotResult =
  | { readonly status: "uploaded"; readonly bytes: number }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "error"; readonly error: string }

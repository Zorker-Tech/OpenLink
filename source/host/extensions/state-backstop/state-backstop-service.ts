import { join } from "node:path"

import { errorMessage } from "../../../shared/errors/summary.ts"
import { readStateSnapshot, createStateSnapshotRunner } from "./state-backstop-snapshot-runner.ts"
import { isStateBackstopEnabled } from "./state-backstop-config.ts"
import { readStoreDbBytes } from "./state-backstop-file.ts"
import {
  DEFAULT_MAX_SNAPSHOT_BYTES,
  SLATE_STATE_BACKSTOP_REL_PATH,
  STATE_BACKSTOP_DEBOUNCE_MS,
  type StateBackstopDeps,
  type StateBackstopSnapshotResult,
} from "./state-backstop-contracts.ts"

export {
  DEFAULT_MAX_SNAPSHOT_BYTES,
  isStateBackstopEnabled,
  readStoreDbBytes,
  SLATE_STATE_BACKSTOP_REL_PATH,
  STATE_BACKSTOP_DEBOUNCE_MS,
}
export type { StateBackstopDeps, StateBackstopSnapshotResult } from "./state-backstop-contracts.ts"

type SnapshotTrigger = (() => void) & { dispose(): void }

/** Keep one debounced snapshot request per agent while the extension is alive. */
export class SlateStateBackstop {
  private readonly log: (message: string) => void
  private readonly pendingSnapshots = new Map<string, SnapshotTrigger>()
  private readonly runSnapshot: (agentId: string) => Promise<StateBackstopSnapshotResult>
  private disposed = false

  constructor(private readonly deps: StateBackstopDeps) {
    this.log = deps.log ?? (message => console.log(`[slate-state-backstop] ${message}`))
    this.runSnapshot = createStateSnapshotRunner(deps, deps.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES, this.log)
  }

  dbPathFor(agentId: string): string {
    return join(this.deps.agentsRootDir, agentId, "store.db")
  }

  scheduleSnapshot(agentId: string): void {
    if (this.disposed) return
    const scheduled = this.pendingSnapshots.get(agentId) ?? this.makeSnapshotTrigger(agentId)
    scheduled()
  }

  snapshotNow(agentId: string): Promise<StateBackstopSnapshotResult> {
    return this.runSnapshot(agentId)
  }

  readSnapshot(agentId: string): Promise<Uint8Array | null> {
    return readStateSnapshot(this.deps, agentId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const scheduled of this.pendingSnapshots.values()) scheduled.dispose()
    this.pendingSnapshots.clear()
  }

  private makeSnapshotTrigger(agentId: string): SnapshotTrigger {
    const scheduled = this.deps.debounce.wrap(() => {
      void this.snapshotNow(agentId).catch(error => this.log(`snapshot rejected for ${agentId}: ${errorMessage(error)}`))
    })
    this.pendingSnapshots.set(agentId, scheduled)
    return scheduled
  }
}

import { join } from "node:path"

import { errorMessage } from "../../../shared/errors/summary.ts"
import { downloadStateSnapshot, uploadStateSnapshot } from "./state-backstop-object-store.ts"
import {
  SLATE_STATE_BACKSTOP_REL_PATH,
  type StateBackstopDeps,
  type StateBackstopSnapshotResult,
} from "./state-backstop-contracts.ts"

/** Turn one local database read into an upload result with a byte ceiling. */
export function createStateSnapshotRunner(
  deps: StateBackstopDeps,
  maxBytes: number,
  report: (message: string) => void,
): (agentId: string) => Promise<StateBackstopSnapshotResult> {
  return async agentId => {
    try {
      const snapshot = deps.readDbBytes(join(deps.agentsRootDir, agentId, "store.db"))
      if (snapshot === null) return { status: "skipped", reason: "no store.db" }

      const byteCount = snapshot.byteLength
      if (byteCount > maxBytes) {
        const reason = `store.db ${byteCount}B over ${maxBytes}B cap`
        report(`skip ${agentId}: ${reason}`)
        return { status: "skipped", reason }
      }

      await uploadStateSnapshot(deps, agentId, snapshot, SLATE_STATE_BACKSTOP_REL_PATH)
      report(`uploaded ${agentId} (${byteCount}B)`)
      return { status: "uploaded", bytes: byteCount }
    } catch (error) {
      const message = errorMessage(error)
      report(`snapshot ${agentId} failed: ${message}`)
      return { status: "error", error: message }
    }
  }
}

export async function readStateSnapshot(deps: StateBackstopDeps, agentId: string): Promise<Uint8Array | null> {
  return downloadStateSnapshot(deps, agentId, SLATE_STATE_BACKSTOP_REL_PATH)
}

/**
 * Loading the states of an agent's subagents.
 *
 * A conversation keeps small subagent states inline and large ones in blobs, and a read has to end
 * with all of them resolved. A missing blob is only fatal when there is no inline copy to fall back
 * on; if one subagent's blob cannot be read but its inline state exists, the read continues and says
 * so, because losing one subagent's memory should not cost the user the conversation.
 */

import { createLogger } from "../context/logging.ts"
import { asyncMapValues } from "../utils/promise-tools.ts"
import { BlobNotFoundError } from "./blob-not-found-error.ts"
import type { BlobStore } from "./blob-store.ts"
import { toHex } from "./serde.ts"

const SUBAGENT_STATE_BLOB_FETCH_CONCURRENCY = 8
const logger = createLogger("agent-kv:subagent-states")

export interface AgentSubconversationReferences<State> {
  readonly subagentStates: Readonly<Record<string, State>>
  readonly subagentStateRefs: Readonly<Record<string, Uint8Array>>
}

type LoadResult<State> =
  | { kind: "loaded"; subagentId: string; state: State }
  | { kind: "fallback" }
  | { kind: "missing"; blobIdHex: string }
  | { kind: "failed"; error: unknown }

export async function resolveSubagentPersistedStates<Context, State>(
  ctx: Context,
  state: AgentSubconversationReferences<State>,
  blobStore: Pick<BlobStore<Context>, "getBlob">,
  deserializeState: (blob: Uint8Array) => State,
): Promise<Record<string, State>> {
  const resolved: Record<string, State> = { ...state.subagentStates }
  const refs = Object.entries(state.subagentStateRefs) as Array<[string, Uint8Array]>
  if (refs.length === 0) return resolved

  const loads = await asyncMapValues<[string, Uint8Array], LoadResult<State>>(
    refs,
    async ([subagentId, blobId]) => {
      const blob = await blobStore.getBlob(ctx, blobId)
      if (blob === undefined) {
        if (resolved[subagentId] === undefined) return { kind: "missing", blobIdHex: toHex(blobId) }
        logger.warn(ctx as never, "Subagent state ref blob not found; falling back to inline entry", { subagentId })
        return { kind: "fallback" }
      }
      try {
        return { kind: "loaded", subagentId, state: deserializeState(blob) }
      } catch (error) {
        return { kind: "failed", error }
      }
    },
    { max: SUBAGENT_STATE_BLOB_FETCH_CONCURRENCY },
  )

  const missing = loads.flatMap(load => load.kind === "missing" ? [load.blobIdHex] : [])
  if (missing.length > 0) throw new BlobNotFoundError(missing)
  const firstFailure = loads.find(load => load.kind === "failed")
  if (firstFailure?.kind === "failed") throw firstFailure.error
  for (const load of loads) {
    if (load.kind === "loaded") resolved[load.subagentId] = load.state
  }
  return resolved
}

import { createInteropTurnTiming } from "../../adapters/interop/agent/turn-timing-adapter.ts"
import type { TurnCheckpoint, TurnSettleHost } from "./turn-settle.ts"

export interface ProductionTurnSettleRunner {
  currentRunGeneration?: number
  getBlobStore?(): unknown
  getLatestPromptMessages?(): readonly unknown[]
  setAgentConversationStateStructure?(checkpoint: TurnCheckpoint): void
}

export interface ProductionTurnSettleHostOptions {
  readonly transcriptId: string
  readonly isSharedRoomTurn: boolean
  readonly runner: ProductionTurnSettleRunner | undefined
  readonly agentStore: Record<string, any> | undefined
  readonly transcriptMirror?: TurnSettleHost["transcriptMirror"]
  readonly persistAnnouncedAgentProfile?: TurnSettleHost["persistAnnouncedAgentProfile"]
}

/** Binds checkpoint persistence to the runner generation that owns this turn. */
export function createProductionTurnSettleHost(options: ProductionTurnSettleHostOptions): TurnSettleHost {
  const store = options.agentStore
  if (store == null || typeof store.handleCheckpoint !== "function" || typeof store.getMetadata !== "function") {
    throw new TypeError("the production Agent checkpoint store is not bound")
  }
  const generation = options.runner?.currentRunGeneration

  return {
    isSubagentRunner: options.isSharedRoomTurn,
    createTurnTiming: createInteropTurnTiming,
    getTranscriptId: () => options.transcriptId,
    getBlobStore: () =>
      options.runner?.getBlobStore?.() ?? store.getBlobStore(),
    agentStore: () => ({
      handleCheckpoint: (context, checkpoint) => store.handleCheckpoint(context, checkpoint),
      getMetadata: (key) => store.getMetadata(key),
    }),
    setLocalState: (checkpoint) => {
      if (typeof options.runner?.setAgentConversationStateStructure !== "function") {
        throw new TypeError("the production Agent local checkpoint store is not bound")
      }
      options.runner.setAgentConversationStateStructure(checkpoint)
    },
    ownsRunner: () => true,
    isRunSuperseded: () =>
      generation !== undefined &&
      options.runner?.currentRunGeneration !== undefined &&
      options.runner.currentRunGeneration !== generation,
    latestPromptMessages: () => options.runner?.getLatestPromptMessages?.() ?? [],
    persistAnnouncedAgentProfile: (snapshots, snapshot, identity) => {
      options.persistAnnouncedAgentProfile?.(snapshots, snapshot, identity)
    },
    ...(options.transcriptMirror === undefined ? {} : { transcriptMirror: options.transcriptMirror }),
  }
}

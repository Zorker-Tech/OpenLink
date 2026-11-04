/** Builds each runner's offloading mirror over a journal shared by its provider. */

import { OffloadingTranscriptMirror } from "../../agents/isolation/transcript-mirror-offload.ts"
import { resolveConversationBlobStorePath } from "../../extensions/session/conversation-blobs-path.ts"
import type { HostRunnerCompositionDependencies } from "../../host-runner-composition.ts"
import type { TranscriptOccurrenceCodec, TranscriptOccurrenceBlobStore } from "./transcript-occurrence-deriver.ts"
import { createTranscriptOccurrenceDeriver } from "./transcript-occurrence-deriver.ts"
import { FileTranscriptMirror } from "./transcript-mirror.ts"

export type CreateTranscriptMirror = NonNullable<HostRunnerCompositionDependencies["createTranscriptMirror"]>

export interface ProductionTranscriptMirrorProviderInputs {
  readonly codec: TranscriptOccurrenceCodec
}

function rootPromptCountFrom(agentStore: unknown): number {
  const readStructure = (agentStore as { getConversationStateStructure?: unknown } | null)?.getConversationStateStructure
  if (typeof readStructure !== "function") {
    throw new TypeError("session.agentStore.getConversationStateStructure is required")
  }

  const snapshot = readStructure.call(agentStore) as { rootPromptMessagesJson?: unknown } | null
  if (!Array.isArray(snapshot?.rootPromptMessagesJson)) {
    throw new TypeError("conversation state rootPromptMessagesJson is required")
  }
  return snapshot.rootPromptMessagesJson.length
}

export function createProductionTranscriptMirrorProvider(
  inputs: ProductionTranscriptMirrorProviderInputs,
): CreateTranscriptMirror {
  const deriver = createTranscriptOccurrenceDeriver(inputs.codec)
  let sharedJournal: FileTranscriptMirror<TranscriptOccurrenceBlobStore> | undefined

  return options => {
    const startCursor = rootPromptCountFrom(options.session.agentStore)
    const blobDatabasePath = resolveConversationBlobStorePath(options.session.dbPath)
    sharedJournal ??= new FileTranscriptMirror(options.transcriptsDir, options.reportOutcome, deriver)

    return sharedJournal.routed(
      OffloadingTranscriptMirror.forTranscriptsDir(
        options.pool,
        {
          transcriptsDir: options.transcriptsDir,
          blobDbPaths: [blobDatabasePath, options.session.dbPath],
        },
        startCursor,
      ),
      options.isJournalEnabled,
    )
  }
}

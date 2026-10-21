/**
 * The transcript mirror the host uses in production.
 *
 * Two lifetimes meet here, and the provider keeps them apart:
 *
 * - **the journal is shared** — every runner the provider hands a mirror to writes to the same file journal, because a
 *   conversation's transcript is one document no matter how many agents have spoken in it;
 * - **the cursor is per runner** — each run starts from the number of root prompt messages the Agent store already holds,
 *   so a mirror only ever carries what its own run added.
 *
 * The occurrence deriver is built once, from the generated agent.v1 constructors, because the journal's format is the
 * generated one: this file does not re-declare a codec of its own.
 */
import { OffloadingTranscriptMirror } from "../../agents/isolation/transcript-mirror-offload.ts";
import { conversationBlobsPath } from "../../extensions/session/conversation-blobs-path.ts";
import type { HostRunnerCompositionDependencies } from "../../host-runner-composition.ts";
import { ConversationStep, ConversationTurnStructure, UserMessage } from "../../../packages/proto/generated/agent/v1/agent_pb.ts";
import { createGeneratedTranscriptOccurrenceCodec, type GeneratedTranscriptOccurrenceBindings } from "./generated-occurrence-codec.ts";
import { createTranscriptOccurrenceDeriver, type TranscriptOccurrenceBlobStore } from "./transcript-occurrence-deriver.ts";
import { FileTranscriptMirror } from "./transcript-mirror.ts";

type CreateTranscriptMirror = NonNullable<HostRunnerCompositionDependencies["createTranscriptMirror"]>;

export interface ProductionTranscriptMirrorProviderInputs {
  /** The generated agent.v1 constructors the journal's format is defined by. */
  readonly generated: GeneratedTranscriptOccurrenceBindings;
}

/** How many root prompt messages the session's Agent store already holds: the cursor a run's mirror starts from. */
function priorRootPromptCount(agentStore: unknown): number {
  const getStructure = (agentStore as { getConversationStateStructure?: unknown } | null)?.getConversationStateStructure;
  if (typeof getStructure !== "function") throw new TypeError("session.agentStore.getConversationStateStructure is required");
  const structure = getStructure.call(agentStore) as { rootPromptMessagesJson?: unknown } | null;
  if (!Array.isArray(structure?.rootPromptMessagesJson)) throw new TypeError("conversation state rootPromptMessagesJson is required");
  return structure.rootPromptMessagesJson.length;
}

/** A provider of mirrors: one shared journal, and a mirror per runner that starts from that runner's own cursor. */
export function createProductionTranscriptMirrorProvider(inputs: ProductionTranscriptMirrorProviderInputs): CreateTranscriptMirror {
  const deriver = createTranscriptOccurrenceDeriver(createGeneratedTranscriptOccurrenceCodec(inputs?.generated));
  let journal: FileTranscriptMirror<TranscriptOccurrenceBlobStore> | undefined;
  return (options) => {
    const previousRootPromptCount = priorRootPromptCount(options.session.agentStore);
    const blobsPath = conversationBlobsPath(options.session.dbPath);
    journal ??= new FileTranscriptMirror(options.transcriptsDir, options.reportOutcome, deriver);
    return journal.routed(
      OffloadingTranscriptMirror.forTranscriptsDir(
        options.pool,
        { transcriptsDir: options.transcriptsDir, blobDbPaths: [blobsPath, options.session.dbPath] },
        previousRootPromptCount,
      ),
      options.isJournalEnabled,
    );
  };
}

/** The production binding: the generated agent.v1 constructors, which are the only identities a real journal accepts. */
export function createDefaultProductionTranscriptMirrorProvider(): CreateTranscriptMirror {
  return createProductionTranscriptMirrorProvider({
    generated: { ConversationTurnStructure, UserMessage, ConversationStep },
  });
}

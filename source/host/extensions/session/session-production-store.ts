import { dirname, join } from "node:path";
import { AgentConversationStore } from "../../../packages/agent-kv/agent-conversation-store.ts";
import {
  createSlateAgentConversationCodec,
  deriveInteropConversationStateFromStructure,
} from "../../../adapters/interop/agent/agent-conversation-protobuf-adapter.ts";
import type { Context } from "../../../packages/context/context.ts";
import { AgentWorkerPool } from "../../agents/isolation/agent-worker-pool.ts";
import { WorkerBlobStore } from "../../agents/isolation/worker-blob-store.ts";
import { deriveOutlineFromConversationState, type ConversationState } from "../../runner/conversation-outline.ts";
import { SlateAgentSessionStore, type ConversationStatePort } from "./agent-session.ts";
import { maintainProductionSession } from "./session-production-maintenance.ts";
import { SlateSessionConversationState } from "./session-conversation-state.ts";
import { SlateSessionMaterialization } from "./session-materialization.ts";
import type { MaterializedSession } from "./session-materialization-contracts.ts";
import { CONVERSATION_BLOBS_FILENAME, SLATE_CONVERSATION_ROOT_SLOT_ID } from "./session-paths.ts";

export function createSessionConversationState(
  store: SlateAgentSessionStore,
  context: Context,
): SlateSessionConversationState {
  return new SlateSessionConversationState({
    rootDir: store.rootDir,
    ctx: context,
    openSession: agentId => store.openSession(agentId) as never,
    deriveState: (structure, blobStore) => deriveInteropConversationStateFromStructure(
      context,
      structure as never,
      blobStore as never,
    ),
    deriveOutline: state => deriveOutlineFromConversationState(state as ConversationState),
  });
}

export function createSessionMaterialization(
  store: SlateAgentSessionStore,
  options: {
    readonly rootDir: string;
    readonly context: Context;
    readonly report?: ((event: Record<string, unknown>) => void) | undefined;
  },
): SlateSessionMaterialization {
  let materialization: SlateSessionMaterialization;
  materialization = new SlateSessionMaterialization({
    ctx: options.context,
    rootDir: store.rootDir,
    createBlobWorkerPool: () => new AgentWorkerPool(),
    createAgentStore: ({ pool, agentId, dbPath, db }) => new AgentConversationStore(
      new WorkerBlobStore(
        pool,
        agentId,
        join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME),
        dbPath,
      ),
      db,
      {
        fixedRootBlobId: SLATE_CONVERSATION_ROOT_SLOT_ID,
        codec: createSlateAgentConversationCodec<Context>(),
      },
    ),
    createMemoryStore: agentDir => store.createMemoryStore(agentDir),
    resolveUserTimeZone: () => store.getUserTimeZone(),
    agentExists: agentId => store.agentExists(agentId),
    getAgentDir: agentId => store.getAgentDir(agentId),
    readActiveAgentId: () => store.readActiveAgentId(),
    isVisibleAgent: async agentId => await store.summarizeAgentById(agentId) != null,
    runMaintenance: async (session: MaterializedSession) => {
      const conversationState = store.conversationState;
      if (!(conversationState instanceof SlateSessionConversationState)) {
        throw new Error("Session conversation state is not initialized");
      }
      await maintainProductionSession({
        session,
        materialization,
        conversationState,
        context: options.context,
        rootDir: options.rootDir,
        ...(options.report === undefined ? {} : { report: options.report }),
      });
    },
    ...(options.report === undefined ? {} : { report: options.report }),
  });
  return materialization;
}

export function createSessionStoreFactory(options: {
  readonly rootDir: string;
  readonly context: Context;
  readonly report?: ((event: Record<string, unknown>) => void) | undefined;
}): (resolveUserTimeZone: () => string | undefined) => SlateAgentSessionStore {
  return resolveUserTimeZone => new SlateAgentSessionStore(options.rootDir, resolveUserTimeZone, {
    createMaterialization: store => createSessionMaterialization(store, options),
    createConversationState: store => createSessionConversationState(store, options.context) as unknown as ConversationStatePort,
  });
}

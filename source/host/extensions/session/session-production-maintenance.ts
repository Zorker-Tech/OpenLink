import type { Context } from "../../../packages/context/context.ts";
import { deriveOutlineFromConversationState, type ConversationState } from "../../runner/conversation-outline.ts";
import { getSlateAgentDbWriteGeneration, liveDbHandleCount } from "../../storage/store-db.ts";
import {
  clearStaleCheckpointRootsOnce,
  recoverConversationIfRootMissing,
  repairHiddenTranscriptEntriesOnce,
  retireLegacyStoreBlobsOnce,
  type MaintenanceDb,
  type MaintenanceHost,
  type MaintenanceStore,
  type MaintenanceWorkerPool,
} from "./session-maintenance.ts";
import type { OutlineItem as MaintenanceOutlineItem } from "./conversation-recovery.ts";
import { scheduleConversationSizeMaintenance, type ConversationGcVerdict } from "./conversation-size-limits.ts";
import type { SlateSessionConversationState } from "./session-conversation-state.ts";
import type { SlateSessionMaterialization } from "./session-materialization.ts";
import type { MaterializedSession } from "./session-materialization-contracts.ts";

type SessionWorkerPool = ReturnType<SlateSessionMaterialization["requireWorkerPool"]>;

export function createSessionMaintenanceWorkerPort(worker: SessionWorkerPool): MaintenanceWorkerPool {
  return {
    clearStaleCheckpointRoots: (agentId, blobDbPath, rootHex, dbPath) =>
      worker.clearStaleCheckpointRoots(agentId, blobDbPath, rootHex, dbPath),
    findLatestRootBlobId: async args => await worker.findLatestRootBlobId(args) ?? null,
    verifyLegacyBlobRetirement: async args =>
      await worker.verifyLegacyBlobRetirement(args) as {
        isRetirable: boolean;
        reason?: string;
        legacyRows?: number;
        legacyBytes?: number;
      },
  };
}

function maintenanceStoreFor(session: MaterializedSession): MaintenanceStore {
  return session.agentStore as unknown as MaintenanceStore;
}

function maintenanceDatabaseFor(session: MaterializedSession): MaintenanceDb {
  return session.db as unknown as MaintenanceDb;
}

function outlineForMaintenance(state: unknown): readonly MaintenanceOutlineItem[] {
  const sessionItems = deriveOutlineFromConversationState(state as ConversationState);
  const maintenanceItems: MaintenanceOutlineItem[] = [];
  for (const item of sessionItems) {
    switch (item.kind) {
      case "user":
        maintenanceItems.push({
          kind: "user",
          id: item.id,
          text: item.text,
          ...(item.hidden === true ? { hidden: true } : {}),
        });
        break;
      case "send-message":
        maintenanceItems.push({ kind: "send-message", id: item.id, message: item.message });
        break;
      case "tool-call":
        maintenanceItems.push({
          kind: "tool-call",
          id: item.id,
          name: item.name,
          status: item.status,
          ...(item.summary === undefined ? {} : { summary: item.summary }),
        });
        break;
      default:
        break;
    }
  }
  return maintenanceItems;
}

export function createSessionMaintenanceHost(input: {
  readonly rootDir: string;
  readonly context: Context;
  readonly worker: SessionWorkerPool;
  readonly conversationState: Pick<SlateSessionConversationState, "resolveConversationState">;
  readonly report?: ((event: Record<string, unknown>) => void) | undefined;
}): MaintenanceHost {
  return {
    rootDir: input.rootDir,
    ctx: input.context,
    liveHandleCount: liveDbHandleCount,
    writeGeneration: getSlateAgentDbWriteGeneration,
    requireWorkerPool: () => createSessionMaintenanceWorkerPort(input.worker),
    resolveConversationState: async (structure, blobStore) =>
      await input.conversationState.resolveConversationState(
        structure as Parameters<typeof input.conversationState.resolveConversationState>[0],
        blobStore as Parameters<typeof input.conversationState.resolveConversationState>[1],
      ) as Awaited<ReturnType<MaintenanceHost["resolveConversationState"]>>,
    deriveOutline: outlineForMaintenance,
    ...(input.report === undefined ? {} : { report: input.report }),
  };
}

/** Runs recovery first, then one-time repairs, then schedules bounded size cleanup. */
export async function maintainProductionSession(input: {
  readonly session: MaterializedSession;
  readonly materialization: SlateSessionMaterialization;
  readonly conversationState: Pick<SlateSessionConversationState, "resolveConversationState">;
  readonly context: Context;
  readonly rootDir: string;
  readonly report?: ((event: Record<string, unknown>) => void) | undefined;
}): Promise<void> {
  const worker = input.materialization.requireWorkerPool();
  const host = createSessionMaintenanceHost({
    rootDir: input.rootDir,
    context: input.context,
    worker,
    conversationState: input.conversationState,
    ...(input.report === undefined ? {} : { report: input.report }),
  });
  const database = maintenanceDatabaseFor(input.session);
  const store = maintenanceStoreFor(input.session);

  if (database.get("latestRootBlobId").length === 0) {
    await recoverConversationIfRootMissing(host, input.session.dbPath, database, store);
  }
  for (const repair of [
    repairHiddenTranscriptEntriesOnce,
    clearStaleCheckpointRootsOnce,
    retireLegacyStoreBlobsOnce,
  ]) {
    await repair(host, input.session.dbPath, database, store);
  }

  scheduleConversationSizeMaintenance(
    {
      requireWorkerPool: () => ({
        collectConversationGarbage: async args =>
          await worker.collectConversationGarbage(args) as ConversationGcVerdict,
      }),
    },
    input.session.dbPath,
    input.session.db,
  );
}

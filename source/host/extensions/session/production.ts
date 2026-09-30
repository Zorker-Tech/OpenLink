/**
 * The session, as a production host assembles it.
 *
 * Everything a session needs — its stores, its transcript, its maintenance and the ports the rest of the host asks it
 * through — is wired here, so a production host puts a session together in one place.
 */
import { dirname, join } from "node:path";
import type { HostExtensionContext } from "../host-extensions.ts";
import { computerUseExecutorResource } from "../../../packages/agent-exec/computer-use.ts";
import type { Executor, RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts";
import { AgentConversationStore, deriveConversationStateFromStructure } from "../../../packages/agent-kv/agent-conversation-store.ts";
import { createContext } from "../../../packages/context/context.ts";
import { loggerKey } from "../../../packages/context/logging.ts";
import {
  ComputerUseAction,
  ComputerUseArgs,
  ScreenshotAction,
  type ComputerUseResult,
} from "../../../packages/proto/generated/agent/v1/computer_use_tool_pb.ts";
import { AgentWorkerPool } from "../../agents/isolation/agent-worker-pool.ts";
import { WorkerBlobStore } from "../../agents/isolation/worker-blob-store.ts";
import { deriveOutlineFromConversationState, type ConversationState } from "../../runner/conversation-outline.ts";
import { getSlateAgentsRootDir } from "../../storage/agent-paths.ts";
import { getSlateAgentDbWriteGeneration, liveDbHandleCount } from "../../storage/store-db.ts";
import { SlateAgentSessionStore, type ConversationStatePort } from "./agent-session.ts";
import type { SlateAgentDb } from "./agent-db.ts";
import type { BoxHandoffDeps } from "./box-handoff-service.ts";
import { scheduleConversationSizeMaintenance, type ConversationGcVerdict } from "./conversation-size-limits.ts";
import type { SessionExtensionContext } from "./extension.ts";
import {
  clearStaleCheckpointRootsOnce,
  recoverConversationIfRootMissing,
  repairHiddenTranscriptEntriesOnce,
  retireLegacyStoreBlobsOnce,
  type MaintenanceDb,
  type MaintenanceHost,
  type MaintenanceStore,
} from "./session-maintenance.ts";
import { SlateSessionConversationState } from "./session-conversation-state.ts";
import { SlateSessionMaterialization, type MaterializedSession } from "./session-materialization.ts";
import {
  CONVERSATION_BLOBS_FILENAME,
  SLATE_CONVERSATION_ROOT_SLOT_ID,
  getSlateTranscriptsDir,
} from "./session-paths.ts";

interface SessionProductionDeps {
  "forever-box": {
    box: {
      ensureReady(context: ReturnType<typeof createContext>, agentId: string): Promise<{
        remoteAccessor?: unknown;
      }>;
    };
  };
  settings: SessionExtensionContext["deps"]["settings"];
  experiments: SessionExtensionContext["deps"]["experiments"];
  telemetry: {
    logs: {
      reportBoxHelp(event: Record<string, unknown>): void;
      reportSessionDiagnostic?(event: Record<string, unknown>): void;
    };
    analytics: {
      trackEvent(name: string, properties: Record<string, unknown>): void;
    };
  };
}

interface SessionProductionHost {
  events: {
    emit(topic: string, payload: unknown, options?: { failureMode?: "reject" }): Promise<void>;
  };
}

type ProductionContext = HostExtensionContext<SessionProductionHost> & {
  readonly deps: SessionProductionDeps;
};

type ProductionAgentStore = AgentConversationStore<ReturnType<typeof createContext>>;

function asMaintenanceStore(store: ProductionAgentStore): MaintenanceStore {
  return store as unknown as MaintenanceStore;
}

async function runMaintenance(
  session: MaterializedSession,
  materialization: SlateSessionMaterialization,
  conversationState: SlateSessionConversationState,
  context: ReturnType<typeof createContext>,
  rootDir: string,
  report: ((event: Record<string, unknown>) => void) | undefined,
): Promise<void> {
  const workerPool = materialization.requireWorkerPool();
  const host: MaintenanceHost = {
    rootDir,
    ctx: context,
    liveHandleCount: liveDbHandleCount,
    writeGeneration: getSlateAgentDbWriteGeneration,
    requireWorkerPool: () => ({
      clearStaleCheckpointRoots: (agentId, blobDbPath, rootHex, dbPath) =>
        workerPool.clearStaleCheckpointRoots(agentId, blobDbPath, rootHex, dbPath),
      findLatestRootBlobId: async args => await workerPool.findLatestRootBlobId(args) ?? null,
      verifyLegacyBlobRetirement: async args =>
        await workerPool.verifyLegacyBlobRetirement(args) as {
          isRetirable: boolean;
          reason?: string;
          legacyRows?: number;
          legacyBytes?: number;
        },
    }),
    resolveConversationState: (structure, blobStore) =>
      conversationState.resolveConversationState(
        structure as Parameters<typeof conversationState.resolveConversationState>[0],
        blobStore as Parameters<typeof conversationState.resolveConversationState>[1],
      ) as Promise<{ turns: readonly { items: readonly never[] }[] } | null>,
    deriveOutline: state => deriveOutlineFromConversationState(state as ConversationState) as unknown as ReturnType<NonNullable<MaintenanceHost["deriveOutline"]>>,
    ...(report === undefined ? {} : { report }),
  };
  const db = session.db as unknown as MaintenanceDb;
  const store = asMaintenanceStore(session.agentStore as ProductionAgentStore);
  const root = session.db.get("latestRootBlobId");
  if (root.length === 0) {
    await recoverConversationIfRootMissing(host, session.dbPath, db, store);
  }
  await repairHiddenTranscriptEntriesOnce(host, session.dbPath, db, store);
  await clearStaleCheckpointRootsOnce(host, session.dbPath, db, store);
  await retireLegacyStoreBlobsOnce(host, session.dbPath, db, store);
  scheduleConversationSizeMaintenance(
    {
      requireWorkerPool: () => ({
        collectConversationGarbage: async args =>
          await workerPool.collectConversationGarbage(args) as ConversationGcVerdict,
      }),
    },
    session.dbPath,
    session.db,
  );
}

async function grabHandoffScreenshot(
  box: SessionProductionDeps["forever-box"]["box"],
  context: ReturnType<typeof createContext>,
  agentId: string,
): Promise<string | null> {
  const connection = await box.ensureReady(context, agentId);
  const accessor = connection.remoteAccessor as ResourceAccessor<RemoteExecManager> | undefined;
  if (accessor == null) return null;
  const computerUse = accessor.get(computerUseExecutorResource) as Executor<ComputerUseArgs, ComputerUseResult>;
  const result = await computerUse.execute(
    context,
    new ComputerUseArgs({
      actions: [
        new ComputerUseAction({
          action: { case: "screenshot", value: new ScreenshotAction({}) },
        }),
      ],
    }),
  );
  if (result.result.case !== "success") return null;
  return result.result.value.screenshot ?? null;
}

/** Artifact construction at host-main.cjs:633435-633496; facade helpers at 632027-632660. */
export function createSessionProductionExtras(
  context: ProductionContext,
): Omit<SessionExtensionContext, "deps" | "onStop"> {
  const rootDir = getSlateAgentsRootDir();
  const requestContext = createContext().with(loggerKey, { log: () => {} });
  return {
    rootDir,
    getTranscriptsDir: getSlateTranscriptsDir,
    createStore(resolveUserTimeZone) {
      return new SlateAgentSessionStore(rootDir, resolveUserTimeZone, {
        createMaterialization(store) {
          let materialization: SlateSessionMaterialization;
          materialization = new SlateSessionMaterialization({
            ctx: requestContext,
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
              { fixedRootBlobId: SLATE_CONVERSATION_ROOT_SLOT_ID },
            ),
            createMemoryStore: agentDir => store.createMemoryStore(agentDir),
            resolveUserTimeZone: () => store.getUserTimeZone(),
            agentExists: agentId => store.agentExists(agentId),
            getAgentDir: agentId => store.getAgentDir(agentId),
            readActiveAgentId: () => store.readActiveAgentId(),
            isVisibleAgent: async agentId => await store.summarizeAgentById(agentId) != null,
            runMaintenance: session => {
              const conversationState = store.conversationState;
              if (!(conversationState instanceof SlateSessionConversationState)) {
                throw new Error("Session conversation state is not initialized");
              }
              return runMaintenance(
                session,
                materialization,
                conversationState,
                requestContext,
                rootDir,
                context.deps.telemetry.logs.reportSessionDiagnostic,
              );
            },
            report: event => context.deps.telemetry.logs.reportSessionDiagnostic?.(event),
          });
          return materialization;
        },
        createConversationState(store) {
          return new SlateSessionConversationState({
            rootDir: store.rootDir,
            ctx: requestContext,
            openSession: agentId => store.openSession(agentId) as never,
            deriveState: (structure, blobStore) => deriveConversationStateFromStructure(
              requestContext,
              structure as never,
              blobStore as never,
            ),
            deriveOutline: state => deriveOutlineFromConversationState(state as ConversationState),
          }) as unknown as ConversationStatePort;
        },
      });
    },
    createHandoffDeps(): BoxHandoffDeps {
      const box = context.deps["forever-box"].box;
      return {
        grabScreenshot: agentId => grabHandoffScreenshot(box, requestContext, agentId),
        onStarted: event => {
          void context.host.events.emit("session.box-handoff-started", event);
        },
        onEnded: event => context.host.events.emit(
          "session.box-handoff-ended",
          event,
          { failureMode: "reject" },
        ),
        onStatusChanged: agentId => {
          void context.host.events.emit("session.box-handoff-status-changed", { agentId });
        },
        telemetry: {
          reportBoxHelp: event => context.deps.telemetry.logs.reportBoxHelp(event),
          trackEvent: (name, properties) => context.deps.telemetry.analytics.trackEvent(name, properties),
        },
      };
    },
  };
}

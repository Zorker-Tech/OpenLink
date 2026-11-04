/** Public coordinator for agent directories, serialized minting, and session materialization. */
import type { SlateAgentProfile } from "../../agents/agent-profile.ts";
import type { MaterializationHost, MaterializedSession } from "./session-materialization-contracts.ts";
import { SessionMintQueue } from "./session-mint-queue.ts";
import { SessionStoreMaterializer } from "./session-store-materializer.ts";

export {
  DEFAULT_AGENT_AUTOMATIONS,
  MAX_AGENTS_PER_USER,
  SlateAgentLimitError,
  SlateAgentMissingError,
} from "./session-materialization-contracts.ts";
export type { MaterializationHost, MaterializedSession, WorkerPool } from "./session-materialization-contracts.ts";

export class SlateSessionMaterialization {
  private readonly mintQueue: SessionMintQueue;
  private readonly storeMaterializer: SessionStoreMaterializer;

  constructor(readonly host: MaterializationHost) {
    this.mintQueue = new SessionMintQueue(host);
    this.storeMaterializer = new SessionStoreMaterializer(host, () => this.mintQueue.requireWorkerPool());
  }

  requireWorkerPool() {
    return this.mintQueue.requireWorkerPool();
  }

  closeWorkerPool(): Promise<void> {
    return this.mintQueue.closeWorkerPool();
  }

  listAgentRecordIds(): Promise<string[]> {
    return this.mintQueue.listAgentDirectories();
  }

  countOwnedAgents(): Promise<number> {
    return this.mintQueue.countOwnedAgents();
  }

  enqueueMint<T>(run: () => Promise<T>): Promise<T> {
    return this.mintQueue.enqueue(run);
  }

  mintAgent<T>(mint: (agentId: string) => Promise<T>): Promise<T> {
    return this.mintQueue.mintWithCapacity(mint, () => this.isAgentCapReached(), (run) => this.enqueueMint(run));
  }

  createSession(
    profile?: Partial<SlateAgentProfile>,
    origin: "user" | "dev" = "user",
    purpose?: string,
  ): Promise<MaterializedSession> {
    return this.mintAgent((agentId) => this.storeMaterializer.createAgent(agentId, profile, origin, purpose));
  }

  createFallbackSession(openSession: (agentId: string) => Promise<MaterializedSession>): Promise<MaterializedSession> {
    return this.mintQueue.createFallbackSession(
      openSession,
      (agentId) => this.storeMaterializer.createAgent(agentId, undefined, "user"),
      () => this.isAgentCapReached(),
      (run) => this.enqueueMint(run),
    );
  }

  materializeSession(
    agentId: string,
    profile?: Partial<SlateAgentProfile>,
    origin: "user" | "dev" = "user",
    purpose?: string,
  ): Promise<MaterializedSession> {
    return this.storeMaterializer.createAgent(agentId, profile, origin, purpose);
  }

  openSession(agentId: string): Promise<MaterializedSession> {
    return this.storeMaterializer.openAgent(agentId);
  }

  isAgentCapReached(): Promise<boolean> {
    return this.mintQueue.isAtCapacity();
  }

  isPrunedPlaceholder(agentId: string): Promise<boolean> {
    return this.mintQueue.isInvisiblePlaceholder(agentId);
  }

  reclaimPrunedPlaceholders(): Promise<void> {
    return this.mintQueue.removeInvisiblePlaceholders();
  }
}

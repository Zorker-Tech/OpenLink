import type { AgentWorkerPool } from "../../agents/isolation/agent-worker-pool.ts";
import type { SlateAgentProfile } from "../../agents/agent-profile.ts";
import type { SlateAgentDb } from "./agent-db.ts";
import type {
  automationStoreForDbPath,
  channelStoreForDbPath,
  workflowStoreForDbPath,
} from "./session-store-factories.ts";

export const MAX_AGENTS_PER_USER = 50;
export const DEFAULT_AGENT_AUTOMATIONS: readonly unknown[] = [];

export class SlateAgentMissingError extends Error {
  constructor(agentId: string) {
    super(`Slate agent ${agentId} does not exist`);
    this.name = "SlateAgentMissingError";
  }
}

export class SlateAgentLimitError extends Error {
  constructor() {
    super(`Agent limit of ${MAX_AGENTS_PER_USER} reached`);
    this.name = "SlateAgentLimitError";
  }
}

export interface WorkerPool {
  closeAll(): Promise<void>;
}

export interface MaterializedSession {
  id: string;
  dbPath: string;
  db: SlateAgentDb;
  agentStore: {
    resetFromDb?(ctx: unknown): Promise<void>;
    getFullConversation(ctx: unknown): Promise<unknown>;
    dispose(): Promise<void>;
  };
  memory: unknown;
  automations: ReturnType<typeof automationStoreForDbPath>;
  workflows: ReturnType<typeof workflowStoreForDbPath>;
  channels: ReturnType<typeof channelStoreForDbPath>;
}

export interface MaterializationHost {
  ctx: unknown;
  rootDir: string;
  createBlobWorkerPool(): AgentWorkerPool;
  createAgentStore(args: { pool: AgentWorkerPool; agentId: string; dbPath: string; db: SlateAgentDb }): MaterializedSession["agentStore"];
  createMemoryStore(agentDir: string): unknown;
  resolveUserTimeZone(): string | undefined;
  agentExists(agentId: string): boolean;
  getAgentDir(agentId: string): string;
  readActiveAgentId(): string | null;
  isVisibleAgent?(agentId: string): Promise<boolean>;
  runMaintenance?(session: MaterializedSession): Promise<void>;
  report?(event: Record<string, unknown>): void;
}

import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { getAgentDbPath } from "./session-paths.ts";
import { MAX_AGENTS_PER_USER, SlateAgentLimitError, type MaterializationHost } from "./session-materialization-contracts.ts";
import { agentDirectoryIdsFrom } from "./session-directory-index.ts";
import type { AgentWorkerPool } from "../../agents/isolation/agent-worker-pool.ts";

export class SessionMintQueue {
  private pool: AgentWorkerPool | null = null;
  private pendingMints: Promise<unknown> = Promise.resolve();

  constructor(private readonly hostServices: MaterializationHost) {}

  requireWorkerPool(): AgentWorkerPool {
    this.pool ??= this.hostServices.createBlobWorkerPool();
    return this.pool;
  }

  async closeWorkerPool(): Promise<void> {
    const previousPool = this.pool;
    if (previousPool == null) return;
    this.pool = null;
    await previousPool.closeAll();
  }

  async listAgentDirectories(): Promise<string[]> {
    try {
      const entries = await readdir(this.hostServices.rootDir, { withFileTypes: true });
      return agentDirectoryIdsFrom(entries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async countOwnedAgents(): Promise<number> {
    return (await this.listAgentDirectories()).length;
  }

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.pendingMints.then(run, run);
    this.pendingMints = next.then(() => {}, () => {});
    return next;
  }

  mintWithCapacity<T>(
    mint: (agentId: string) => Promise<T>,
    isCapReached: () => Promise<boolean>,
    enqueue: <TResult>(run: () => Promise<TResult>) => Promise<TResult>,
  ): Promise<T> {
    return enqueue(async () => {
      if (await isCapReached()) throw new SlateAgentLimitError();
      return this.withCleanupOnFailure(randomUUID(), mint);
    });
  }

  createFallbackSession<T>(
    openSession: (agentId: string) => Promise<T>,
    createSession: (agentId: string) => Promise<T>,
    isCapReached: () => Promise<boolean>,
    enqueue: <TResult>(run: () => Promise<TResult>) => Promise<TResult>,
  ): Promise<T> {
    return enqueue(async () => {
      if (await isCapReached()) {
        for (const agentId of await this.listAgentDirectories()) {
          try {
            return await openSession(agentId);
          } catch (error) {
            this.hostServices.report?.({
              family: "materialize",
              kind: "fallback_adopt_failed",
              agentId,
              errorClass: error instanceof Error ? error.name : typeof error,
            });
          }
        }
        throw new SlateAgentLimitError();
      }
      return this.withCleanupOnFailure(randomUUID(), createSession);
    });
  }

  async isAtCapacity(): Promise<boolean> {
    if (await this.countOwnedAgents() < MAX_AGENTS_PER_USER) return false;
    await this.removeInvisiblePlaceholders();
    return await this.countOwnedAgents() >= MAX_AGENTS_PER_USER;
  }

  async isInvisiblePlaceholder(agentId: string): Promise<boolean> {
    try {
      await stat(getAgentDbPath(this.hostServices.rootDir, agentId));
    } catch {
      return false;
    }
    if (agentId === this.hostServices.readActiveAgentId()) return false;
    return this.hostServices.isVisibleAgent != null ? !(await this.hostServices.isVisibleAgent(agentId)) : false;
  }

  async removeInvisiblePlaceholders(): Promise<void> {
    for (const agentId of await this.listAgentDirectories()) {
      if (!await this.isInvisiblePlaceholder(agentId)) continue;
      try {
        await rm(this.hostServices.getAgentDir(agentId), { recursive: true, force: true });
      } catch (error) {
        this.hostServices.report?.({
          family: "materialize",
          kind: "placeholder_reclaim_failed",
          agentId,
          errorClass: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }

  private async withCleanupOnFailure<T>(agentId: string, create: (agentId: string) => Promise<T>): Promise<T> {
    try {
      return await create(agentId);
    } catch (error) {
      try {
        await rm(this.hostServices.getAgentDir(agentId), { recursive: true, force: true });
      } catch (cleanupError) {
        this.hostServices.report?.({
          family: "materialize",
          kind: "mint_cleanup_failed",
          agentId,
          errorClass: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError,
        });
      }
      throw error;
    }
  }
}

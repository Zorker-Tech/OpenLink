/** Bind a worker pool to one agent's blob database. */
import type { AgentWorkerPool } from "./agent-worker-pool.ts"

export class WorkerBlobStore {
  constructor(
    readonly pool: AgentWorkerPool,
    readonly agentId: string,
    readonly blobDbPath: string,
    readonly legacyBlobDbPath?: string,
  ) {}

  async getBlob(_context: unknown, blobId: Uint8Array): Promise<Uint8Array | undefined> {
    return this.readBlob(blobId)
  }

  async setBlob(_context: unknown, blobId: Uint8Array, bytes: Uint8Array): Promise<void> {
    await this.writeBlob(blobId, bytes)
  }

  async setBlobLocallyOnly(_context: unknown, blobId: Uint8Array, bytes: Uint8Array): Promise<void> {
    await this.writeBlob(blobId, bytes)
  }

  async flush(_context: unknown): Promise<void> {}

  private readBlob(blobId: Uint8Array): Promise<Uint8Array | undefined> {
    return this.pool.getBlob(this.agentId, this.blobDbPath, blobId, this.legacyBlobDbPath)
  }

  private writeBlob(blobId: Uint8Array, bytes: Uint8Array): Promise<void> {
    return this.pool.setBlob(this.agentId, this.blobDbPath, blobId, bytes, this.legacyBlobDbPath)
  }
}

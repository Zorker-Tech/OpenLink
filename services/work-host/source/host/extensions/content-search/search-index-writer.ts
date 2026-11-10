/** Applies transcript entry jobs to the local message/media index. */
import type { DatabaseSync } from "node:sqlite";
import { writeReconcileDone } from "./search-index-db.ts";
import { projectMedia, projectMessage } from "./search-index-row-projector.ts";
import { SearchIndexTranscriptReader } from "./search-index-transcript-reader.ts";
import { prepareSearchIndexWrites } from "./search-index-write-statements.ts";
import {
  INCREMENTAL_VACUUM_PAGES,
  type IndexEntry,
  type SearchIndexJob,
} from "./search-index-writer-contracts.ts";

export { INCREMENTAL_VACUUM_PAGES, STORE_FILENAME } from "./search-index-writer-contracts.ts";
export type { IndexEntry, SearchIndexJob } from "./search-index-writer-contracts.ts";

interface AgentFingerprintRow {
  readonly fingerprint?: unknown;
}

interface IndexedAgentRow {
  readonly agentId?: unknown;
}

export class SlateSearchIndexWriter {
  private readonly sourceReaders: SearchIndexTranscriptReader;
  private readonly writes: ReturnType<typeof prepareSearchIndexWrites>;

  constructor(private readonly indexDb: DatabaseSync, agentsRootDir: string) {
    this.sourceReaders = new SearchIndexTranscriptReader(agentsRootDir);
    this.writes = prepareSearchIndexWrites(indexDb);
  }

  close(): void {
    this.sourceReaders.close();
  }

  runJob(job: SearchIndexJob): void {
    if (job.kind === "upsert-entries") return this.upsertEntries(job.agentId, job.entries);
    if (job.kind === "delete-entry") return this.deleteEntry(job.agentId, job.entryId);
    if (job.kind === "clear-agent") return this.clearAgent(job.agentId);
    if (job.kind === "reindex-agents") {
      for (const agentId of job.agentIds) this.reindexAgent(agentId);
      return;
    }
    this.reconcile();
  }

  upsertEntries(agentId: string, entries: readonly IndexEntry[]): void {
    if (entries.length === 0) return;
    this.transaction(() => {
      for (const entry of entries) this.writeEntry(agentId, entry);
      this.refreshFingerprint(agentId);
    });
  }

  deleteEntry(agentId: string, entryId: string): void {
    this.transaction(() => {
      this.writes.removeMessage.run(agentId, entryId);
      this.writes.removeMedia.run(agentId, entryId);
      this.refreshFingerprint(agentId);
    });
  }

  clearAgent(agentId: string): void {
    this.sourceReaders.forget(agentId);
    this.transaction(() => {
      this.writes.removeAgentMessages.run(agentId);
      this.writes.removeAgentMedia.run(agentId);
      this.writes.removeFingerprint.run(agentId);
    });
    this.vacuumIncrementally();
  }

  reindexAgent(agentId: string): void {
    this.sourceReaders.forget(agentId);
    if (!this.sourceReaders.sourceExists(agentId)) {
      this.clearAgent(agentId);
      return;
    }

    const snapshot = this.sourceReaders.readAll(agentId);
    if (snapshot === null) return;
    this.transaction(() => {
      this.writes.removeAgentMessages.run(agentId);
      this.writes.removeAgentMedia.run(agentId);
      for (const entry of snapshot.entries) this.writeEntry(agentId, entry);
      this.writes.storeFingerprint.run(agentId, snapshot.fingerprint);
    });
    this.vacuumIncrementally();
  }

  reconcile(): void {
    const diskAgents = this.sourceReaders.agentDirectories();
    const diskIds = new Set(diskAgents);
    const indexedRows = this.writes.allIndexedAgentIds.all() as IndexedAgentRow[];
    for (const row of indexedRows) {
      if (typeof row.agentId === "string" && !diskIds.has(row.agentId)) this.clearAgent(row.agentId);
    }

    for (const agentId of diskAgents) {
      if (!this.sourceReaders.sourceExists(agentId)) continue;
      const latest = this.sourceReaders.fingerprint(agentId);
      const indexed = this.writes.loadFingerprint.get(agentId) as AgentFingerprintRow | undefined;
      if (latest !== null && indexed?.fingerprint !== latest) this.reindexAgent(agentId);
    }
    writeReconcileDone(this.indexDb);
  }

  private writeEntry(agentId: string, entry: IndexEntry): void {
    const message = projectMessage(entry);
    if (message === null) this.writes.removeMessage.run(agentId, entry.id);
    else this.writes.writeMessage.run(agentId, message.entryId, message.role, message.timestampMs, message.body);

    const media = projectMedia(entry);
    if (media === null) this.writes.removeMedia.run(agentId, entry.id);
    else {
      this.writes.writeMedia.run(
        agentId,
        media.entryId,
        media.fileName,
        media.ext,
        media.mime,
        media.kind,
        media.timestampMs,
        media.width,
        media.height,
      );
    }
  }

  private refreshFingerprint(agentId: string): void {
    const next = this.sourceReaders.fingerprint(agentId);
    if (next === null) this.writes.removeFingerprint.run(agentId);
    else this.writes.storeFingerprint.run(agentId, next);
  }

  private vacuumIncrementally(): void {
    this.indexDb.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`);
  }

  private transaction(update: () => void): void {
    this.indexDb.exec("BEGIN IMMEDIATE");
    try {
      update();
      this.indexDb.exec("COMMIT");
    } catch (error) {
      try { this.indexDb.exec("ROLLBACK"); } catch { /* Preserve the original write failure. */ }
      throw error;
    }
  }
}

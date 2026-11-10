/** Cached read-only handles for the source transcript databases being indexed. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_BUSY_TIMEOUT_MS } from "../../storage/store-db.ts";
import { STORE_FILENAME, type IndexEntry } from "./search-index-writer-contracts.ts";

interface TranscriptRow {
  seq?: unknown;
  entry?: unknown;
}

export interface ReindexedTranscript {
  readonly entries: readonly IndexEntry[];
  readonly fingerprint: string;
}

export class SearchIndexTranscriptReader {
  private readonly opened = new Map<string, DatabaseSync>();

  constructor(private readonly agentsRoot: string) {}

  sourceExists(agentId: string): boolean {
    return existsSync(this.pathFor(agentId));
  }

  agentDirectories(): string[] {
    try {
      return readdirSync(this.agentsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return [];
    }
  }

  fingerprint(agentId: string): string | null {
    const connection = this.database(agentId);
    if (connection === null) return null;
    try {
      const result = connection.prepare("SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS maxSeq FROM transcript_entries").get() as { count?: unknown; maxSeq?: unknown } | undefined;
      return typeof result?.count === "number" && typeof result.maxSeq === "number" ? `${result.count}:${result.maxSeq}` : null;
    } catch {
      this.evict(agentId);
      return null;
    }
  }

  readAll(agentId: string): ReindexedTranscript | null {
    const connection = this.database(agentId);
    if (connection === null) return null;
    let rows: TranscriptRow[];
    try {
      rows = connection.prepare("SELECT seq, entry FROM transcript_entries ORDER BY seq").all() as TranscriptRow[];
    } catch {
      this.evict(agentId);
      return null;
    }

    let largestSequence = 0;
    const entries: IndexEntry[] = [];
    for (const row of rows) {
      if (typeof row.seq === "number") largestSequence = Math.max(largestSequence, row.seq);
      if (typeof row.entry !== "string") continue;
      try {
        const decoded = JSON.parse(row.entry) as Partial<IndexEntry>;
        if (typeof decoded.id === "string" && typeof decoded.kind === "string") entries.push(decoded as IndexEntry);
      } catch {
        // One malformed transcript line does not hide the other entries.
      }
    }
    return { entries, fingerprint: `${rows.length}:${largestSequence}` };
  }

  close(): void {
    for (const database of this.opened.values()) {
      try { database.close(); } catch { /* A source may have closed while it was being reconciled. */ }
    }
    this.opened.clear();
  }

  forget(agentId: string): void {
    this.evict(agentId);
  }

  private database(agentId: string): DatabaseSync | null {
    const cached = this.opened.get(agentId);
    if (cached !== undefined) return cached;
    const path = this.pathFor(agentId);
    if (!existsSync(path)) return null;
    try {
      const database = new DatabaseSync(path, { readOnly: true });
      database.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
      this.opened.set(agentId, database);
      return database;
    } catch {
      return null;
    }
  }

  private evict(agentId: string): void {
    const database = this.opened.get(agentId);
    this.opened.delete(agentId);
    try { database?.close(); } catch { /* The handle is no longer part of the read cache. */ }
  }

  private pathFor(agentId: string): string {
    return join(this.agentsRoot, agentId, STORE_FILENAME);
  }
}

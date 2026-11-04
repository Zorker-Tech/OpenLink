import { DatabaseSync } from "node:sqlite";

import { DB_BUSY_TIMEOUT_MS } from "../../storage/store-db.ts";
import { META_RECONCILE_DONE, SEARCH_INDEX_SCHEMA_VERSION } from "./search-index-db-contracts.ts";

export const SCHEMA = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, entry_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), timestamp_ms INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(agent_id, entry_id)) STRICT;
CREATE INDEX IF NOT EXISTS messages_agent_recency ON messages(agent_id, timestamp_ms DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3');
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body); END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body); END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body); INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body); END;
CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, entry_id TEXT NOT NULL, file_name TEXT NOT NULL, ext TEXT NOT NULL, mime TEXT, kind TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, width INTEGER, height INTEGER, UNIQUE(agent_id, entry_id)) STRICT;
CREATE INDEX IF NOT EXISTS media_recency ON media(timestamp_ms DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(file_name, content='media', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3');
CREATE TRIGGER IF NOT EXISTS media_fts_insert AFTER INSERT ON media BEGIN INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name); END;
CREATE TRIGGER IF NOT EXISTS media_fts_delete AFTER DELETE ON media BEGIN INSERT INTO media_fts(media_fts, rowid, file_name) VALUES ('delete', old.id, old.file_name); END;
CREATE TRIGGER IF NOT EXISTS media_fts_update AFTER UPDATE ON media BEGIN INSERT INTO media_fts(media_fts, rowid, file_name) VALUES ('delete', old.id, old.file_name); INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name); END;`;

export function openSearchIndexDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

export function ensureSearchIndexSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

export function readSearchIndexSchemaVersion(db: DatabaseSync): number {
  const value = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return typeof value?.user_version === "number" ? value.user_version : 0;
}

export function stampSearchIndexSchemaVersion(db: DatabaseSync): void {
  db.exec(`PRAGMA user_version = ${SEARCH_INDEX_SCHEMA_VERSION}`);
}

export function readReconcileDone(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_RECONCILE_DONE) as { value?: unknown } | undefined;
  return row?.value === "1";
}

export function writeReconcileDone(db: DatabaseSync): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
    .run(META_RECONCILE_DONE);
}

/** Prepared SQL operations for the writer's single SQLite transaction boundary. */
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface SearchIndexWriteStatements {
  readonly writeMessage: StatementSync;
  readonly removeMessage: StatementSync;
  readonly removeAgentMessages: StatementSync;
  readonly writeMedia: StatementSync;
  readonly removeMedia: StatementSync;
  readonly removeAgentMedia: StatementSync;
  readonly storeFingerprint: StatementSync;
  readonly removeFingerprint: StatementSync;
  readonly loadFingerprint: StatementSync;
  readonly allIndexedAgentIds: StatementSync;
}

function messageOperations(db: DatabaseSync) {
  return {
    writeMessage: db.prepare("INSERT INTO messages (agent_id, entry_id, role, timestamp_ms, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id, entry_id) DO UPDATE SET role=excluded.role,timestamp_ms=excluded.timestamp_ms,body=excluded.body"),
    removeMessage: db.prepare("DELETE FROM messages WHERE agent_id = ? AND entry_id = ?"),
    removeAgentMessages: db.prepare("DELETE FROM messages WHERE agent_id = ?"),
  };
}

function mediaOperations(db: DatabaseSync) {
  return {
    writeMedia: db.prepare("INSERT INTO media (agent_id,entry_id,file_name,ext,mime,kind,timestamp_ms,width,height) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,entry_id) DO UPDATE SET file_name=excluded.file_name,ext=excluded.ext,mime=excluded.mime,kind=excluded.kind,timestamp_ms=excluded.timestamp_ms,width=excluded.width,height=excluded.height"),
    removeMedia: db.prepare("DELETE FROM media WHERE agent_id = ? AND entry_id = ?"),
    removeAgentMedia: db.prepare("DELETE FROM media WHERE agent_id = ?"),
  };
}

function fingerprintOperations(db: DatabaseSync) {
  return {
    storeFingerprint: db.prepare("INSERT INTO agents (agent_id,fingerprint) VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET fingerprint=excluded.fingerprint"),
    removeFingerprint: db.prepare("DELETE FROM agents WHERE agent_id = ?"),
    loadFingerprint: db.prepare("SELECT fingerprint FROM agents WHERE agent_id = ?"),
    allIndexedAgentIds: db.prepare("SELECT agent_id AS agentId FROM agents UNION SELECT DISTINCT agent_id FROM messages UNION SELECT DISTINCT agent_id FROM media"),
  };
}

export function prepareSearchIndexWrites(db: DatabaseSync): SearchIndexWriteStatements {
  return { ...messageOperations(db), ...mediaOperations(db), ...fingerprintOperations(db) };
}

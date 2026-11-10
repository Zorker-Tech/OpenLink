/**
 * The schema an agent's database is created with, and the filters that read a window of it: what a transcript window
 * shows and what belongs to a branch.
 */
export const WINDOW_ENTRY_FILTER_SQL = `json_extract(entry, '$.kind') != 'tool-call'
        AND COALESCE(json_extract(entry, '$.branched'), 0) != 1`;
export const BRANCHED_ENTRY_FILTER_SQL = `COALESCE(json_extract(entry, '$.branched'), 0) = 1`;
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- Conversation blobs are owned by the agent's isolation worker in its own
-- conversation-blobs.db; this legacy table remains readable for adoption and salvage.
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS transcript_entries (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  entry TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_transcript_window
  ON transcript_entries(seq, entry)
  WHERE ${WINDOW_ENTRY_FILTER_SQL};
CREATE INDEX IF NOT EXISTS idx_transcript_branched
  ON transcript_entries(seq, entry)
  WHERE ${BRANCHED_ENTRY_FILTER_SQL};
`;
export const MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL = `
        COALESCE(json_extract(entry, '$.branched'), 0) != 1
        AND (
          json_extract(entry, '$.kind') IN ('send-message', 'user-attachment')
          OR (
            json_extract(entry, '$.kind') = 'message'
            AND (
              json_extract(entry, '$.role') = 'user'
              OR json_extract(entry, '$.fromAgent') IS NOT NULL
              OR json_extract(entry, '$.toAgent') IS NOT NULL
            )
          )
        )`;
export const DIVIDER_ANCHOR_ENTRY_FILTER_SQL = `
        ${MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL}
        AND NOT (
          json_extract(entry, '$.kind') = 'user-attachment'
          OR (
            json_extract(entry, '$.kind') = 'message'
            AND json_extract(entry, '$.role') = 'user'
            AND json_extract(entry, '$.fromAgent') IS NULL
            AND json_extract(entry, '$.toAgent') IS NULL
          )
        )`;

export interface PreparedStatement { all(...parameters: unknown[]): unknown[]; get(...parameters: unknown[]): unknown; run(...parameters: unknown[]): unknown }
export interface StatementDatabase { prepare(sql: string): PreparedStatement }
/** Every statement the agent's database is read and written through, by the name the caller knows it by. */
const STATEMENTS: Readonly<Record<string, string>> = {
  getKv: "SELECT value FROM kv WHERE key = ?",
  setKv: "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  compareAndSetKv: "UPDATE kv SET value = ? WHERE key = ? AND value = ?",
  deleteKv: "DELETE FROM kv WHERE key = ?",
  hasLegacyBlob: "SELECT 1 AS present FROM blobs LIMIT 1",
  clearBlobs: "DELETE FROM blobs",
  listTranscriptEntries: "SELECT entry FROM transcript_entries ORDER BY seq",
  newestDividerAnchorTimestamp: `SELECT json_extract(entry, '$.timestampMs') AS timestampMs FROM transcript_entries WHERE json_extract(entry, '$.timestampMs') IS NOT NULL AND ${DIVIDER_ANCHOR_ENTRY_FILTER_SQL} ORDER BY seq DESC LIMIT 1`,
  listTranscriptPage: `SELECT seq, entry FROM transcript_entries WHERE (? IS NULL OR seq < ?) AND (json_extract(entry, '$.timestampMs') IS NULL OR (? IS NULL OR json_extract(entry, '$.timestampMs') >= ?)) AND (json_extract(entry, '$.timestampMs') IS NULL OR json_extract(entry, '$.timestampMs') <= ?) AND ${MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL} ORDER BY seq DESC LIMIT ?`,
  listTranscriptWindow: `SELECT seq, entry FROM transcript_entries WHERE (? IS NULL OR seq < ?) AND ${WINDOW_ENTRY_FILTER_SQL} ORDER BY seq DESC LIMIT ?`,
  listTranscriptTail: "SELECT seq, entry FROM transcript_entries WHERE (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?",
  listBranchedEntries: `SELECT entry FROM transcript_entries WHERE ${BRANCHED_ENTRY_FILTER_SQL} ORDER BY seq`,
  getTranscriptEntry: "SELECT entry FROM transcript_entries WHERE id = ?",
  insertTranscriptEntry: "INSERT OR IGNORE INTO transcript_entries (id, entry) VALUES (?, ?)",
  updateTranscriptEntry: "UPDATE transcript_entries SET entry = ? WHERE id = ?",
  deleteTranscriptEntry: "DELETE FROM transcript_entries WHERE id = ?",
  clearTranscriptEntries: "DELETE FROM transcript_entries",
};

/** Prepares them all against one connection, once per connection. */
export function prepareStatements(db: StatementDatabase): Record<string, PreparedStatement> {
  const prepared: Record<string, PreparedStatement> = {};
  for (const [name, sql] of Object.entries(STATEMENTS)) prepared[name] = db.prepare(sql);
  return prepared;
}

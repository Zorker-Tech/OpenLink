import { AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT } from "./agent-content-search.ts";
import { SNIPPET_CONTEXT_TOKENS } from "./search-index-db-contracts.ts";
import { buildFtsMatchQuery } from "./search-index-db-query.ts";
import { projectMediaRow, projectMessageRows, readIndexRows } from "./search-index-db-projection.ts";
import type { DatabaseSync } from "node:sqlite";
import type { MediaSearchResult, MessageSearchResult } from "./search-index-db-contracts.ts";

export function searchMessages(db: DatabaseSync, query: string, limit: number): MessageSearchResult[] {
  const matchExpression = buildFtsMatchQuery(query);
  if (matchExpression === null || limit <= 0) return [];

  const recencyExpression = `CASE
    WHEN m.timestamp_ms > 0 THEN m.timestamp_ms
    ELSE COALESCE((SELECT MAX(m2.timestamp_ms) FROM messages m2 WHERE m2.agent_id = m.agent_id), 0)
  END`;
  const matchedRows = readIndexRows(db, `SELECT
      m.agent_id AS agentId,
      m.entry_id AS entryId,
      m.role AS role,
      matched.ts AS timestampMs,
      snippet(messages_fts, 0, '', '', '…', ${SNIPPET_CONTEXT_TOKENS}) AS snippet
    FROM (
      SELECT fts_rowid, ts FROM (
        SELECT fts_rowid, ts,
          ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts DESC) AS agent_rank
        FROM (
          SELECT messages_fts.rowid AS fts_rowid, m.agent_id AS agent_id, ${recencyExpression} AS ts
          FROM messages_fts
          JOIN messages m ON m.id = messages_fts.rowid
          WHERE messages_fts MATCH ?
        )
      )
      WHERE agent_rank <= ${AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT}
      ORDER BY ts DESC
      LIMIT ?
    ) AS matched
    JOIN messages_fts ON messages_fts.rowid = matched.fts_rowid
    JOIN messages m ON m.id = matched.fts_rowid
    WHERE messages_fts MATCH ?
    ORDER BY matched.ts DESC`, matchExpression, limit, matchExpression);
  return projectMessageRows(matchedRows);
}

export function searchMedia(db: DatabaseSync, query: string, limit: number): MediaSearchResult[] {
  if (limit <= 0) return [];
  const matchExpression = buildFtsMatchQuery(query);
  const selectedColumns = "md.agent_id AS agentId, md.entry_id AS entryId, md.file_name AS fileName, md.ext AS ext, md.mime AS mime, md.kind AS kind, md.timestamp_ms AS timestampMs, md.width AS width, md.height AS height";
  const mediaRows = matchExpression === null
    ? readIndexRows(db, `SELECT ${selectedColumns} FROM media md ORDER BY md.timestamp_ms DESC LIMIT ?`, limit)
    : readIndexRows(db, `SELECT ${selectedColumns} FROM media_fts JOIN media md ON md.id = media_fts.rowid WHERE media_fts MATCH ? ORDER BY md.timestamp_ms DESC LIMIT ?`, matchExpression, limit);

  return mediaRows.flatMap((row) => {
    const result = projectMediaRow(row);
    return result === undefined ? [] : [result];
  });
}

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { AttachmentKind, MediaSearchResult, MessageSearchResult } from "./search-index-db-contracts.ts";

const validAttachmentKinds = new Set<AttachmentKind>([
  "image", "video", "audio", "pdf", "markdown", "table", "json", "text", "document", "archive", "file",
]);

export function readIndexRows(
  db: DatabaseSync,
  sql: string,
  ...parameters: SQLInputValue[]
): Record<string, unknown>[] {
  return db.prepare(sql).all(...parameters) as Record<string, unknown>[];
}

function messageResultFrom(candidate: Record<string, unknown>): MessageSearchResult | undefined {
  const agentId = candidate.agentId;
  const entryId = candidate.entryId;
  const role = candidate.role;
  const timestamp = candidate.timestampMs;
  const snippet = candidate.snippet;
  if (typeof agentId !== "string" || typeof entryId !== "string") return undefined;
  if (role !== "user" && role !== "assistant") return undefined;
  if (typeof timestamp !== "number" || typeof snippet !== "string") return undefined;

  const identity = { agentId, entryId };
  const messageDetails: Omit<MessageSearchResult, "agentId" | "entryId"> = {
    role,
    timestampMs: timestamp,
    snippet: snippet.replace(/\s+/g, " ").trim(),
  };
  return { ...identity, ...messageDetails };
}

export function projectMessageRows(sourceRows: readonly Record<string, unknown>[]): MessageSearchResult[] {
  const projected: MessageSearchResult[] = [];
  for (const candidate of sourceRows) {
    const message = messageResultFrom(candidate);
    if (message !== undefined) projected.push(message);
  }
  return projected;
}

export function projectMediaRow(candidate: Record<string, unknown>): MediaSearchResult | undefined {
  const agentId = candidate.agentId;
  const entryId = candidate.entryId;
  const fileName = candidate.fileName;
  const extension = candidate.ext;
  const sourceKind = candidate.kind;
  const timestamp = candidate.timestampMs;
  if (typeof agentId !== "string" || typeof entryId !== "string") return undefined;
  if (typeof fileName !== "string" || typeof extension !== "string" || typeof sourceKind !== "string") return undefined;
  if (typeof timestamp !== "number") return undefined;

  const kind = validAttachmentKinds.has(sourceKind as AttachmentKind) ? sourceKind as AttachmentKind : "file";
  const identity = { agentId, entryId };
  const attachmentDetails = {
    fileName,
    ext: extension,
    mime: typeof candidate.mime === "string" ? candidate.mime : null,
    kind,
    timestampMs: timestamp,
    width: typeof candidate.width === "number" ? candidate.width : null,
    height: typeof candidate.height === "number" ? candidate.height : null,
  };
  return {
    ...identity,
    ...attachmentDetails,
  };
}

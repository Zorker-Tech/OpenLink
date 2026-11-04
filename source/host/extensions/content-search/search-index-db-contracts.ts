export const SEARCH_INDEX_SCHEMA_VERSION = 1;
export const SEARCH_INDEX_FILENAME = "search-index.db";
export const FTS_QUERY_MAX_TERMS = 8;
export const SNIPPET_CONTEXT_TOKENS = 16;
export const META_RECONCILE_DONE = "reconcile_done";

export type AttachmentKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "table"
  | "json"
  | "text"
  | "document"
  | "archive"
  | "file";

export interface MessageSearchResult {
  readonly agentId: string;
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly timestampMs: number;
  readonly snippet: string;
}

export interface MediaSearchResult {
  readonly agentId: string;
  readonly entryId: string;
  readonly fileName: string;
  readonly ext: string;
  readonly mime: string | null;
  readonly kind: AttachmentKind;
  readonly timestampMs: number;
  readonly width: number | null;
  readonly height: number | null;
}

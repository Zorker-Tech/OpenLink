/** Input jobs and stable storage values for the transcript search writer. */
import type { AttachmentKind } from "./search-index-db.ts";

export const STORE_FILENAME = "store.db";
export const INCREMENTAL_VACUUM_PAGES = 512;
export const INDEXED_BODY_MAX_CHARS = 20_000;

export interface IndexEntry {
  readonly id: string;
  readonly kind: string;
  readonly timestampMs?: number;
  readonly role?: "user" | "assistant";
  readonly content?: string;
  readonly text?: string;
  readonly toAgent?: { readonly kind?: string };
  readonly message?: { readonly type?: string; readonly content?: string; readonly url?: string; readonly file_name?: string };
  readonly file_path?: string;
  readonly file_name?: string;
  readonly width?: number;
  readonly height?: number;
}

export type SearchIndexJob =
  | { readonly kind: "upsert-entries"; readonly agentId: string; readonly entries: readonly IndexEntry[] }
  | { readonly kind: "delete-entry"; readonly agentId: string; readonly entryId: string }
  | { readonly kind: "clear-agent"; readonly agentId: string }
  | { readonly kind: "reindex-agents"; readonly agentIds: readonly string[] }
  | { readonly kind: "reconcile" };

export interface ProjectedMessage {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly timestampMs: number;
  readonly body: string;
}

export interface ProjectedMedia {
  readonly entryId: string;
  readonly fileName: string;
  readonly ext: string;
  readonly mime: string | null;
  readonly kind: AttachmentKind;
  readonly timestampMs: number;
  readonly width: number | null;
  readonly height: number | null;
}

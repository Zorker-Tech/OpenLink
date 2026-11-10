export const MAX_ROOT_BLOB_BYTES = 8 * 1024 * 1024;
export const REBUILT_ENTRY_ID_PREFIX = "recovered-";

export interface OutlineItem {
  kind: "user" | "send-message" | "tool-call";
  id: string;
  hidden?: boolean;
  text?: string;
  message?: unknown;
  name?: string;
  status?: string;
  summary?: string;
  timestampMs?: number;
}

export interface ConversationStructureRefs {
  readonly turns: readonly Uint8Array[];
  readonly todos: readonly Uint8Array[];
  readonly summary?: Uint8Array;
}

export interface RootScore {
  readonly turns: number;
  readonly rootPrompts: number;
  readonly bytes: number;
}

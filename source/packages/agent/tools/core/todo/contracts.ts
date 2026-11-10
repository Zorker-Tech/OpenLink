import type { Context } from "../../../../context/context.ts";
import { PrivacyCapability } from "../../../../redaction/classification.ts";
import { RedactedString } from "../../../../redaction/redacted-values.ts";

export type SlateTodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "unspecified";
export type EditableTodoStatus = Exclude<SlateTodoStatus, "unspecified">;

/** A task record owned by Slate. External tool messages are mapped at their adapter boundary. */
export interface SlateTodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: SlateTodoStatus;
  readonly createdAt: bigint;
  readonly updatedAt: bigint;
  readonly dependencies?: readonly string[] | undefined;
}

/** Durable todo value after applying the active privacy policy. */
export interface SlateStoredTodoItem extends Omit<SlateTodoItem, "content"> {
  readonly content: string | RedactedString;
}

/** Copies every mutable field so state references cannot be changed through a caller-owned array. */
export function cloneSlateTodoItem(item: SlateTodoItem): SlateTodoItem {
  return {
    ...item,
    ...(item.dependencies === undefined ? {} : { dependencies: [...item.dependencies] }),
  }
}

/** Exposes todo content to a domain operation only after an explicit capability check. */
export function slateTodoItemWithReadableContent(item: SlateStoredTodoItem): SlateTodoItem {
  return {
    id: item.id,
    content: item.content instanceof RedactedString
      ? item.content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
      : item.content,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.dependencies === undefined ? {} : { dependencies: [...item.dependencies] }),
  }
}

export function cloneSlateStoredTodoItem(item: SlateStoredTodoItem): SlateStoredTodoItem {
  return {
    ...item,
    ...(item.dependencies === undefined ? {} : { dependencies: [...item.dependencies] }),
  }
}

export interface RawSlateTodo {
  readonly id: string;
  readonly content?: string | undefined;
  readonly status: EditableTodoStatus;
}

export interface SlateTodoInput {
  readonly todos: readonly RawSlateTodo[];
  readonly merge: boolean;
}

export type SlateTodoResult =
  | {
      readonly kind: "success";
      readonly todos: readonly SlateTodoItem[];
      readonly totalCount: number;
      readonly wasMerge: boolean;
    }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "unknown" };

/** A partial model-tool call that is independent of any stored or remote message format. */
export interface SlateTodoToolCall {
  readonly args?: {
    readonly todos?: readonly SlateTodoItem[] | undefined;
    readonly merge?: boolean | undefined;
  } | undefined;
  readonly result?: SlateTodoResult | undefined;
}

export interface TodoPromptProfile {
  /** The model-facing name required by the selected inference profile. */
  readonly toolName: string;
  /** Slate-authored guidance for keeping the session task list current. */
  readonly description: string;
  readonly mergeFirst: boolean;
  readonly minimumTodoCount?: number | undefined;
  readonly contentOptionalInPrompt: boolean;
  readonly successDisplay: "text" | "json-on-merge";
}

/** The todo tool depends on a domain port, not on persistence or executor messages. */
export interface SlateTodoStatePort {
  readTodos(ctx: Context): Promise<readonly SlateTodoItem[]>;
  writeTodos(todos: readonly SlateTodoItem[]): void | Promise<void>;
  syncPlanTodos(ctx: Context, toolCallId: string): Promise<void>;
}

export interface SlateTodoInteractionHandler {
  emitPartialToolCall(ctx: Context, toolCallId: string, toolCall: SlateTodoToolCall): void;
  executeToolCall(
    ctx: Context,
    toolCall: SlateTodoToolCall,
    toolCallId: string,
    run: (ctx: Context) => Promise<SlateTodoResult>,
    merge: (result: SlateTodoResult) => SlateTodoToolCall,
  ): Promise<SlateTodoResult>;
}

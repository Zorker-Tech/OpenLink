/** Maps Slate task records to external tool messages. */

import { TodoItem as InteropTodoItem, TodoStatus } from "../proto/generated/agent/v1/todo_tool_pb.ts";
import {
  fromRedactedTodoItem,
  toRedactedTodoItem,
} from "../redacted-protos/generated/agent/v1/todo_tool_redacted.ts";
import type { Context } from "../../../packages/context/context.ts";
import { DataClassification, PrivacyCapability, type DataClassification as DataClassificationValue } from "../../../packages/redaction/classification.ts";
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";
import { createRedactedString } from "../../../packages/redaction/create.ts";
import { RedactedString } from "../../../packages/redaction/redacted-values.ts";
import {
  cloneSlateTodoItem,
  slateTodoItemWithReadableContent,
  type SlateTodoItem,
  type SlateStoredTodoItem,
  type SlateTodoStatus,
} from "../../../packages/agent/tools/core/todo/contracts.ts";
import { utf8Serde } from "../../../packages/agent-kv/serde.ts";
import type { Serde } from "../../../packages/agent-kv/serde-contracts.ts";

export type RedactedInteropTodoItem = Parameters<typeof fromRedactedTodoItem>[0];
export type StoredTodoReference = {
  get(ctx: Context): Promise<SlateTodoItem | SlateStoredTodoItem | RedactedInteropTodoItem>;
};

interface StoredSlateTodoItemV1 {
  readonly id: string;
  readonly content: {
    readonly text: string;
    readonly classification: DataClassificationValue;
    readonly fieldName: string;
  };
  readonly status: SlateTodoStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dependencies?: readonly string[];
}

const TODO_STORAGE_HEADER = utf8Serde.serialize("SLATE-AGENT-TODO\n");
const TODO_STORAGE_FORMAT = "slate.agent-todo-item";
const DATA_CLASSIFICATIONS = new Set<string>(Object.values(DataClassification));
const SLATE_TODO_STATUSES = new Set<SlateTodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "unspecified",
]);

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function isStoredTodoEnvelope(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (!hasOnlyKeys(envelope, ["format", "version", "item"]) ||
      envelope.format !== TODO_STORAGE_FORMAT || envelope.version !== 1 ||
      envelope.item === null || typeof envelope.item !== "object" || Array.isArray(envelope.item)) return false;
  const item = envelope.item as Record<string, unknown>;
  if (!hasOnlyKeys(item, ["id", "content", "status", "createdAt", "updatedAt", "dependencies"]) ||
      typeof item.id !== "string" || item.content === null || typeof item.content !== "object" || Array.isArray(item.content) ||
      typeof item.status !== "string" || !SLATE_TODO_STATUSES.has(item.status as SlateTodoStatus) ||
      typeof item.createdAt !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(item.createdAt) ||
      typeof item.updatedAt !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(item.updatedAt) ||
      (item.dependencies !== undefined && (!Array.isArray(item.dependencies) || !item.dependencies.every(entry => typeof entry === "string")))
  ) return false;
  const content = item.content as Record<string, unknown>;
  return hasOnlyKeys(content, ["text", "classification", "fieldName"]) &&
    typeof content.text === "string" && typeof content.classification === "string" &&
    DATA_CLASSIFICATIONS.has(content.classification) && typeof content.fieldName === "string";
}

export function fromInteropTodoStatus(status: TodoStatus): SlateTodoStatus {
  switch (status) {
    case TodoStatus.PENDING: return "pending";
    case TodoStatus.IN_PROGRESS: return "in_progress";
    case TodoStatus.COMPLETED: return "completed";
    case TodoStatus.CANCELLED: return "cancelled";
    default: return "unspecified";
  }
}

export function toInteropTodoStatus(status: SlateTodoStatus): TodoStatus {
  switch (status) {
    case "pending": return TodoStatus.PENDING;
    case "in_progress": return TodoStatus.IN_PROGRESS;
    case "completed": return TodoStatus.COMPLETED;
    case "cancelled": return TodoStatus.CANCELLED;
    case "unspecified": return TodoStatus.UNSPECIFIED;
  }
}

export function fromInteropTodoItem(
  item: InteropTodoItem,
): SlateTodoItem {
  return {
    id: item.id,
    content: item.content,
    status: fromInteropTodoStatus(item.status),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.dependencies.length === 0 ? {} : { dependencies: [...item.dependencies] }),
  };
}

export function toInteropTodoItem(item: SlateTodoItem | SlateStoredTodoItem): InteropTodoItem {
  return new InteropTodoItem({
    id: item.id,
    content: item.content instanceof RedactedString
      ? item.content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
      : item.content,
    status: toInteropTodoStatus(item.status),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.dependencies === undefined ? {} : { dependencies: [...item.dependencies] }),
  });
}

export function fromRedactedInteropTodoItem(
  item: RedactedInteropTodoItem,
): SlateTodoItem {
  return fromInteropTodoItem(
    fromRedactedTodoItem(item, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
  );
}

export function toRedactedInteropTodoItem(item: SlateTodoItem, privacyMode: PrivacyMode): unknown {
  return toRedactedTodoItem(toInteropTodoItem(item), privacyMode);
}

export function redactSlateTodoItem(item: SlateTodoItem, privacyMode: PrivacyMode): SlateStoredTodoItem {
  return {
    ...cloneSlateTodoItem(item),
    content: createRedactedString(item.content, DataClassification.CODE, "content", privacyMode),
  }
}

export function readStoredTodos(
  ctx: Context,
  references: readonly StoredTodoReference[],
): Promise<readonly SlateTodoItem[]> {
  return Promise.all(references.map(async reference => {
    const stored = await reference.get(ctx)
    if (typeof (stored as { readonly status?: unknown }).status === "number") {
      return fromRedactedInteropTodoItem(stored as RedactedInteropTodoItem)
    }
    const slate = stored as SlateTodoItem | SlateStoredTodoItem
    return slate.content instanceof RedactedString
      ? slateTodoItemWithReadableContent(slate as SlateStoredTodoItem)
      : cloneSlateTodoItem(slate as SlateTodoItem)
  }))
}

function serializeSlateTodoItem(item: SlateStoredTodoItem): Uint8Array {
  if (typeof item.id !== "string" || typeof item.content !== "string" && !(item.content instanceof RedactedString)) {
    throw new TypeError("Slate todo identity and content must be text")
  }
  if (!SLATE_TODO_STATUSES.has(item.status) || typeof item.createdAt !== "bigint" || typeof item.updatedAt !== "bigint") {
    throw new TypeError("Slate todo status and timestamps are invalid")
  }
  if (item.dependencies !== undefined && (!Array.isArray(item.dependencies) || !item.dependencies.every(value => typeof value === "string"))) {
    throw new TypeError("Slate todo dependencies must be text values")
  }
  const content = item.content instanceof RedactedString
    ? {
        text: item.content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
        classification: item.content.__classification,
        fieldName: item.content.__fieldName,
      }
    : {
        text: item.content,
        classification: DataClassification.CODE,
        fieldName: "content",
      }
  const envelope = {
    format: TODO_STORAGE_FORMAT,
    version: 1,
    item: {
      id: item.id,
      content,
      status: item.status,
      createdAt: item.createdAt.toString(),
      updatedAt: item.updatedAt.toString(),
      ...(item.dependencies === undefined ? {} : { dependencies: [...item.dependencies] }),
    },
  }
  return utf8Serde.serialize(`SLATE-AGENT-TODO\n${JSON.stringify(envelope)}`)
}

export function createSlateTodoItemSerde(privacyMode: PrivacyMode): Serde<SlateStoredTodoItem> {
  return {
    serialize: serializeSlateTodoItem,
    deserialize(bytes) {
      if (bytes.length < TODO_STORAGE_HEADER.length ||
          !TODO_STORAGE_HEADER.every((byte, index) => bytes[index] === byte)) {
        throw new TypeError("Stored Slate todo envelope is unsupported")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(utf8Serde.deserialize(bytes.subarray(TODO_STORAGE_HEADER.length)))
      } catch (error) {
        throw new TypeError("Stored Slate todo is not valid JSON", { cause: error })
      }
      if (!isStoredTodoEnvelope(parsed)) throw new TypeError("Stored Slate todo envelope is invalid")
      const envelope = parsed as { readonly item: StoredSlateTodoItemV1 }
      const item = envelope.item
      return {
        id: item.id,
        content: createRedactedString(item.content.text, item.content.classification, item.content.fieldName, privacyMode),
        status: item.status,
        createdAt: BigInt(item.createdAt),
        updatedAt: BigInt(item.updatedAt),
        ...(item.dependencies === undefined ? {} : { dependencies: [...item.dependencies] }),
      }
    },
    getBlobType() {
      return { kind: "json", typeName: TODO_STORAGE_FORMAT }
    },
  }
}

export function deserializeSlateTodoItemInterop(bytes: Uint8Array): InteropTodoItem {
  return toInteropTodoItem(createSlateTodoItemSerde("unspecified").deserialize(bytes))
}

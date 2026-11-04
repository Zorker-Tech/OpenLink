/** Translation between Slate task records and the stored task wire message. */

import { TodoItem as InteropTodoItem, TodoStatus } from "../proto/generated/agent/v1/todo_tool_pb.ts";
import {
  fromRedactedTodoItem,
  toRedactedTodoItem,
} from "../redacted-protos/generated/agent/v1/todo_tool_redacted.ts";
import type { Context } from "../../../packages/context/context.ts";
import { PrivacyCapability } from "../../../packages/redaction/classification.ts";
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";
import type { SlateTodoItem, SlateTodoStatus } from "../../../packages/agent/tools/core/todo/contracts.ts";

export type RedactedInteropTodoItem = Parameters<typeof fromRedactedTodoItem>[0];
export type StoredTodoReference = {
  get(ctx: Context): Promise<RedactedInteropTodoItem>;
};

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

export function fromInteropTodoItem(item: InteropTodoItem): SlateTodoItem {
  return {
    id: item.id,
    content: item.content,
    status: fromInteropTodoStatus(item.status),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.dependencies.length === 0 ? {} : { dependencies: [...item.dependencies] }),
  };
}

export function toInteropTodoItem(item: SlateTodoItem): InteropTodoItem {
  return new InteropTodoItem({
    id: item.id,
    content: item.content,
    status: toInteropTodoStatus(item.status),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.dependencies === undefined ? {} : { dependencies: [...item.dependencies] }),
  });
}

export function fromRedactedInteropTodoItem(item: RedactedInteropTodoItem): SlateTodoItem {
  return fromInteropTodoItem(
    fromRedactedTodoItem(item, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
  );
}

export function toRedactedInteropTodoItem(item: SlateTodoItem, privacyMode: PrivacyMode): unknown {
  return toRedactedTodoItem(toInteropTodoItem(item), privacyMode);
}

export function readStoredTodos(
  ctx: Context,
  references: readonly StoredTodoReference[],
): Promise<readonly SlateTodoItem[]> {
  return Promise.all(references.map(async reference =>
    fromRedactedInteropTodoItem(await reference.get(ctx))
  ));
}

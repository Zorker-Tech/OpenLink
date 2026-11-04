/**
 * Slate's task-list values and policies, kept independent of the storage and inference wire formats.
 *
 * The model writes JSON incrementally, so the parser emits a snapshot whenever a complete top-level
 * item arrives. The interop adapter turns these snapshots into the message shape expected by the runner.
 */

import { JSONParser } from "@streamparser/json";
import { z } from "zod";

import type {
  EditableTodoStatus,
  RawSlateTodo,
  SlateTodoInteractionHandler,
  SlateTodoItem,
  SlateTodoToolCall,
  SlateTodoStatus,
} from "./contracts.ts";
import { lenientEnum } from "../../lenient-scalars.ts";

const todoStatusSchema = lenientEnum(z.enum(["pending", "in_progress", "completed", "cancelled"]));
const todoItemSchema = z.object({
  id: z.string(),
  content: z.string().optional(),
  status: todoStatusSchema,
});

export function stringToTodoStatus(status: EditableTodoStatus): EditableTodoStatus {
  return status;
}

export function todoStatusFromString(value: unknown): SlateTodoStatus | undefined {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "unspecified"
  ) {
    return value;
  }
  return undefined;
}

export function todoStatusToString(status: SlateTodoStatus): string {
  return status;
}

export function formatTodosForSummarization(todoItems: readonly SlateTodoItem[]): string | undefined {
  if (todoItems.length === 0) return undefined;
  return todoItems.map(todo => {
    const status = todoStatusToString(todo.status).toUpperCase();
    return "- **" + status + "**: " + todo.content + " (id: " + todo.id + ")";
  }).join("\n");
}

/** An update keeps its existing text, creation time, and dependencies when the model omits them. */
export function createTodoItem(
  rawTodo: RawSlateTodo,
  existingTodo?: SlateTodoItem,
  now = BigInt(Date.now()),
): SlateTodoItem {
  const legacyStatusCode = existingTodo?.status === rawTodo.status
    ? existingTodo.compatibility?.legacyStatusCode
    : undefined
  const legacyUnknownFields = existingTodo?.compatibility?.legacyUnknownFields
  const compatibility = legacyStatusCode === undefined && legacyUnknownFields === undefined
    ? undefined
    : {
        ...(legacyStatusCode === undefined ? {} : { legacyStatusCode }),
        ...(legacyUnknownFields === undefined
          ? {}
          : { legacyUnknownFields: legacyUnknownFields.map(field => ({ ...field, path: field.path.map(step => ({ ...step })) })) }),
      }
  return {
    id: rawTodo.id,
    content: rawTodo.content || existingTodo?.content || "",
    status: stringToTodoStatus(rawTodo.status),
    createdAt: existingTodo?.createdAt ?? now,
    updatedAt: now,
    ...(existingTodo?.dependencies === undefined ? {} : { dependencies: existingTodo.dependencies }),
    ...(compatibility === undefined ? {} : { compatibility }),
  };
}

export function createStreamingTodoParser(
  ctx: Parameters<SlateTodoInteractionHandler["emitPartialToolCall"]>[0],
  interactionHandler: Pick<SlateTodoInteractionHandler, "emitPartialToolCall">,
  meta: { readonly toolCallId: string },
  existingTodosMap: ReadonlyMap<string, SlateTodoItem>,
): { parser: JSONParser; streamedTodos: RawSlateTodo[] } {
  const parser = new JSONParser({ emitPartialTokens: true });
  const streamedTodos: RawSlateTodo[] = [];
  // Read the parser's callback type rather than duplicating its third-party event shape.
  type ParsedValue = Parameters<typeof parser.onValue>[0];
  parser.onValue = ({ value, key, stack }: ParsedValue) => {
    if (
      (stack?.length ?? 0) === 2 &&
      typeof key === "number" &&
      value !== null &&
      typeof value === "object" &&
      "id" in value &&
      "status" in value
    ) {
      const todoItem = todoItemSchema.parse(value);
      streamedTodos.push(todoItem);
      const partialTodos = streamedTodos.map(todo => createTodoItem(todo, existingTodosMap.get(todo.id)));
      const partialCall: SlateTodoToolCall = { args: { todos: partialTodos } };
      interactionHandler.emitPartialToolCall(ctx, meta.toolCallId, partialCall);
    }
  };
  return { parser, streamedTodos };
}

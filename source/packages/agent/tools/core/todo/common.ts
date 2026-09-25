/**
 * The todo list: how it is written, read back, and shown while it is being written.
 *
 * A todo list is the model's own plan, and it is stored as protobuf so it survives a restore. Three
 * conversions live here: a status between its wire value and its word, a raw item from the model into a
 * stored one — keeping the content and creation time it already had when the model omits them — and the
 * list into the text a summary shows.
 *
 * The streaming parser is the interesting part: the model writes the list as JSON, and the user should
 * see items appear as they are written rather than at the end. So the argument stream is parsed
 * incrementally, and each complete item is turned into a partial tool call that shows the list so far.
 * An item is complete when it sits at the top level of the list and has the two fields that make it one,
 * which is what keeps a half-written item from being shown as a finished one.
 */

import { JSONParser } from "@streamparser/json"
import { z } from "zod"

import { PrivacyCapability } from "../../../../redaction/classification.ts"
import { fromRedactedTodoItem } from "../../../../redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { ToolCall } from "../../../../proto/generated/agent/v1/agent_pb.ts"
import {
  TodoItem,
  TodoStatus,
  UpdateTodosArgs,
  UpdateTodosToolCall,
} from "../../../../proto/generated/agent/v1/todo_tool_pb.ts"
import { lenientEnum } from "../../lenient-scalars.ts"

const todoStatusSchema = lenientEnum(z.enum(["pending", "in_progress", "completed", "cancelled"]))
const todoItemSchema = z.object({
  id: z.string(),
  content: z.string().optional(),
  status: todoStatusSchema,
})

type RawTodo = z.infer<typeof todoItemSchema>
type RedactedTodoItem = Parameters<typeof fromRedactedTodoItem>[0]
const unwrapTodoItem = fromRedactedTodoItem as (todo: RedactedTodoItem, purpose: PrivacyCapability) => TodoItem

export function stringToTodoStatus(status: RawTodo["status"]): TodoStatus {
  switch (status) {
    case "pending":
      return TodoStatus.PENDING
    case "in_progress":
      return TodoStatus.IN_PROGRESS
    case "completed":
      return TodoStatus.COMPLETED
    case "cancelled":
      return TodoStatus.CANCELLED
    default: {
      const exhaustive: never = status
      return TodoStatus.UNSPECIFIED
    }
  }
}

export function todoStatusToString(status: TodoStatus): string {
  switch (status) {
    case TodoStatus.PENDING:
      return "pending"
    case TodoStatus.IN_PROGRESS:
      return "in_progress"
    case TodoStatus.COMPLETED:
      return "completed"
    case TodoStatus.CANCELLED:
      return "cancelled"
    default:
      return "unspecified"
  }
}

export function formatTodosForSummarization(todoItems: readonly RedactedTodoItem[]): string | undefined {
  if (todoItems.length === 0) return undefined
  return todoItems.map(todo => {
    const unwrapped = unwrapTodoItem(todo, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    const statusStr = todoStatusToString(unwrapped.status).toUpperCase()
    return `- **${statusStr}**: ${unwrapped.content} (id: ${unwrapped.id})`
  }).join("\n")
}

/** An item the model sent keeps what it did not restate: its content and when it was created. */
export function createTodoItem(rawTodo: RawTodo, existingTodo?: TodoItem): TodoItem {
  return new TodoItem({
    id: rawTodo.id,
    content: rawTodo.content || existingTodo?.content || "",
    status: stringToTodoStatus(rawTodo.status),
    createdAt: existingTodo?.createdAt || BigInt(Date.now()),
    updatedAt: BigInt(Date.now()),
  })
}

export function createUpdateTodosToolCall(updateTodosTool: UpdateTodosToolCall): ToolCall {
  return new ToolCall({ tool: { case: "updateTodosToolCall", value: updateTodosTool } })
}

export function createStreamingTodoParser(
  ctx: unknown,
  interactionHandler: {
    emitPartialToolCall(ctx: unknown, toolCallId: string, toolCall: ToolCall): unknown
  },
  meta: { readonly toolCallId: string },
  existingTodosMap: ReadonlyMap<string, TodoItem>,
): { parser: JSONParser; streamedTodos: RawTodo[] } {
  const parser = new JSONParser({ emitPartialTokens: true })
  const streamedTodos: RawTodo[] = []
  // The parser reports the element and where it sits; the types are its own, which is why they are read
  // off the callback rather than restated here.
  type ParsedValue = Parameters<typeof parser.onValue>[0]
  parser.onValue = ({ value, key, stack }: ParsedValue) => {
    if (
      (stack?.length ?? 0) === 2 &&
      typeof key === "number" &&
      value &&
      typeof value === "object" &&
      "id" in value &&
      "status" in value
    ) {
      const todoItem = todoItemSchema.parse(value)
      streamedTodos.push(todoItem)
      const partialTodos = streamedTodos.map(todo => createTodoItem(todo, existingTodosMap.get(todo.id)))
      interactionHandler.emitPartialToolCall(
        ctx,
        meta.toolCallId,
        createUpdateTodosToolCall(new UpdateTodosToolCall({ args: new UpdateTodosArgs({ todos: partialTodos }) })),
      )
    }
  }
  return { parser, streamedTodos }
}

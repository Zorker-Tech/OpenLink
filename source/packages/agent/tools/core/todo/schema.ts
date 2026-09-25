/**
 * The todo tool's schema, per prompt version.
 *
 * The schema the model is shown is not one schema: a model trained against a particular prompt version
 * was taught a particular shape — the fields in a particular order, a description it recognizes, and in
 * one case a merged list that is returned as JSON rather than as text. Sending the wrong shape costs the
 * model the call, so each version is described separately rather than approximated.
 *
 * Parsing is stricter than describing. The model's own output is read with a discriminated schema that
 * requires the merge flag and reads the list leniently, because a model that omits the flag means to
 * merge — it is updating a list it can already see — and one that sends the list as text is still
 * sending a list.
 *
 * The success message is where the list comes back to the model, and it is where the two reminders live:
 * a list with nothing in progress is a list that will go stale, and a list with many finished items is a
 * list worth tidying.
 */

import { z } from "zod"

import { TodoStatus, type UpdateTodosSuccess } from "../../../../proto/generated/agent/v1/todo_tool_pb.ts"
import { lenientArray } from "../../lenient-array.ts"
import { preprocessLenientBoolean } from "../../lenient-scalars.ts"
import { lenientEnum } from "../../lenient-scalars.ts"
import { todoStatusToString } from "./common.ts"

const todoStatusSchema = lenientEnum(z.enum(["pending", "in_progress", "completed", "cancelled"]))

/** The earliest shape: the content is optional, because a merge may update only the status. */
const todoItemSchemaWithOptionalContent = z.object({
  content: z.string().optional().describe("The description/content of the todo item"),
  status: todoStatusSchema.describe("The current status of the todo item"),
  id: z.string().describe("Unique identifier for the todo item"),
})

const todoItemSchema = z.object({
  id: z.string().describe("Unique identifier for the TODO item"),
  content: z.string().describe("The description/content of the todo item"),
  status: todoStatusSchema.describe("The current status of the todo item"),
})

const todoItemSchemaUppercaseLabels = z.object({
  id: z.string().describe("Unique identifier for the TODO item"),
  content: z.string().describe("The description/content of the TODO item"),
  status: todoStatusSchema.describe("The current status of the TODO item"),
})

export interface TodoModelSchemaOptions {
  readonly mergeTodosFirst?: boolean
  readonly minTodos?: number
}

/** The schema the model is shown for a given prompt version. The versions are catalogue values. */
export function createSchemaTowardsModel(version: string, options?: TodoModelSchemaOptions) {
  if (version === "dsv3-1018") {
    return z.object({
      merge: z.boolean().describe("Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos."),
      todos: z.array(todoItemSchemaWithOptionalContent).describe("Array of todo items to write to the workspace"),
    })
  }
  if (version === "dsv3-1205") {
    return z.object({
      todos: z.array(todoItemSchemaUppercaseLabels).describe("Array of TODO items to update or create"),
      merge: z.boolean().describe("Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos."),
    })
  }
  if (version === "cursor-0226") {
    const todosField = z.array(todoItemSchemaUppercaseLabels).describe("Array of TODO items to update or create")
    return z.object({
      todos: options?.minTodos ? todosField.min(options.minTodos) : todosField,
      merge: z.boolean().describe("Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos."),
    })
  }
  const todosField = z.array(todoItemSchema).describe("Array of TODO items to update or create")
  const todosFieldWithMin = options?.minTodos ? todosField.min(options.minTodos) : todosField
  const mergeField = z.boolean().describe("Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos.")
  // Field order is part of what a model was trained on, so the caller may choose which comes first.
  return options?.mergeTodosFirst
    ? z.object({ merge: mergeField, todos: todosFieldWithMin })
    : z.object({ todos: todosFieldWithMin, merge: mergeField })
}

const todoItemCreateSchemaForParsing = z.object({
  id: z.string().describe("Unique identifier for the TODO item"),
  content: z.string().describe("The description/content of the TODO item"),
  status: todoStatusSchema.describe("The current status of the TODO item"),
})

const todoItemUpdateSchemaForParsing = z.object({
  id: z.string().describe("Unique identifier for the TODO item"),
  content: z.string().optional().describe("The description/content of the TODO item"),
  status: todoStatusSchema.describe("The current status of the TODO item"),
})

/** A merge may leave a content out; a replacement may not, since nothing is being kept. */
const strictTodoToolSchemaForParsing = z.discriminatedUnion("merge", [
  z.object({
    merge: z.literal(true),
    todos: lenientArray(z.array(todoItemUpdateSchemaForParsing).describe("Array of TODO items to update"), { field: "todos" }),
  }),
  z.object({
    merge: z.literal(false),
    todos: lenientArray(
      z.array(todoItemCreateSchemaForParsing).describe("Array of TODO items to overwrite the existing TODO list with"),
      { field: "todos" },
    ),
  }),
])

function preprocessTodoMerge(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  // A model that did not say means to merge: it is updating the list it can already see.
  if (!("merge" in value) || !Object.hasOwn(value, "merge")) return { ...value, merge: true }
  const merge = preprocessLenientBoolean(value.merge)
  return merge === value.merge ? value : { ...value, merge }
}

export const todoToolSchemaForParsing = z.preprocess(preprocessTodoMerge, strictTodoToolSchemaForParsing)

const FINISHED_TODO_CLEANUP_REMINDER = "You have many finished todos. Consider cleaning up old ones."
const FINISHED_TODO_CLEANUP_REMINDER_THRESHOLD = 20

export function renderUpdateTodosSuccessMessage(
  success: Pick<UpdateTodosSuccess, "todos" | "wasMerge">,
  promptVersion: string,
): string {
  let message = "Successfully updated TODOs. Make sure to follow and update your TODO list as you make progress. Cancel and add new TODO tasks as needed when the user makes a correction or follow-up request."
  if (
    success.todos.some(todo => todo.status === TodoStatus.PENDING) &&
    success.todos.every(todo => todo.status !== TodoStatus.IN_PROGRESS)
  ) {
    message += " No TODOs are marked in-progress, make sure to mark them before starting the next."
  }
  let finishedTodoCount = 0
  for (const todo of success.todos) {
    if (todo.status !== TodoStatus.COMPLETED && todo.status !== TodoStatus.CANCELLED) continue
    finishedTodoCount++
    if (finishedTodoCount > FINISHED_TODO_CLEANUP_REMINDER_THRESHOLD) {
      message += `\n\n<system_reminder>${FINISHED_TODO_CLEANUP_REMINDER}</system_reminder>`
      break
    }
  }
  // One prompt version reads its list back as JSON; every other reads it as lines.
  if (promptVersion === "dsv3-1018") {
    const wasMerge = success.wasMerge ?? true
    if (wasMerge) {
      message += "\n\nHere are the latest contents of your todo list:"
      message += `\n${JSON.stringify(success.todos.map(todo => ({
        id: todo.id,
        content: todo.content,
        status: todoStatusToString(todo.status),
      })))}`
    }
  } else {
    message += `\n\nHere are the latest contents of your todo list:\n${success.todos.map(todo => `- **${todoStatusToString(todo.status).toUpperCase()}**: ${todo.content} (id: ${todo.id})`).join("\n")}`
  }
  return message
}

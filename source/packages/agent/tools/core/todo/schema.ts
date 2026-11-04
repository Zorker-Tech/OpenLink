/**
 * The task-list input schema shown to a model and the parser for its streamed response.
 *
 * The profile supplies only shape choices needed by existing inference integrations. Task names,
 * status vocabulary, and update semantics are Slate-owned. Parsing remains permissive about a missing
 * merge flag (it means merge) and accepts a quoted JSON list from providers that wrap array arguments.
 */

import { z } from "zod";

import type { SlateTodoResult, TodoPromptProfile } from "./contracts.ts";
import { todoStatusToString } from "./common.ts";
import { lenientArray } from "../../lenient-array.ts";
import { lenientEnum, preprocessLenientBoolean } from "../../lenient-scalars.ts";

const todoStatusSchema = lenientEnum(z.enum(["pending", "in_progress", "completed", "cancelled"]));
const mergeDescription =
  "When true, add or update the listed tasks and keep tasks not mentioned. When false, replace the current list with the listed tasks.";

/** Build the model-facing schema from a Slate profile, without exposing a provider version key. */
export function createSchemaTowardsModel(profile: TodoPromptProfile) {
  const label = profile.contentOptionalInPrompt ? "task" : "task";
  const todosDescription = "Tasks to add or update in the current session.";
  const todoFields = profile.contentOptionalInPrompt
    ? {
        content: z.string().optional().describe("Short task description; omit it to keep existing text."),
        status: todoStatusSchema.describe("Current task status."),
        id: z.string().describe("Stable identifier for the task."),
      }
    : {
        id: z.string().describe("Stable identifier for the " + label + "."),
        content: z.string().describe("Short description of the " + label + "."),
        status: todoStatusSchema.describe("Current status of the " + label + "."),
      };
  const todosField = z.array(z.object(todoFields)).describe(todosDescription);
  const todosWithMinimum = profile.minimumTodoCount === undefined
    ? todosField
    : todosField.min(profile.minimumTodoCount);
  const mergeField = z.boolean().describe(mergeDescription);
  return profile.mergeFirst
    ? z.object({ merge: mergeField, todos: todosWithMinimum })
    : z.object({ todos: todosWithMinimum, merge: mergeField });
}

const todoItemCreateSchemaForParsing = z.object({
  id: z.string().describe("Stable identifier for the task."),
  content: z.string().describe("Short description of the task."),
  status: todoStatusSchema.describe("Current task status."),
});

const todoItemUpdateSchemaForParsing = z.object({
  id: z.string().describe("Stable identifier for the task."),
  content: z.string().optional().describe("Short description; omit it to preserve existing text."),
  status: todoStatusSchema.describe("Current task status."),
});

/** A replacement must describe every task; a merge may update status alone. */
const strictTodoToolSchemaForParsing = z.discriminatedUnion("merge", [
  z.object({
    merge: z.literal(true),
    todos: lenientArray(z.array(todoItemUpdateSchemaForParsing).describe("Tasks to update."), { field: "todos" }),
  }),
  z.object({
    merge: z.literal(false),
    todos: lenientArray(
      z.array(todoItemCreateSchemaForParsing).describe("The complete replacement task list."),
      { field: "todos" },
    ),
  }),
]);

function preprocessTodoMerge(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  // A missing flag on a status update means keep the rest of the list.
  if (!("merge" in value) || !Object.hasOwn(value, "merge")) return { ...value, merge: true };
  const merge = preprocessLenientBoolean(value.merge);
  return merge === value.merge ? value : { ...value, merge };
}

export const todoToolSchemaForParsing = z.preprocess(preprocessTodoMerge, strictTodoToolSchemaForParsing);

const FINISHED_TODO_CLEANUP_REMINDER = "Many tasks are finished; consider removing old entries.";
const FINISHED_TODO_CLEANUP_REMINDER_THRESHOLD = 20;

export function renderUpdateTodosSuccessMessage(
  success: Extract<SlateTodoResult, { readonly kind: "success" }>,
  profile: TodoPromptProfile,
): string {
  let message = "Task list updated. Keep it current as work progresses; cancel outdated tasks and add new ones when the request changes.";
  if (
    success.todos.some(todo => todo.status === "pending") &&
    success.todos.every(todo => todo.status !== "in_progress")
  ) {
    message += " No task is marked in progress; update a task before starting it.";
  }
  let finishedTodoCount = 0;
  for (const todo of success.todos) {
    if (todo.status !== "completed" && todo.status !== "cancelled") continue;
    finishedTodoCount++;
    if (finishedTodoCount > FINISHED_TODO_CLEANUP_REMINDER_THRESHOLD) {
      message += "\n\n<system_reminder>" + FINISHED_TODO_CLEANUP_REMINDER + "</system_reminder>";
      break;
    }
  }
  if (profile.successDisplay === "json-on-merge") {
    if (success.wasMerge) {
      const items = success.todos.map(todo => ({
        id: todo.id,
        content: todo.content,
        status: todoStatusToString(todo.status),
      }));
      message += "\n\nCurrent task list:\n" + JSON.stringify(items);
    }
  } else {
    const lines = success.todos.map(todo =>
      "- **" + todoStatusToString(todo.status).toUpperCase() + "**: " + todo.content + " (id: " + todo.id + ")"
    ).join("\n");
    message += "\n\nCurrent task list:\n" + lines;
  }
  return message;
}

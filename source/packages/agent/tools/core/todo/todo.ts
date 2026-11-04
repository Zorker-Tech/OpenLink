/**
 * The task-list tool policy.
 *
 * Slate owns how task updates merge, how content and creation times survive edits, how streamed items are
 * shown, and when the plan file is synchronized. Persistence, runner messages, and provider-specific names
 * are supplied through ports and adapters.
 */

import { z } from "zod";

import type { Context } from "../../../../context/context.ts";
import { createSpan } from "../../../../context/telemetry.ts";
import { ToolCallArgParseError, createZodAgentTool } from "../../tool-support.ts";
import { createStringResult } from "../../../../chat-inference/prompt-executor.ts";
import {
  createTodoItem,
  createStreamingTodoParser,
} from "./common.ts";
import type {
  SlateTodoInteractionHandler,
  SlateTodoInput,
  SlateTodoItem,
  SlateTodoResult,
  SlateTodoStatePort,
  SlateTodoToolCall,
  TodoPromptProfile,
} from "./contracts.ts";
import { createSchemaTowardsModel, renderUpdateTodosSuccessMessage, todoToolSchemaForParsing } from "./schema.ts";

export function createSlateUpdateTodosTool(
  state: SlateTodoStatePort,
  profile: TodoPromptProfile,
): ReturnType<typeof createZodAgentTool> {
  const executeCore = async (
    ctx: Context,
    rawArgs: z.infer<typeof todoToolSchemaForParsing>,
    meta: { readonly toolCallId: string },
  ): Promise<SlateTodoResult> => {
    const existingTodos = await state.readTodos(ctx);
    const existingById = new Map(existingTodos.map(todo => [todo.id, todo]));
    const nextById = new Map(existingById);
    const merge = rawArgs.merge ?? true;

    if (!merge) nextById.clear();
    const updatedTodos: SlateTodoItem[] = [];
    for (const rawTodo of rawArgs.todos) {
      const existing = existingById.get(rawTodo.id);
      const todo = createTodoItem(rawTodo, existing);
      if (merge && (existing === undefined || existing.content.length === 0) && todo.content.length === 0) {
        throw new ToolCallArgParseError("Invalid argument: must provide 'content' for new todos items");
      }
      nextById.set(todo.id, todo);
      updatedTodos.push(todo);
    }

    const writtenTodos = Array.from(nextById.values());
    await state.writeTodos(writtenTodos);
    await state.syncPlanTodos(ctx, meta.toolCallId);

    // A merge response is the list after persistence; replacement is exactly the list just written.
    const resultTodos = merge ? await state.readTodos(ctx) : updatedTodos;
    return {
      kind: "success",
      todos: resultTodos,
      totalCount: resultTodos.length,
      wasMerge: merge,
    };
  };

  const execute = async (
    parentCtx: Context,
    interactionHandler: SlateTodoInteractionHandler,
    argsStream: AsyncIterable<string>,
    meta: { readonly toolCallId: string },
  ): Promise<SlateTodoResult> => {
    using span = createSpan(parentCtx.withName("updateSlateTodos"));
    interactionHandler.emitPartialToolCall(span.ctx, meta.toolCallId, {});

    const existingTodos = await state.readTodos(parentCtx);
    const existingById = new Map(existingTodos.map(todo => [todo.id, todo]));
    const { parser } = createStreamingTodoParser(span.ctx, interactionHandler, meta, existingById);
    let args = "";
    try {
      for await (const chunk of argsStream) {
        args += chunk;
        parser.write(chunk);
      }
    } catch (error) {
      throw new ToolCallArgParseError(error instanceof Error ? error.message : String(error));
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(args);
    } catch (error) {
      throw new ToolCallArgParseError(error instanceof Error ? error.message : "Invalid JSON");
    }
    const parsedArgs = todoToolSchemaForParsing.safeParse(parsedJson);
    if (!parsedArgs.success) throw new ToolCallArgParseError("Invalid task list: " + parsedArgs.error.message);

    const input: SlateTodoInput = {
      todos: parsedArgs.data.todos,
      merge: parsedArgs.data.merge,
    };
    const parsedItems = input.todos.map(todo => createTodoItem(todo, existingById.get(todo.id)));
    const initialCall: SlateTodoToolCall = { args: { todos: parsedItems, merge: input.merge } };
    return interactionHandler.executeToolCall(
      span.ctx,
      initialCall,
      meta.toolCallId,
      ctx => executeCore(ctx, parsedArgs.data, meta),
      result => ({ ...initialCall, result }),
    );
  };

  const render = async (_ctx: Context, result: SlateTodoResult): Promise<ReturnType<typeof createStringResult>> => {
    switch (result.kind) {
      case "success":
        return createStringResult(renderUpdateTodosSuccessMessage(result, profile));
      case "error":
        return createStringResult(result.error);
      case "unknown":
        return createStringResult("No task update result was returned.");
    }
  };

  return createZodAgentTool("SLATE_TODO_UPDATE", {
    name: profile.toolName,
    contextType: { type: "dynamic", conciseStaticContext: "Use this tool to keep a multi-step task list current." },
    descriptionGenerator: () => profile.description,
    parameters: createSchemaTowardsModel(profile),
    execute,
    render,
    serializeError: (error: unknown): SlateTodoToolCall => ({
      result: {
        kind: "error",
        error: error instanceof Error ? error.message : String(error),
      },
    }),
  });
}

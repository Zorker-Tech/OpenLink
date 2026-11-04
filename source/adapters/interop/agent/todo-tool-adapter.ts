/** Connects Slate's task-list policy to the persisted and runner-facing message formats. */

import {
  ToolCall as InteropToolCall,
} from "../proto/generated/agent/v1/agent_pb.ts";
import {
  UpdateTodosArgs,
  UpdateTodosError,
  UpdateTodosResult,
  UpdateTodosSuccess,
  UpdateTodosToolCall,
} from "../proto/generated/agent/v1/todo_tool_pb.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts";
import {
  syncLatestPlanTodosToFile,
  type PlanSyncStateHandler,
} from "../../../packages/agent/tools/core/create-plan/backend-plan-utils.ts";
import { createSlateUpdateTodosTool } from "../../../packages/agent/tools/core/todo/todo.ts";
import type {
  SlateTodoInteractionHandler,
  SlateTodoItem,
  SlateTodoResult,
  SlateTodoToolCall,
  TodoPromptProfile,
} from "../../../packages/agent/tools/core/todo/contracts.ts";
import {
  fromInteropTodoItem,
  readStoredTodos,
  toInteropTodoItem,
  toRedactedInteropTodoItem,
} from "./todo-schema-adapter.ts";
import type { StoredTodoReference } from "./todo-schema-adapter.ts";
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";

export interface UpdateTodosResourceAccessor extends ResourceAccessor<RemoteExecManager> {}

export interface UpdateTodosStateHandler extends PlanSyncStateHandler {
  readonly todos: readonly StoredTodoReference[];
  getPrivacyMode(): PrivacyMode;
  setTodos(todos: readonly unknown[]): void;
}

interface InteropTodoInteractionHandler {
  emitPartialToolCall(ctx: Context, toolCallId: string, toolCall: InteropToolCall): void;
  executeToolCall(
    ctx: Context,
    toolCall: InteropToolCall,
    toolCallId: string,
    run: (ctx: Context) => Promise<UpdateTodosResult>,
    merge: (result: UpdateTodosResult) => InteropToolCall,
  ): Promise<UpdateTodosResult>;
}

function promptProfileForVersion(promptVersion: string): TodoPromptProfile {
  const normalDescription =
    "Maintain this session's task list. Give each task a stable id, a concise description, and its current status.";
  const guidedDescription =
    "Track the work in the session task list. Keep task ids stable, update statuses as work changes, and remove entries that are no longer relevant.";
  const parallelDescription =
    "Maintain the session task list by stable task id. Mark independent work active while it runs, then complete it when its result is delivered or cancel it when it is no longer needed.";

  switch (promptVersion) {
    case "dsv3-1018":
      return {
        toolName: "todo_write",
        description: guidedDescription,
        mergeFirst: true,
        contentOptionalInPrompt: true,
        successDisplay: "json-on-merge",
      };
    case "dsv3-1205":
      return {
        toolName: "TodoWrite",
        description: guidedDescription,
        mergeFirst: false,
        contentOptionalInPrompt: false,
        successDisplay: "text",
      };
    case "cursor-0226":
      return {
        toolName: "TodoWrite",
        description: normalDescription,
        mergeFirst: false,
        minimumTodoCount: 2,
        contentOptionalInPrompt: false,
        successDisplay: "text",
      };
    case "gpt5-codex":
    case "codex-cloud":
      return {
        toolName: "TodoWrite",
        description: parallelDescription,
        mergeFirst: true,
        minimumTodoCount: 2,
        contentOptionalInPrompt: false,
        successDisplay: "text",
      };
    case "latest":
    case "haiku":
      return {
        toolName: "TodoWrite",
        description: normalDescription,
        mergeFirst: false,
        minimumTodoCount: 2,
        contentOptionalInPrompt: false,
        successDisplay: "text",
      };
    default:
      throw new Error("Unhandled version: " + promptVersion);
  }
}

function toInteropTodoResult(result: SlateTodoResult): UpdateTodosResult {
  switch (result.kind) {
    case "success":
      return new UpdateTodosResult({
        result: {
          case: "success",
          value: new UpdateTodosSuccess({
            todos: result.todos.map(toInteropTodoItem),
            totalCount: result.totalCount,
            wasMerge: result.wasMerge,
          }),
        },
      });
    case "error":
      return new UpdateTodosResult({
        result: { case: "error", value: new UpdateTodosError({ error: result.error }) },
      });
    case "unknown":
      return new UpdateTodosResult();
  }
}

function fromInteropTodoResult(result: UpdateTodosResult | undefined): SlateTodoResult {
  switch (result?.result?.case) {
    case "success": {
      const success = result.result.value;
      return {
        kind: "success",
        todos: success.todos.map(fromInteropTodoItem),
        totalCount: success.totalCount,
        wasMerge: success.wasMerge,
      };
    }
    case "error":
      return { kind: "error", error: result.result.value.error };
    case undefined:
      return { kind: "unknown" };
  }
}

function toInteropTodoCall(call: SlateTodoToolCall): InteropToolCall {
  const updateCall = new UpdateTodosToolCall({
    ...(call.args === undefined
      ? {}
      : {
          args: new UpdateTodosArgs({
            todos: call.args.todos?.map(toInteropTodoItem) ?? [],
            ...(call.args.merge === undefined ? {} : { merge: call.args.merge }),
          }),
        }),
    ...(call.result === undefined ? {} : { result: toInteropTodoResult(call.result) }),
  });
  return new InteropToolCall({ tool: { case: "updateTodosToolCall", value: updateCall } });
}

function interopInteractionHandler(handler: InteropTodoInteractionHandler): SlateTodoInteractionHandler {
  return {
    emitPartialToolCall(ctx, toolCallId, call) {
      handler.emitPartialToolCall(ctx, toolCallId, toInteropTodoCall(call));
    },
    async executeToolCall(ctx, call, toolCallId, run, merge) {
      const result = await handler.executeToolCall(
        ctx,
        toInteropTodoCall(call),
        toolCallId,
        async runContext => toInteropTodoResult(await run(runContext)),
        interopResult => toInteropTodoCall(merge(fromInteropTodoResult(interopResult))),
      );
      return fromInteropTodoResult(result);
    },
  };
}

/** Exposes the legacy runner tool surface while keeping its task policy Slate-owned. */
export function createUpdateTodosTool(
  resourceAccessor: UpdateTodosResourceAccessor,
  stateHandler: UpdateTodosStateHandler,
  promptVersion = "latest",
): ReturnType<typeof createSlateUpdateTodosTool> {
  const state = {
    async readTodos(ctx: Context) {
      return await readStoredTodos(ctx, stateHandler.todos);
    },
    writeTodos(todos: readonly SlateTodoItem[]) {
      stateHandler.setTodos(todos.map(todo => toRedactedInteropTodoItem(todo, stateHandler.getPrivacyMode())));
    },
    async syncPlanTodos(ctx: Context, toolCallId: string) {
      const todos = await readStoredTodos(ctx, stateHandler.todos);
      await syncLatestPlanTodosToFile({ ctx, resourceAccessor, stateHandler, todos, toolCallId });
    },
  };
  const slateTool = createSlateUpdateTodosTool(state, promptProfileForVersion(promptVersion));
  const execute = slateTool.execute as (
    ctx: Context,
    handler: SlateTodoInteractionHandler,
    args: AsyncIterable<string>,
    meta: { readonly toolCallId: string },
  ) => Promise<SlateTodoResult>;
  const render = slateTool.render as (
    ctx: Context,
    result: SlateTodoResult,
    props?: unknown,
  ) => unknown;
  const serializeError = slateTool.serializeError as (error: unknown) => SlateTodoToolCall;
  return {
    ...slateTool,
    async execute(ctx: Context, handler: InteropTodoInteractionHandler, args: AsyncIterable<string>, meta: { readonly toolCallId: string }) {
      return toInteropTodoResult(await execute(ctx, interopInteractionHandler(handler), args, meta));
    },
    render(ctx: Context, result: UpdateTodosResult, props?: unknown) {
      return render(ctx, fromInteropTodoResult(result), props);
    },
    serializeError(error: unknown) {
      return toInteropTodoCall(serializeError(error));
    },
  };
}

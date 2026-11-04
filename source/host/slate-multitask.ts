/** Slate-owned policy and tool descriptions for parallel work. */

import {
  createUpdateTodosTool,
  type UpdateTodosResourceAccessor,
  type UpdateTodosStateHandler,
} from "../adapters/interop/agent/todo-tool-adapter.ts"
import {
  SLATE_EXECUTOR_SUBAGENT_DESCRIPTION,
  SLATE_MULTITASK_PROMPT_SECTION,
  SLATE_MULTITASK_TODO_DESCRIPTION,
} from "./slate-multitask-guidance.ts"

export const EXECUTOR_SUBAGENT_TYPE = "executor"
export { SLATE_MULTITASK_PROMPT_SECTION }

export interface SlateExecutorSubagentDefinition {
  readonly typeName: string
  readonly description: string
  readonly preserveTaskTool: false
  readonly subagentSource: "builtin"
}

export function resolveMultitaskEnabled(
  envOverride: string | undefined,
  checkFeatureGate: () => boolean,
): boolean {
  if (envOverride !== undefined && envOverride.length > 0) {
    return envOverride !== "0" && envOverride.toLowerCase() !== "false"
  }
  return checkFeatureGate()
}

export function createSlateExecutorSubagentDefinition(): SlateExecutorSubagentDefinition {
  return {
    typeName: EXECUTOR_SUBAGENT_TYPE,
    description: SLATE_EXECUTOR_SUBAGENT_DESCRIPTION,
    preserveTaskTool: false,
    subagentSource: "builtin",
  }
}

export function createSlateMultitaskTodoTool(
  resourceAccessor: UpdateTodosResourceAccessor,
  stateHandler: UpdateTodosStateHandler,
): ReturnType<typeof createUpdateTodosTool> & { descriptionGenerator: () => string } {
  return {
    ...createUpdateTodosTool(resourceAccessor, stateHandler),
    descriptionGenerator: () => SLATE_MULTITASK_TODO_DESCRIPTION,
  }
}

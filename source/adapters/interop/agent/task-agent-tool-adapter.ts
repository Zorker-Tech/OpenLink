/** Binds Slate's task tool definition to the current AgentRoot tool result boundary. */

import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/tool-support.ts"
import type { SlateTaskToolDefinition } from "../../../packages/agent/tools/task.ts"
import {
  createTaskToolCallInterop,
  fromInteropTaskResultInterop,
  serializeTaskErrorInterop,
  toInteropTaskResultInterop,
  type TaskResultInterop,
} from "./task-tool-protocol-adapter.ts"

/** The core produces Slate results; this adapter serializes and reads them at the current runner boundary. */
export function createTaskAgentToolInterop(task: SlateTaskToolDefinition): Record<string, unknown> {
  return createZodAgentTool("TASK", {
    name: task.name,
    descriptionGenerator: task.descriptionGenerator,
    parameters: task.schemaTowardsModel,
    prepareSubagent: task.prepareSubagent,
    execute: withSafeParsedArgs(
      task.schemaForParsing,
      async (ctx, interactionHandler, args, meta) => {
        return toInteropTaskResultInterop(await task.execute(ctx, interactionHandler, args, meta))
      },
      createTaskToolCallInterop(),
    ),
    render: async (ctx, result) => task.render(ctx, fromInteropTaskResultInterop(result as TaskResultInterop)),
    serializeError: serializeTaskErrorInterop,
  })
}

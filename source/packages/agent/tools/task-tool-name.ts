/**
 * What the tool that spawns a subagent is called, per model.
 *
 * The name is not a platform preference: it is what the model was trained to call, and a model asked to
 * use a tool it has never seen will not use it. One family reaches it through the MCP route instead, and
 * another was trained on a prompt version whose tool is named differently again.
 */

import { isCodexPromptVersion } from "./tool-support.ts"

export interface TaskToolModelInfo {
  readonly isComposer1?: boolean | undefined
  readonly isComposer15?: boolean | undefined
  readonly promptVersion: string
}

function legacyModelTaskTool(model: TaskToolModelInfo): string | undefined {
  return model.isComposer1 || model.isComposer15 ? "mcp_task" : undefined
}

function codexTaskTool(model: TaskToolModelInfo): string | undefined {
  return isCodexPromptVersion(model.promptVersion) ? "Subagent" : undefined
}

export function getTaskToolName(parentModelInfo: TaskToolModelInfo): string {
  return legacyModelTaskTool(parentModelInfo) ?? codexTaskTool(parentModelInfo) ?? "Task"
}

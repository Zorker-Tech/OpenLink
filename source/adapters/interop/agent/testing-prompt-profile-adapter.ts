/** Maps counterpart model and tool metadata to Slate's testing-instruction profile. */

export interface TestingPromptProfile {
  readonly preferFocusedChecks: boolean
  readonly requireExtendedValidation: boolean
  readonly deleteFileToolName: string
  readonly screenRecorderToolName?: string
}

export type SlateCloudTestingModelProfile = Readonly<Record<string, unknown>> & {
  readonly modelName?: string | undefined
  readonly usesShellLessCloudPrompt: boolean
}

const SHELL_LESS_CLOUD_PROMPT_VERSION = "cursor-0226"

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

function namedTool(toolInfo: unknown, identifier: string): string | undefined {
  const tools = recordOf(recordOf(toolInfo).allTools)
  const tool = recordOf(tools[identifier])
  return typeof tool.name === "string" && tool.name.length > 0 ? tool.name : undefined
}

export function adaptInteropTestingPromptProfile(modelInfo: unknown, toolInfo: unknown): TestingPromptProfile {
  const model = recordOf(modelInfo)
  const tools = recordOf(recordOf(toolInfo).allTools)
  const recorder = namedTool(toolInfo, "RECORD_SCREEN") ??
    Object.values(tools).map(tool => recordOf(tool).name).find(name => typeof name === "string" && /record.*screen|screen.*record/i.test(name))
  return {
    preferFocusedChecks: model.isCodexFamily === true,
    requireExtendedValidation: model.isOpus45 === true || model.isOpus46 === true,
    deleteFileToolName: namedTool(toolInfo, "DELETE") ?? "delete_file",
    ...(typeof recorder === "string" && recorder.length > 0 ? { screenRecorderToolName: recorder } : {}),
  }
}

/** Replace the remote prompt-version marker with a Slate-owned capability flag. */
export function adaptInteropCloudTestingModelProfile(modelInfo: unknown): SlateCloudTestingModelProfile | undefined {
  if (modelInfo === null || typeof modelInfo !== "object" || Array.isArray(modelInfo)) return undefined
  const source = modelInfo as Record<string, unknown>
  const { promptVersion, ...ownedFacts } = source
  return {
    ...ownedFacts,
    ...(typeof source.modelName === "string" ? { modelName: source.modelName } : {}),
    usesShellLessCloudPrompt: promptVersion === SHELL_LESS_CLOUD_PROMPT_VERSION,
  }
}

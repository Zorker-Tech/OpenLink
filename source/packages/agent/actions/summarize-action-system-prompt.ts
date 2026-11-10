import { FileOperationLockManager } from "../tools/core/file-operation-locks.ts"
import { toRedactedCoreMessages } from "../../redaction/message-redaction.ts"
import { getRequestContext } from "../utils/request-context.ts"
import { buildRequestContextOptions } from "./meta-agent-notes.ts"
import { SlateMode } from "../mode-processing.ts"
import type { RootPromptExecutor, SummarizeConfig, SummarizeStateHandler } from "./summarize-action-contracts.ts"
import type { Context } from "../../context/context.ts"

export async function addSummarySystemInstructions(options: {
  readonly context: Context
  readonly prompt: RootPromptExecutor
  readonly state: SummarizeStateHandler
  readonly config: SummarizeConfig
  readonly resourceAccessor: unknown
}): Promise<void> {
  if (options.prompt.getMessages().some((message) => message.role === "system")) return

  const requestContext = await getRequestContext(
    options.context,
    undefined,
    options.resourceAccessor as never,
    buildRequestContextOptions(options.config as any),
  )
  const mode = options.state.mode ?? SlateMode.AGENT
  const tools = options.config.toolsGenerator({
    resourceAccessor: options.resourceAccessor,
    stateHandler: options.state,
    agentSessionId: options.config.agentSessionId,
    mcpTools: [],
    repositoryInfos: requestContext.repositoryInfo,
    blobStore: options.state.getBlobStore(),
    mode,
    loggingContext: options.context,
    requestContext,
    fileOperationLockManager: new FileOperationLockManager(),
    smartModeClassifierMode: options.config.smartModeClassifierMode,
    smartModeClassifierShadowMode: options.config.smartModeClassifierShadowMode,
    autoRejectFirstAskQuestion: options.config.autoRejectFirstAskQuestion,
  })

  options.prompt.appendMessages(toRedactedCoreMessages([
    {
      role: "system",
      content: options.config.systemPromptGenerator({ rules: [], mode }, tools),
    },
  ], options.state.getPrivacyMode()))
}

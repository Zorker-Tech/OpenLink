/**
 * A shell command the user typed, run as if the agent had run it.
 *
 * Shell mode exists so the user can run a command without leaving the conversation, and what happens next
 * depends on the transcript looking like an ordinary turn: the command is written into the conversation as
 * a user message, the agent's own call to the shell tool as an assistant message, and the output as that
 * call's result. That is what lets the model reason about the command afterwards — it can see what was run
 * and what came back, and it can run a follow-up as if it had thought of it.
 *
 * The command is run through the same streaming executor the shell tool uses, so the sandbox policy, the
 * timeouts and the abort behaviour are the tool's rather than a second implementation's, and the output is
 * streamed to the interaction listener as it arrives so the user watches it live. A resumed turn passes the
 * exec id it is resuming, and in that case the updates are not re-sent: the user already saw them. A
 * command the user typed skips the approval prompt, because the user typing it is the approval — and the
 * classifier is not consulted at all, which is why the argument says so explicitly.
 *
 * The first command of a conversation also has to seed the transcript, since there is no turn before it to
 * carry the system prompt and the user-info message: the same prompt the agent would have been given is
 * built here, from the same generators, so a shell-first conversation is not a conversation with a
 * different set of instructions.
 */

import { randomUUID } from "node:crypto"
import { createLogger } from "../../context/index.ts"
import { toRedactedCoreMessages } from "../../redaction/message-redaction.ts"
import { projectBackgroundAgentSource } from "../../../adapters/interop/agent/background-agent-source-adapter.ts"
import {
  adaptShellCommandAction,
  buildShellActionUserInfoAgentNotesProps,
  renderShellActionUserInfo,
  toShellSystemPromptOptions,
} from "../../../adapters/interop/agent/shell-command-action-adapter.ts"
import { getBrowserToolNames } from "../browser-tools.ts"
import { getAllRules } from "./common.ts"
import { buildRequestContextOptions } from "./meta-agent-notes.ts"
import { adaptInteropCloudTestingModelProfile } from "../../../adapters/interop/agent/testing-prompt-profile-adapter.ts"
import { isProjectWorkspaceConversation } from "../configs/project-workspace-mcp-tools.ts"
import { getRequestContext } from "../utils/request-context.ts"
import { getCloudTestingSectionsPlacement } from "../prompts/cloud-testing-sections.ts"
import { extractToolInfo } from "../prompts/tool-info.ts"
import { withToolSetMcpSnapshot } from "../utils/mcp-meta-tool-options.ts"
import { getMcpMetaToolOptionsWithUserDefinedTools } from "../../../adapters/interop/agent/mcp-user-defined-tools-adapter.ts"
import { FileOperationLockManager } from "../tools/core/file-operation-locks.ts"
import type { SlateShellCommandActionPayload } from "./shell-command-action-contracts.ts"

type Any = any

const logger = createLogger("@slate/agent/actions/shell-command-action-handler")

export class ShellCommandActionHandler {
  constructor(
    readonly config: Any,
    readonly resourceAccessor: Any,
    readonly interactionListener: Any,
    readonly summarizationHandler: Any,
    readonly conversationActionReceiver: Any,
  ) {}

  async handle(
    ctx: Any,
    action: SlateShellCommandActionPayload,
    rootPromptExecutor: Any,
    stateHandler: Any,
    mcpTools: Any,
    _onStateUpdate: Any,
  ): Promise<Any> {
    const invocation = adaptShellCommandAction(action)
    if (invocation === undefined) throw new Error("Shell command is required")
    const turn = await invocation.createTurn(ctx, stateHandler)
    let stdout = ""
    let stderr = ""
    let combinedOutput = ""
    let exitCode = 0
    // A resumed turn has already shown these updates to the user.
    const skipInteractionUpdates = !!invocation.execId
    try {
      for await (const event of invocation.run(ctx, this.resourceAccessor)) {
        switch (event.kind) {
          case "started":
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, event.interactionUpdate)
            }
            break
          case "stdout": {
            const data = event.text ?? ""
            stdout += data
            combinedOutput += data
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, event.interactionUpdate)
            }
            break
          }
          case "stderr": {
            const data = event.text ?? ""
            stderr += data
            combinedOutput += data
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, event.interactionUpdate)
            }
            break
          }
          case "exit":
            exitCode = (event.code ?? 0) | 0
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, event.interactionUpdate)
            }
            break
        }
      }
    } catch (error) {
      // The output collected so far is still recorded: a command that failed to stream still ran.
      logger.error(ctx, "Shell command action handler error", error)
    }
    turn.recordShellResult(invocation.createStoredOutput(stdout, stderr, exitCode))
    const toolCallId = randomUUID()
    const commandText = invocation.commandText
    const largeContextMode = invocation.isLargeContextMode(stateHandler)
    const transcriptView = invocation.transcriptView({ command: commandText, output: combinedOutput, exitCode, largeContextMode })
    // The transcript is written as a normal turn: the user asked, the agent called the shell, it answered.
    const userMessage = { role: "user", content: [{ type: "text", text: transcriptView.promptText }] }
    const toolName = transcriptView.toolName
    const assistantMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, args: { command: commandText } }] }
    const toolCallResult = {
      role: "tool",
      id: toolCallId,
      content: [{
        type: "tool-result",
        toolCallId,
        toolName,
        result: transcriptView.resultText,
      }],
    }
    // A conversation that begins with a shell command has no turn to have carried its instructions.
    if (rootPromptExecutor.getMessages().length === 0) {
      const requestContext = await getRequestContext(ctx, undefined, this.resourceAccessor, buildRequestContextOptions(this.config))
      const rules = getAllRules(requestContext, this.config.nonFileRules, this.config.featureFlags)
      const modeForPrompt = invocation.promptMode(stateHandler)
      const toolSetHandle = this.config.toolsGenerator({
        resourceAccessor: this.resourceAccessor,
        stateHandler,
        agentSessionId: this.config.agentSessionId,
        mcpTools,
        repositoryInfos: requestContext.repositoryInfo,
        blobStore: stateHandler.getBlobStore(),
        mode: modeForPrompt,
        loggingContext: ctx,
        requestContext,
        fileOperationLockManager: new FileOperationLockManager(),
        smartModeClassifierMode: this.config.smartModeClassifierMode,
        smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
        autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
      })
      rootPromptExecutor.appendMessages(toRedactedCoreMessages([{
        role: "system",
        content: this.config.systemPromptGenerator(toShellSystemPromptOptions({
          requestContext,
          rules,
          env: requestContext.env,
          browserTools: getBrowserToolNames(mcpTools),
          cloudRule: requestContext.cloudRule ?? undefined,
          mode: modeForPrompt,
        }), toolSetHandle),
      }], stateHandler.getPrivacyMode()))
      if (!this.config.userInfoDisplayOptions?.disable) {
        const isRootProject = await isProjectWorkspaceConversation(ctx, stateHandler)
        const placement = getCloudTestingSectionsPlacement({
          modelInfo: adaptInteropCloudTestingModelProfile(this.config.modelInfo),
          enableCloudAgentIntelligentTestingPromptSection: this.config.enableCloudAgentIntelligentTestingPromptSection,
          backgroundAgentSource: projectBackgroundAgentSource(this.config.backgroundAgentSource),
          agentType: this.config.agentType,
          enableCloudTesting: this.config.enableCloudTesting,
          featureFlags: this.config.featureFlags,
          namedAgentSessionKind: this.config.namedAgentSessionKind,
          isCloudMetaAgentParent: this.config.isCloudMetaAgentParent,
        })
        const userInfoMcpMetaToolOptions = withToolSetMcpSnapshot(getMcpMetaToolOptionsWithUserDefinedTools(requestContext.mcpMetaToolOptions, mcpTools), toolSetHandle)
        rootPromptExecutor.appendMessages(toRedactedCoreMessages([{
          role: "user",
          content: renderShellActionUserInfo({
            rules,
            agentSkills: requestContext.agentSkills,
            env: requestContext.env,
            gitRepos: requestContext.gitRepos,
            gitRepoInfoComplete: requestContext.gitRepoInfoComplete,
            cloudRule: requestContext.cloudRule ?? undefined,
            mode: modeForPrompt,
            isRootProject,
            isLargeContextModel: largeContextMode,
            displayOptions: this.config.userInfoDisplayOptions,
            mcpInfoComplete: requestContext.mcpInfoComplete,
            mcpInstructions: requestContext.mcpInstructions,
            mcpFileSystemOptions: requestContext.mcpFileSystemOptions,
            mcpMetaToolOptions: userInfoMcpMetaToolOptions,
            userIntentSummary: requestContext.userIntentSummary,
            featureFlags: this.config.featureFlags,
            enableFilterEditToolsInAskMode: this.config.enableFilterEditToolsInAskMode,
            skipMcpInstructions: (requestContext.mcpFileSystemOptions?.enabled ?? false) || (userInfoMcpMetaToolOptions?.enabled ?? false),
            hooksAdditionalContext: requestContext.hooksAdditionalContext,
            automationInstructions: this.config.automationInstructions,
            ...(this.config.enableTerminalFiles !== false && { terminalsFolder: requestContext.env?.terminalsFolder }),
            ...buildShellActionUserInfoAgentNotesProps(this.config, modeForPrompt, requestContext.env),
            designatedBranches: this.config.designatedBranches,
            branchPrefix: this.config.branchPrefix,
            branchSuffix: this.config.branchSuffix,
            preferCurrentBranchInMultiPrMode: this.config.preferCurrentBranchInMultiPrMode,
            toolInfo: extractToolInfo(toolSetHandle) as Any,
            browserTools: getBrowserToolNames(mcpTools),
            agentType: this.config.agentType,
            backgroundAgentSource: this.config.backgroundAgentSource,
            namedAgentSessionKind: this.config.namedAgentSessionKind,
            enableCloudTesting: this.config.enableCloudTesting,
            useLocalAgentPrompting: this.config.useLocalAgentPrompting,
            isRepoless: this.config.isRepoless,
            modelInfo: this.config.modelInfo,
            agentTokenLimit: this.config.agentTokenLimit,
            enableCloudAgentIntelligentTestingPromptSection: this.config.enableCloudAgentIntelligentTestingPromptSection,
          }),
          ...(invocation.providerOptionsForPromptPlacement(placement) ?? {}),
        }], stateHandler.getPrivacyMode()))
      }
    }
    rootPromptExecutor.appendMessages(toRedactedCoreMessages([userMessage, assistantMessage, toolCallResult], stateHandler.getPrivacyMode()))
    return stateHandler.computeNewStructure(ctx)
  }
}

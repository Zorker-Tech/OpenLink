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
import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.ts"
import { createLogger } from "../../context/index.ts"
import { DataClassification, PrivacyCapability } from "../../redaction/classification.ts"
import { toRedactedCoreMessages } from "../../redaction/message-redaction.ts"
import { createRedactedString } from "../../redaction/create.ts"
import { PrivacyMode } from "../../redaction/privacy-mode.ts"
import {
  createRedactedShellArgs,
  createRedactedShellCommandParsingResult,
  createRedactedShellStreamExit,
  createRedactedShellStreamStderr,
  createRedactedShellStreamStart,
  createRedactedShellStreamStdout,
  fromRedactedShellArgs,
  toRedactedShellStream,
} from "../../redacted-protos/generated/agent/v1/shell_exec_redacted.ts"
import { createRedactedShellOutput } from "../../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { RedactedUpdates } from "../../agent-core/redacted-interaction-updates.ts"
import { shellStreamExecutorResource } from "../../agent-exec/shell-stream-operation.ts"
import { getBrowserToolNames } from "../browser-tools.ts"
import { getAllRules } from "./common.ts"
import { buildRequestContextOptions, buildUserInfoAgentNotesProps } from "./meta-agent-notes.ts"
import { isProjectWorkspaceConversation } from "../configs/project-workspace-mcp-tools.ts"
import { getRequestContext } from "../utils/request-context.ts"
import { getCloudTestingSectionsPlacement } from "../prompts/cloud-testing-sections.ts"
import { extractToolInfo } from "../prompts/tool-info.ts"
import { UserInfo } from "../prompts/user-info.ts"
import { withToolSetMcpSnapshot } from "../utils/mcp-meta-tool-options.ts"
import { getMcpMetaToolOptionsWithUserDefinedTools } from "../utils/mcp-user-defined-tools.ts"
import { FileOperationLockManager } from "../tools/core/file-operation-locks.ts"
import { formatShellResult, formatShellResultForVersion } from "../tools/core/shell/formatters.ts"

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
    action: Any,
    rootPromptExecutor: Any,
    stateHandler: Any,
    mcpTools: Any,
    _onStateUpdate: Any,
  ): Promise<Any> {
    const shellCommand = action.shellCommand
    if (!shellCommand) throw new Error("Shell command is required")
    const command = shellCommand.command
    const turn = await stateHandler.createShellTurn(ctx, shellCommand)
    let stdout = createRedactedString("", DataClassification.CODE, "stdout", action._privacyMode)
    let stderr = createRedactedString("", DataClassification.CODE, "stderr", action._privacyMode)
    let combinedOutput = createRedactedString("", DataClassification.CODE, "combinedOutput", action._privacyMode)
    let exitCode = 0
    const shellExec = this.resourceAccessor.get(shellStreamExecutorResource)
    const args = createRedactedShellArgs(action._privacyMode, {
      command,
      parsingResult: createRedactedShellCommandParsingResult(action._privacyMode, {}),
      // The user typed this command themselves, so there is nothing to approve and no classifier to ask.
      skipApproval: true,
    })
    const result = shellExec.execute(ctx, fromRedactedShellArgs(args, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined), { execId: action.execId })
    // A resumed turn has already shown these updates to the user.
    const skipInteractionUpdates = !!action.execId
    try {
      for await (const unredStream of result) {
        const stream: Any = toRedactedShellStream(unredStream, action._privacyMode)
        switch (stream.event.case) {
          case "start":
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.shellOutputDelta(stream._privacyMode, {
                case: "start",
                value: createRedactedShellStreamStart(stream._privacyMode, { sandboxPolicy: stream.event.value.sandboxPolicy }),
              }))
            }
            break
          case "stdout": {
            const data = stream.event.value.data.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
            stdout = stdout.safeTransform(value => value + data)
            combinedOutput = combinedOutput.safeTransform(value => value + data)
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.shellOutputDelta(stream._privacyMode, {
                case: "stdout",
                value: createRedactedShellStreamStdout(stream._privacyMode, { data: stream.event.value.data }),
              }))
            }
            break
          }
          case "stderr": {
            const data = stream.event.value.data.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
            stderr = stderr.safeTransform(value => value + data)
            combinedOutput = combinedOutput.safeTransform(value => value + data)
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.shellOutputDelta(stream._privacyMode, {
                case: "stderr",
                value: createRedactedShellStreamStderr(stream._privacyMode, { data: stream.event.value.data }),
              }))
            }
            break
          }
          case "exit":
            exitCode = stream.event.value.code | 0
            if (!skipInteractionUpdates) {
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.shellOutputDelta(stream._privacyMode, {
                case: "exit",
                value: createRedactedShellStreamExit(stream._privacyMode, { code: stream.event.value.code, aborted: stream.event.value.aborted }),
              }))
            }
            break
        }
      }
    } catch (error) {
      // The output collected so far is still recorded: a command that failed to stream still ran.
      logger.error(ctx, "Shell command action handler error", error)
    }
    turn.recordShellOutput(createRedactedShellOutput(action._privacyMode, { stdout, stderr, exitCode }))
    const toolCallId = randomUUID()
    const commandText = command.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    let text = `Run the following command: ${commandText}`
    if (stateHandler.isDsv3()) text = `<user_query>\n${text}\n</user_query>`
    // The transcript is written as a normal turn: the user asked, the agent called the shell, it answered.
    const userMessage = { role: "user", content: [{ type: "text", text }] }
    const toolName = stateHandler.isDsv3() ? "run_terminal_cmd" : "Shell"
    const assistantMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, args: { command: commandText } }] }
    const toolCallResult = {
      role: "tool",
      id: toolCallId,
      content: [{
        type: "tool-result",
        toolCallId,
        toolName,
        result: stateHandler.isDsv3()
          ? formatShellResultForVersion({ combinedOutput: combinedOutput.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), exitCode, command: commandText }, commandText)
          : formatShellResult({ combinedOutput: combinedOutput.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), exitCode }),
      }],
    }
    // A conversation that begins with a shell command has no turn to have carried its instructions.
    if (rootPromptExecutor.getMessages().length === 0) {
      const requestContext = await getRequestContext(ctx, undefined, this.resourceAccessor, buildRequestContextOptions(this.config))
      const rules = getAllRules(requestContext, this.config.nonFileRules, this.config.featureFlags)
      const modeForPrompt = stateHandler.mode ?? AgentMode.AGENT
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
        content: this.config.systemPromptGenerator({
          requestContext,
          cursorRules: rules,
          env: requestContext.env,
          browserTools: getBrowserToolNames(mcpTools),
          cloudRule: requestContext.cloudRule ?? undefined,
          mode: modeForPrompt,
        }, toolSetHandle),
      }], stateHandler.getPrivacyMode()))
      if (!this.config.userInfoDisplayOptions?.disable) {
        const isRootProject = await isProjectWorkspaceConversation(ctx, stateHandler)
        const placement = getCloudTestingSectionsPlacement({
          modelInfo: this.config.modelInfo,
          enableComposer2IntelligentTestingPromptSection: this.config.enableComposer2IntelligentTestingPromptSection,
          backgroundAgentSource: this.config.backgroundAgentSource,
          agentType: this.config.agentType,
          enableCloudTesting: this.config.enableCloudTesting,
          featureFlags: this.config.featureFlags,
          namedAgentSessionKind: this.config.namedAgentSessionKind,
          isCloudMetaAgentParent: this.config.isCloudMetaAgentParent,
        })
        const userInfoMcpMetaToolOptions = withToolSetMcpSnapshot(getMcpMetaToolOptionsWithUserDefinedTools(requestContext.mcpMetaToolOptions, mcpTools), toolSetHandle)
        rootPromptExecutor.appendMessages(toRedactedCoreMessages([{
          role: "user",
          content: UserInfo({
            cursorRules: rules,
            agentSkills: requestContext.agentSkills,
            env: requestContext.env,
            gitRepos: requestContext.gitRepos,
            gitRepoInfoComplete: requestContext.gitRepoInfoComplete,
            cloudRule: requestContext.cloudRule ?? undefined,
            mode: modeForPrompt,
            isRootProject,
            isLargeContextModel: stateHandler.isDsv3(),
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
            ...buildUserInfoAgentNotesProps(this.config, modeForPrompt, requestContext.env),
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
            enableComposer2IntelligentTestingPromptSection: this.config.enableComposer2IntelligentTestingPromptSection,
          }),
          ...(placement !== undefined && { providerOptions: { cursor: { composer2CloudTestingSectionsPlacement: placement } } }),
        }], stateHandler.getPrivacyMode()))
      }
    }
    rootPromptExecutor.appendMessages(toRedactedCoreMessages([userMessage, assistantMessage, toolCallResult], stateHandler.getPrivacyMode()))
    return stateHandler.computeNewStructure(ctx)
  }
}

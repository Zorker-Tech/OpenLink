import { randomUUID } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { RE2JS } from "re2js";
import {
  AgentModeInterop,
  createEmptyRequestContextInterop,
  createRedactedConversationTokenDetailsInterop,
  createSyntheticUserMessageInterop,
  fromInteropUserMessage,
  fromRedactedMcpToolDefinitionInterop,
  fromRedactedRequestContextInterop,
  fromRedactedToolCallInterop,
  fromRedactedUserMessageInterop,
  toRedactedInteractionUpdateInterop,
  toRedactedToolCallInterop,
  type RequestContextInterop,
} from "../../../../adapters/interop/agent/user-message-action-protocol-adapter.ts";
import type { Context } from "../../../context/context.ts";
import type { SlateConversationStep } from "../../conversation-step-state.ts";
import {
  cloneSlateTodoItem,
  slateTodoItemWithReadableContent,
  type SlateTodoItem,
} from "../../tools/core/todo/contracts.ts";
import {
  slateConversationPlanFromValue,
  type SlateConversationPlanState,
} from "../../conversation-plan-state.ts";
import type { RequestContextResources } from "../../utils/request-context.ts";
import { createSpan } from "../../../context/telemetry.ts";
import { createLogger } from "../../../context/logging.ts";
import { ProactiveSummarizationThresholdError, InputTokenLimitError, OutputTokensLimitExceededError } from "../../../chat-inference/prompt-executor.ts";
import { PermissionsFileProvider } from "../../../config/permissions-file-provider.ts";
import { createCounter, createHistogram } from "../../../metrics/index.ts";
import { DataClassification, PrivacyCapability } from "../../../redaction/classification.ts";
import { fromRedactedCoreMessages, toRedactedCoreMessages, type CoreMessageLike } from "../../../redaction/message-redaction.ts";
import { createRedactedString, safeString } from "../../../redaction/create.ts";
import { PrivacyMode } from "../../../redaction/privacy-mode.ts";
import { BackgroundSummarizationMode, getBackgroundSummarizationTriggerThreshold, shouldPersistBackgroundSummarization, shouldStartBackgroundSummarization, type BackgroundSummarizationProps } from "../../../agent-summarization/background-summarization.ts";
import { isTooManyImagesOrDocumentsError } from "../../../agent-summarization/error-handling.ts";
import { SummarizationHandler, shouldForceSummarizationForTesting } from "../../../agent-summarization/summarization-handler.ts";
import { InteractionHandler } from "../../interaction-handler.ts";
import { RedactedUpdates } from "../../../agent-core/redacted-interaction-updates.ts";
import { Updates } from "../../../agent-core/interaction-updates.ts";
import { applyAskQuestionCompletion, type AskQuestionCompletionAction } from "../ask-question-completion.ts";
import { fromInteropAgentMode } from "../../../../adapters/interop/agent/mode-processing-adapter.ts";
import {
  createRedactedResponseComparisonUpdateInterop,
  type ResponseComparisonEventInterop,
} from "../../../../adapters/interop/agent/response-comparison-interaction-adapter.ts";
import { getBrowserToolNames } from "../../browser-tools.ts";
import { AgentConversationTurnHandle } from "../../state.ts";
import { toUnredactedInteractionListener } from "../../../../adapters/interop/agent/redacted-interaction-listener-adapter.ts";
import { AgentLoopError, createLoopReminderMessage } from "../../../../adapters/interop/agent/agent-loop-presentation-adapter.ts";
import { enrichPendingToolCallJson, getAdmittedEffectiveToolName } from "../../pending-tool-call-contract.ts";
import { getTaskToolName } from "../../tools/task-tool-name.ts";
import { executeRemoteAfterAgentThoughtHook } from "../../tools/remote-hooks.ts";
import { FileOperationLockManager } from "../../tools/core/file-operation-locks.ts";
import { attachToolReferenceHints, shouldExposeToolReferencesInCurrentContext } from "../../tools/tool-call-id-tagging.ts";
import { extractToolMetadataMap, getDirectDynamicToolNames, getExecutableTools, toAgentTools } from "../../tools/tool-execution.ts";
import { executeDeferredToolCall, getEffectiveToolCallArgs, getEffectiveToolCallName, type NativeToolCallDescriptor } from "../../tool-stream-executor.ts";
import { ToolCountingStateTracker, createToolCountingMiddleware } from "../../tool-counting-middleware.ts";
import { applyRemindersToToolResults } from "../../reminders/apply-reminders.ts";
import { agentStoreConflictNoticeExecutorResource, conflictNoticeAck, conflictNoticeRelease, conflictNoticeSyncAndPeek } from "../../../agent-exec/agent-store-conflict-notice.ts";
import { sanitizeSystemReminderContent } from "../../../hooks/system-reminder-sanitizing.ts";
import { extractAutomationTriggerContext, getAllRules } from "../common.ts";
import { mcpInputSchemaToJson, type McpInputSchemaLike } from "../../../agent-exec/mcp-operations.ts";
import { redactedPromptTokenDetailsCodec } from "../../../../adapters/interop/agent/redacted-prompt-token-details-adapter.ts";
import { getInvocationId } from "../../utils/invocation-id.ts";
import { computeNextRedactedPromptContextDetails } from "../../utils/next-redacted-prompt-context-details.ts";
import type { PromptTokenBreakdownParams } from "../../utils/prompt-token-breakdown.ts";
import {
  resolveCurrentStepMode,
  resolveCurrentTurnMode,
  SlateMode,
  type SlateMode as SlateModeValue,
} from "../../mode-processing.ts";
import { EVAL_ENFORCED_WAIT_FOR_SUMMARIZATION_COMPLETION } from "../../utils/config-overrides.ts";
import { trackPromptTokenUsage } from "../../utils/prompt-token-tracking.ts";
import { getAgentEventTracker } from "../../utils/event-tracking.ts";
import { requestPromptSuggestion } from "../../prompt-suggestion/prompt-suggestion-handler.ts";
import { getAutoRoutingReasonFromContext, getClientVersionMetricTagsFromContext, getIsInternalTeamFromContext, getIsAutoFromContext, getIsDevFromContext, getIsPremiumFromContext, getIsSubagentFromContext, getIsUserApiKeyFromContext, getRequestId, getSdkFlavorMetricTagFromContext } from "../../utils/request-scope.ts";
import { smartModeAutoRunInstructionsFromRequestContext } from "../../../../adapters/interop/agent/smart-mode-permissions-adapter.ts";
import { isGoalContinuationNotificationMessage, isNotificationOnlyUserMessage } from "./synthetic-user-message.ts";
import { warnIfLongTrailingUserMessageRun } from "./user-message-run-warning.ts";
import type { AgentType } from "../../utils/agent-config.ts";

type PromptTokenTrackingParamsLike = Parameters<typeof trackPromptTokenUsage>[0];

export function slateModeFromUserMessage(
  mode: AgentModeInterop | SlateModeValue | undefined,
): SlateModeValue | undefined {
  return typeof mode === "string" ? mode : fromInteropAgentMode(mode);
}
import type { AgentConfigTooling } from "../../agent-config-tooling.ts";
import type { AgentToolsGenerator } from "../../tools/tools-generator.ts";
import type { ToolSetHandle } from "../../tools/tool-execution.ts";
import type { SummarizationStateHandler } from "../../summarization-orchestrator.ts";

const DEFAULT_CLI_REFLECT_GENERAL_REMINDER_INTERVAL = 10;
const DEFAULT_CLI_REFLECT_GENERAL_MAX_FOLLOW_UPS_PER_TURN = -1;
const DEFAULT_CLI_REFLECT_GENERAL_REMINDER_TEXT =
  "<system_reminder>You MUST now use the Reflect tool to reflect on your current progress</system_reminder>";
const IMAGE_SUMMARIZATION_TRIGGER_COUNT = 85;
const AGENT_RESPONSE_COMPARISON_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_COMPARISON_WARMUPS_PER_TURN = 5;

type UnknownRecord = Record<string, unknown>;

interface AssistantContentPart extends UnknownRecord {
  readonly type: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly args?: unknown;
}

interface FinalAssistantMessageUxStats {
  readonly character_count: number;
  readonly word_count: number;
  readonly line_count: number;
  readonly paragraph_count: number;
  readonly sentence_count: number;
  readonly heading_count: number;
  readonly list_item_count: number;
  readonly code_block_count: number;
  readonly inline_code_count: number;
  readonly link_count: number;
}

interface UxStatsPatterns {
  readonly word: RE2JS;
  readonly sentenceTerminator: RE2JS;
  readonly heading: RE2JS;
  readonly listItem: RE2JS;
  readonly inlineCode: RE2JS;
  readonly markdownLink: RE2JS;
}

function alternateModelIdForAnalytics(modelSelection: {
  readonly alternate: "parent" | { readonly modelId: string };
}): string {
  return modelSelection.alternate === "parent" ? "same_as_parent" : modelSelection.alternate.modelId;
}

function hasAutoRunInstructions(instructions: {
  readonly allowInstructions: readonly unknown[];
  readonly blockInstructions: readonly unknown[];
} | undefined): boolean {
  return instructions !== undefined &&
    (instructions.allowInstructions.length > 0 || instructions.blockInstructions.length > 0);
}

const agentLogger = createLogger("@slate/agent");

async function loadUserPermissionsFileAutoRunInstructions(
  runContext: Context,
): Promise<{ readonly allowInstructions: readonly string[]; readonly blockInstructions: readonly string[] } | undefined> {
  try {
    const provider = await PermissionsFileProvider.load();
    const instructions = provider?.getAutoRunInstructions();
    return hasAutoRunInstructions(instructions) ? instructions : undefined;
  } catch (error) {
    agentLogger.warn(runContext, "Failed to load user permissions auto-run instructions", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function getGrindPhaseOverrideFromResponse(
  modelMessages: readonly CoreMessageLike[],
): "executing" | "planning" | undefined {
  for (const turnMessage of modelMessages) {
    if (turnMessage.role === "assistant" && Array.isArray(turnMessage.content)) {
      for (const streamPart of turnMessage.content as AssistantContentPart[]) {
        if (streamPart.type === "tool-call") {
          if (streamPart.toolName === "StartGrindExecution") {
            return "executing";
          }
          if (streamPart.toolName === "StartGrindPlanning") {
            return "planning";
          }
        }
      }
    }
  }
  return undefined;
}

function countAssistantMessages(modelMessages: readonly CoreMessageLike[]): number {
  return modelMessages.filter(turnMessage => turnMessage.role === "assistant").length;
}

function extractAssistantText(turnMessage: CoreMessageLike): string | undefined {
  if (turnMessage.role !== "assistant") {
    return undefined;
  }
  if (typeof turnMessage.content === "string") {
    return turnMessage.content;
  }
  if (!Array.isArray(turnMessage.content)) {
    return "";
  }
  return turnMessage.content.map(streamPart => {
    if (
      typeof streamPart === "object" &&
      streamPart !== null &&
      "type" in streamPart &&
      streamPart.type === "text" &&
      "text" in streamPart &&
      typeof streamPart.text === "string"
    ) {
      return streamPart.text;
    }
    return "";
  }).join("");
}

function containsToolCall(modelMessages: readonly CoreMessageLike[]): boolean {
  return modelMessages.some(turnMessage =>
    turnMessage.role === "tool" ||
    turnMessage.role === "assistant" &&
      Array.isArray(turnMessage.content) &&
      turnMessage.content.some(streamPart =>
        typeof streamPart === "object" && streamPart !== null && "type" in streamPart && streamPart.type === "tool-call"
      )
  );
}

const FINAL_ASSISTANT_MESSAGE_UX_STAT_NAMES = [
  "character_count",
  "word_count",
  "line_count",
  "paragraph_count",
  "sentence_count",
  "heading_count",
  "list_item_count",
  "code_block_count",
  "inline_code_count",
  "link_count",
] as const;

function countRegexMatches(messageText: string, pattern: RE2JS): number {
  const matcher = pattern.matcher(messageText);
  let count = 0;
  while (matcher.find()) {
    count += 1;
  }
  return count;
}

function compileFinalAssistantMessageUxStatsPatterns(): UxStatsPatterns {
  return {
    word: RE2JS.compile("[\\p{L}\\p{N}]+(?:['-][\\p{L}\\p{N}]+)*"),
    sentenceTerminator: RE2JS.compile("[.!?](?:\\s|$)"),
    heading: RE2JS.compile("^\\s{0,3}#{1,6}\\s+\\S", RE2JS.MULTILINE),
    listItem: RE2JS.compile("^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)", RE2JS.MULTILINE),
    inlineCode: RE2JS.compile("`[^`\\n]+`"),
    markdownLink: RE2JS.compile("\\[[^\\]\\n]+\\]\\([^)]+\\)"),
  };
}

function countWords(messageText: string, patterns: UxStatsPatterns): number {
  return countRegexMatches(messageText, patterns.word);
}

function countLines(messageText: string): number {
  if (messageText.length === 0) {
    return 0;
  }
  let lineCount = 1;
  for (let position = 0; position < messageText.length; position += 1) {
    const char = messageText[position];
    if (char === "\n") {
      lineCount += 1;
    } else if (char === "\r") {
      lineCount += 1;
      if (messageText[position + 1] === "\n") {
        position += 1;
      }
    }
  }
  return lineCount;
}

function countParagraphs(messageText: string): number {
  const trimmedText = messageText.trim();
  if (trimmedText.length === 0) {
    return 0;
  }
  let paragraphCount = 1;
  let newlineCountInWhitespaceRun = 0;
  let countedCurrentWhitespaceRun = false;
  for (let position = 0; position < trimmedText.length; position += 1) {
    const char = trimmedText[position]!;
    const isNewline = char === "\n" || char === "\r";
    if (isNewline) {
      newlineCountInWhitespaceRun += 1;
      if (newlineCountInWhitespaceRun >= 2 && !countedCurrentWhitespaceRun) {
        paragraphCount += 1;
        countedCurrentWhitespaceRun = true;
      }
      if (char === "\r" && trimmedText[position + 1] === "\n") {
        position += 1;
      }
      continue;
    }
    if (!isWhitespace(char)) {
      newlineCountInWhitespaceRun = 0;
      countedCurrentWhitespaceRun = false;
    }
  }
  return paragraphCount;
}

function countSentences(messageText: string, patterns: UxStatsPatterns): number {
  const trimmedText = messageText.trim();
  if (trimmedText.length === 0) {
    return 0;
  }
  const terminalPunctuationCount = countRegexMatches(
    trimmedText,
    patterns.sentenceTerminator,
  );
  return terminalPunctuationCount === 0 ? 1 : terminalPunctuationCount;
}

function isWhitespace(char: string): boolean {
  return char.trim().length === 0;
}

function getFenceMarker(line: string): "```" | "~~~" | undefined {
  const trimmedStart = line.trimStart();
  if (trimmedStart.startsWith("```")) {
    return "```";
  }
  if (trimmedStart.startsWith("~~~")) {
    return "~~~";
  }
  return undefined;
}

function getNextLineWithEnding(messageText: string, startIndex: number): {
  readonly line: string;
  readonly lineWithEnding: string;
  readonly nextIndex: number;
} {
  let lineEndIndex = startIndex;
  while (
    lineEndIndex < messageText.length &&
    messageText[lineEndIndex] !== "\n" &&
    messageText[lineEndIndex] !== "\r"
  ) {
    lineEndIndex += 1;
  }
  let nextIndex = lineEndIndex;
  if (nextIndex < messageText.length) {
    if (messageText[nextIndex] === "\r" && messageText[nextIndex + 1] === "\n") {
      nextIndex += 2;
    } else {
      nextIndex += 1;
    }
  }
  return {
    line: messageText.slice(startIndex, lineEndIndex),
    lineWithEnding: messageText.slice(startIndex, nextIndex),
    nextIndex,
  };
}

function extractFencedCodeBlockStats(messageText: string): {
  readonly count: number;
  readonly textWithoutFencedCodeBlocks: string;
} {
  let count = 0;
  let textWithoutFencedCodeBlocks = "";
  let pendingFenceMarker: "```" | "~~~" | undefined;
  let pendingFenceText = "";
  for (let position = 0; position < messageText.length;) {
    const { line, lineWithEnding, nextIndex } = getNextLineWithEnding(messageText, position);
    position = nextIndex;
    const marker = getFenceMarker(line);
    if (pendingFenceMarker === undefined) {
      if (marker === undefined) {
        textWithoutFencedCodeBlocks += lineWithEnding;
      } else {
        pendingFenceMarker = marker;
        pendingFenceText = lineWithEnding;
      }
      continue;
    }
    pendingFenceText += lineWithEnding;
    if (marker === pendingFenceMarker) {
      count += 1;
      textWithoutFencedCodeBlocks += "\n";
      pendingFenceMarker = undefined;
      pendingFenceText = "";
    }
  }
  if (pendingFenceMarker !== undefined) {
    textWithoutFencedCodeBlocks += pendingFenceText;
  }
  return { count, textWithoutFencedCodeBlocks };
}

function analyzeAssistantMessageUxStats(messageText: string): FinalAssistantMessageUxStats {
  const patterns = compileFinalAssistantMessageUxStatsPatterns();
  const { count: codeBlockCount, textWithoutFencedCodeBlocks } =
    extractFencedCodeBlockStats(messageText);
  return {
    character_count: messageText.length,
    word_count: countWords(messageText, patterns),
    line_count: countLines(messageText),
    paragraph_count: countParagraphs(messageText),
    sentence_count: countSentences(messageText, patterns),
    heading_count: countRegexMatches(textWithoutFencedCodeBlocks, patterns.heading),
    list_item_count: countRegexMatches(textWithoutFencedCodeBlocks, patterns.listItem),
    code_block_count: codeBlockCount,
    inline_code_count: countRegexMatches(textWithoutFencedCodeBlocks, patterns.inlineCode),
    link_count: countRegexMatches(textWithoutFencedCodeBlocks, patterns.markdownLink),
  };
}

function getFinalAssistantMessageUxStats(
  modelMessages: readonly CoreMessageLike[],
): FinalAssistantMessageUxStats | undefined {
  const finalMessage = modelMessages.at(-1);
  if (finalMessage === undefined) {
    return undefined;
  }
  const assistantText = extractAssistantText(finalMessage);
  if (assistantText === undefined) {
    return undefined;
  }
  return analyzeAssistantMessageUxStats(assistantText);
}

function getFinalAssistantMessageCharacterCount(
  modelMessages: readonly CoreMessageLike[],
): number | undefined {
  const finalMessage = modelMessages.at(-1);
  if (finalMessage === undefined) {
    return undefined;
  }
  return extractAssistantText(finalMessage)?.length;
}

function hasReflectGeneralToolCall(
  modelMessages: readonly CoreMessageLike[],
  toolCallIdentityResolver: {
    resolveToolCallIdentity(input: { readonly toolName: string; readonly args: unknown }): {
      readonly toolIdentifier?: unknown;
    } | undefined;
  },
): boolean {
  for (const turnMessage of modelMessages) {
    if (!Array.isArray(turnMessage.content)) {
      continue;
    }
    for (const streamPart of turnMessage.content as AssistantContentPart[]) {
      if (
        (streamPart.type === "tool-call" || streamPart.type === "tool-result") &&
        streamPart.toolName === "Reflect"
      ) {
        return true;
      }
      if (
        streamPart.type === "tool-call" &&
        toolCallIdentityResolver.resolveToolCallIdentity({
          toolName: streamPart.toolName as string,
          args: streamPart.args,
        })?.toolIdentifier === "REFLECT_GENERAL"
      ) {
        return true;
      }
    }
  }
  return false;
}

function isSuccessfulCreatePlanStep(agentStep: SlateConversationStep | undefined): boolean {
  if (agentStep?.kind !== "tool-call" || agentStep.tool.case !== "createPlanToolCall") return false;
  const toolValue = agentStep.tool.value;
  if (typeof toolValue !== "object" || toolValue === null || !("result" in toolValue)) return false;
  const stepResult = toolValue.result;
  if (typeof stepResult !== "object" || stepResult === null || !("result" in stepResult)) return false;
  return typeof stepResult.result === "object" && stepResult.result !== null && "case" in stepResult.result && stepResult.result.case === "success";
}

interface DeliveryTurnLike {
  readonly steps: readonly {
    get(runContext: Context): Promise<SlateConversationStep>;
  }[];
  readonly userMessage: {
    get(runContext: Context): Promise<{ readonly isSimulatedMsg?: boolean }>;
  };
}

interface DeliveryStateHandlerLike {
  readonly turns: readonly { get(runContext: Context): Promise<unknown> }[];
}

function isDeliveryTurnLike(fieldValue: unknown): fieldValue is DeliveryTurnLike {
  return fieldValue instanceof AgentConversationTurnHandle;
}

async function isSendMessageDeliveryOwed(
  runContext: Context,
  turnState: DeliveryStateHandlerLike,
): Promise<boolean> {
  for (let turnIndex = turnState.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const conversationTurn = await turnState.turns[turnIndex]!.get(runContext);
    if (!isDeliveryTurnLike(conversationTurn)) {
      continue;
    }
    for (let stepIndex = conversationTurn.steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
      const agentStep = await conversationTurn.steps[stepIndex]!.get(runContext);
      if (
        agentStep.kind === "tool-call" &&
        agentStep.tool.case === "sendMessageToolCall" &&
        (agentStep.tool.value as { readonly result?: { readonly result?: { readonly case?: string } } } | undefined)
          ?.result?.result?.case === "success"
      ) {
        return false;
      }
    }
    const promptUserMessage = await conversationTurn.userMessage.get(runContext);
    if (promptUserMessage.isSimulatedMsg !== true) {
      return true;
    }
  }
  return false;
}

function trailingToolBatchHasFailure(turnMessages: readonly CoreMessageLike[]): boolean {
  for (let position = turnMessages.length - 1; position >= 0; position -= 1) {
    const turnMessage = turnMessages[position];
    if (turnMessage?.role !== "tool") {
      break;
    }
    const highLevelResult = (
      turnMessage.providerOptions as {
        readonly cursor?: {
          readonly highLevelToolCallResult?: { readonly isError?: unknown };
        };
      } | undefined
    )?.cursor?.highLevelToolCallResult;
    if (highLevelResult?.isError !== false) {
      return true;
    }
  }
  return false;
}

function isTrailingTaskToolCallMessage(
  turnMessages: readonly CoreMessageLike[],
  taskToolName: string | undefined,
  toolCallIdentityResolver: {
    resolveToolCallIdentity(input: { readonly toolName: string; readonly args: unknown }): {
      readonly toolIdentifier?: unknown;
    } | undefined;
  } | undefined,
): boolean {
  if (taskToolName === undefined) {
    return false;
  }
  const lastMessage = turnMessages.at(-1);
  if (
    lastMessage?.role !== "assistant" ||
    !Array.isArray(lastMessage.content)
  ) {
    return false;
  }
  for (const streamPart of lastMessage.content as AssistantContentPart[]) {
    if (streamPart?.type !== "tool-call") {
      continue;
    }
    if (streamPart.toolName === taskToolName) {
      return true;
    }
    if (toolCallIdentityResolver?.resolveToolCallIdentity({
      toolName: streamPart.toolName as string,
      args: streamPart.args,
    })?.toolIdentifier === "TASK") {
      return true;
    }
  }
  return false;
}

function isSingleMessageLoopError(error: unknown): error is AgentLoopError {
  return error instanceof Error &&
    error.name === "AgentLoopError" &&
    (error as { loopType?: unknown }).loopType === "singleMessage";
}

const EMPTY_RESPONSE_CONTINUATION_MESSAGE =
  "<system_reminder>Please continue. Respond to the user or make tool calls.</system_reminder>";

class EmptyResponseRetryError extends Error {
  readonly retryAction: unknown;
  readonly needsContinuationMessage: unknown;

  constructor(retryOutcome: unknown, needsContinuationMessage: unknown) {
    super(`Empty model response, retry action: ${String(retryOutcome)}`);
    this.name = "EmptyResponseRetryError";
    this.retryAction = retryOutcome;
    this.needsContinuationMessage = needsContinuationMessage;
  }
}

class StepRetriesExhaustedError extends Error {
  readonly reason: unknown;
  readonly isStepRetriesExhausted = true;

  constructor(retryReason: unknown) {
    super("Failed to run step, exceeded max retries");
    this.reason = retryReason;
    this.name = "StepRetriesExhaustedError";
  }
}

const MAX_RETRY_ITERATIONS = 5;
const MAX_EMPTY_RESPONSE_RETRIES_PER_TURN = 3;

function hasEmptyAssistantText(turnMessages: readonly CoreMessageLike[]): boolean {
  for (const turnMessage of turnMessages) {
    if (turnMessage.role !== "assistant") {
      continue;
    }
    if (typeof turnMessage.content === "string") {
      if (turnMessage.content.trim().length > 0) {
        return false;
      }
    } else if (Array.isArray(turnMessage.content)) {
      for (const streamPart of turnMessage.content as AssistantContentPart[]) {
        if (streamPart.type === "text" && (streamPart.text?.trim().length ?? 0) > 0) {
          return false;
        }
      }
    }
  }
  return true;
}

function countImagePartsInMessages(turnMessages: readonly CoreMessageLike[]): number {
  const countImagesInValue = (fieldValue: unknown): number => {
    if (Array.isArray(fieldValue)) {
      let total = 0;
      for (const item of fieldValue) {
        total += countImagesInValue(item);
      }
      return total;
    }
    if (typeof fieldValue !== "object" || fieldValue === null) {
      return 0;
    }
    let total = 0;
    if (
      "type" in fieldValue &&
      typeof fieldValue.type === "string" &&
      (fieldValue.type === "image" || fieldValue.type === "image_url" || fieldValue.type === "input_image")
    ) {
      total += 1;
    }
    if ("content" in fieldValue) {
      total += countImagesInValue(fieldValue.content);
    }
    if ("experimental_content" in fieldValue) {
      total += countImagesInValue(fieldValue.experimental_content);
    }
    return total;
  };
  let imageCount = 0;
  for (const turnMessage of turnMessages) {
    imageCount += countImagesInValue(turnMessage.content);
  }
  return imageCount;
}

const agentStepCount = createCounter("agent.step.count", {
  description: "The number of steps taken by the agent",
});
const agentStoreConflictBarrier = createCounter("agent.store.conflict_barrier", {
  description: "Local-sync conflict turn-end barrier outcomes",
  labelNames: ["outcome", "timed_out"],
});
const firstStepSetupDuration = createHistogram("agent.ttft.firstStepSetupMs", {
  description: "Time from runStep entry to executeToolStream call (tool generation, message preparation) on the first step only",
});
const agentTurnDuration = createHistogram("agent.turn.duration_ms", {
  description: "Duration of agent turn execution in milliseconds",
});
const agentTurnResult = createCounter("agent.turn.result", {
  description: "Result status of agent turn execution",
  labelNames: [
    "outcome",
    "newConversation",
    "isauto",
    "ispremium",
    "isinternalteam",
    "isuserapikey",
    "issubagent",
    "autoroutingreason",
  ],
});
const agentToolCallsPerTurn = createHistogram("agent.turn.tool_calls", {
  description: "Total number of tool calls executed in a turn",
  labelNames: [
    "outcome",
    "clientversion",
    "clienttype",
    "sdkflavor",
    "user.is_dev",
  ],
});
const finalAssistantMessageCharacters = createHistogram("agent.turn.final_assistant_message_chars", {
  description: "Character count of the final assistant message when a turn completes",
});
const finalAssistantMessageUxStatsMetric = createHistogram("agent.turn.final_assistant_message_ux_stats", {
  description: "UX stats for the final assistant message when a turn completes",
  labelNames: ["stat"],
});
const unifiedHandlerNumberOfToolCalls = createHistogram("agent.unified_handler_number_of_tool_calls", {
  description: "Number of tool calls in unified handler",
  labelNames: [
    "model",
    "hasFailedToolCalls",
    "hasUnexpectedToolCallErrors",
    "success",
    "errorName",
  ],
});
const unfinishedTodosMetric = createCounter("agent.turn.unfinished_todos", {
  description: "Number of unfinished todos at the end of a turn",
});
const backgroundSummarizationDiscarded = createCounter("agent.background_summarization.discarded", {
  description: "Background summarizations discarded at end of turn",
  labelNames: ["reason", "model"],
});
const emptyResponseRetryClassification = createCounter("nal.empty_response.retry_classification", {
  description: "Retry classification for empty model responses",
  labelNames: ["retryAction", "didRetry"],
});
const toolCallArgsOutputTokens = createHistogram("tool_call.args.output_tokens", {
  description: "Output tokens for tool call arguments",
  labelNames: ["toolCallName"],
});
const toolCallArgsCacheWriteTokens = createHistogram("tool_call.args.cache_write_tokens", {
  description: "Cache write tokens for tool call arguments",
  labelNames: ["toolCallName"],
});
const toolCallResultInputTokens = createHistogram("tool_call.result.input_tokens", {
  description: "Input tokens for tool call result",
  labelNames: ["toolCallName"],
});
const toolCallResultCachedReadTokens = createHistogram("tool_call.result.cached_read_tokens", {
  description: "Cached read tokens for tool call result",
  labelNames: ["toolCallName"],
});
const numberOfParallelToolCalls = createHistogram("agent.unified_handler.model_invocation.number_of_parallel_tool_calls", {
  description: "Number of parallel tool calls in a model invocation",
  labelNames: [
    "hasFailedToolCalls",
    "hasUnexpectedToolCallErrors",
    "success",
    "errorName",
  ],
});
const numberOfParallelToolCallsWithAtLeastOneCall = createHistogram("agent.unified_handler.model_invocation.number_of_parallel_tool_calls_with_at_least_one_call", {
  description: "Number of parallel tool calls in a model invocation when there is at least one call",
  labelNames: [
    "hasFailedToolCalls",
    "hasUnexpectedToolCallErrors",
    "success",
    "errorName",
    "clientversion",
    "clienttype",
    "user.is_dev",
  ],
});

type SmartModeRequestContextLike = Parameters<typeof smartModeAutoRunInstructionsFromRequestContext>[0];

interface ResponseComparisonSelectionLike {
  readonly displayOrder: "parent-first" | "alternate-first";
  readonly comparisonConfigId: string;
  readonly alternate: "parent" | { readonly modelId: string };
}

interface PreparedResponseComparisonAttemptLike {
  readonly selection: ResponseComparisonSelectionLike;
  readonly maxResponseChars: number;
  isParentLengthEligible(modelResponse: string): boolean;
  hasSufficientCharacterDiff(parentResponse: string, alternateResponse: string): boolean;
  commitCooldown(): Promise<boolean>;
}

interface ResponseComparisonStreamPartLike {
  readonly type: string;
  readonly textDelta?: string;
}

interface ResponseComparisonResultLike {
  readonly fullStream: AsyncIterable<ResponseComparisonStreamPartLike>;
  readonly response: Promise<{ readonly messages: readonly CoreMessageLike[]; readonly error?: unknown }>;
  readonly usage?: Promise<unknown>;
  readonly extendedUsage?: Promise<unknown>;
  readonly providerMetadata?: Promise<unknown>;
  readonly invocationId?: Promise<unknown>;
}

interface AgentResponseComparisonCapabilityLike {
  readonly supportsPendingUi?: boolean;
  readonly warm?: (toolArgs: {
    readonly ctx: Context;
    readonly selection: ResponseComparisonSelectionLike;
    readonly messages: readonly CoreMessageLike[];
    readonly tools: readonly unknown[];
  }) => Promise<unknown>;
  readonly preselect?: (toolArgs: {
    readonly isByok: boolean;
    readonly isSubagent: boolean;
  }) => Promise<PreparedResponseComparisonAttemptLike | undefined>;
  readonly resolve?: (toolArgs: {
    readonly responseText: string;
    readonly isByok: boolean;
    readonly isSubagent: boolean;
  }) => Promise<PreparedResponseComparisonAttemptLike | undefined>;
  readonly refineSelection?: (toolArgs: {
    readonly ctx: Context;
    readonly parentResponse: string;
    readonly messages: readonly CoreMessageLike[];
    readonly selection: ResponseComparisonSelectionLike;
  }) => Promise<ResponseComparisonSelectionLike | undefined>;
  execute(toolArgs: {
    readonly ctx: Context;
    readonly selection: ResponseComparisonSelectionLike;
    readonly messages: readonly CoreMessageLike[];
    readonly tools: readonly unknown[];
    readonly invocationId: string;
  }): ResponseComparisonResultLike;
}

type ConflictNoticeSyncAndPeekResultLike =
  | { readonly kind: "mount-passive" }
  | {
    readonly kind: "completed" | "timed-out";
    readonly reminder?: string;
    readonly events: readonly { readonly eventId: string }[];
  };

interface UserMessageActionHandlerConfigLike {
  readonly thinkingStyle?: unknown;
  readonly resolveWriteBarrierTimeoutMs?: (() => number | undefined) | undefined;
  readonly featureFlags?: {
    readonly writeBarrierTimeoutMs?: number | undefined;
    readonly nalLoopDetection?: boolean | undefined;
    readonly cloudAgentProactiveTokenLimitError?: boolean | undefined;
    readonly cloudAgentProactiveSelfSummarization?: boolean | undefined;
    readonly enableHookAdditionalContext?: boolean | undefined;
    readonly enableAgentStoreConflictNotices?: boolean | undefined;
    readonly enableEmptyResponseRetry?: boolean | undefined;
    readonly enableCliReflectGeneralTool?: boolean | undefined;
    readonly cliReflectGeneralConfig?: {
      readonly stepsUntilForcedFollowUp?: number | undefined;
      readonly maxForcedFollowUpsPerTurn?: number | undefined;
      readonly forcedFollowUpMessage?: string | undefined;
    } | undefined;
    readonly collectModelUxStats?: boolean | undefined;
    readonly enablePromptSuggestion?: boolean | undefined;
    readonly promptSuggestionMaxInputTokenCost?: number | undefined;
    readonly getModelInputCostForContext?: ((modelConfig: string, estimatedTokens: number) => number) | undefined;
    readonly getFeedbackRequestDetails?: ((toolArgs: { readonly canonicalModelName: string | undefined }) => Promise<{
      readonly categories: readonly { readonly id: unknown; readonly label: unknown }[];
      readonly categoryGroups?: readonly {
        readonly id: unknown;
        readonly prompt: unknown;
        readonly categories: readonly { readonly id: unknown; readonly label: unknown }[];
      }[] | undefined;
      readonly title?: string | undefined;
      readonly negativeTitle?: string | undefined;
      readonly commentPlaceholder?: string | undefined;
    } | undefined>) | undefined;
    readonly glassMetaParentAgent?: boolean | undefined;
    readonly disableBackgroundTaskFollowUp?: boolean | undefined;
    readonly enableBackgroundTaskProgress?: boolean | undefined;
    readonly enableAgentChatLinks?: boolean | undefined;
    readonly hideAsyncSubagentTaskNotifications?: boolean | undefined;
    readonly userMessageTimestamps?: boolean | undefined;
    readonly slateSendMessageDeliveryOwed?: boolean | undefined;
    readonly promptContextUsageTree?: boolean | undefined;
    readonly protectLoopSkillDescription?: boolean | undefined;
  } | undefined;
  readonly automationInstructions?: unknown;
  readonly reminders?: Parameters<typeof applyRemindersToToolResults>[1];
  readonly messageHistoryModifier?: ((turnMessages: CoreMessageLike[]) => CoreMessageLike[] | undefined) | undefined;
  readonly systemPromptGenerator: (toolArgs: {
    readonly requestContext: RequestContextInterop;
    readonly cursorRules: ReturnType<typeof getAllRules>;
    readonly env: unknown;
    readonly browserTools: readonly string[];
    readonly cloudRule: unknown;
    readonly mode: SlateModeValue;
    readonly grindMode: { readonly phase: "executing" | "planning" };
  }, toolSetLease: ToolSetHandle) => string;
  readonly smartModeClassifierMode?: unknown;
  readonly smartModeClassifierShadowMode?: unknown;
  readonly agentResponseComparison?: AgentResponseComparisonCapabilityLike | undefined;
  readonly backgroundSummarizationProps: BackgroundSummarizationProps & {
    readonly requireTriggerThresholdForMidLoopPersist?: boolean | undefined;
  };
  readonly maxSteps?: number | undefined;
  readonly conversationId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly canonicalModelName?: string | undefined;
  readonly agentTokenLimit?: number | undefined;
  readonly modelInfo?: PromptTokenTrackingParamsLike["modelInfo"] & { readonly promptVersion: string };
  readonly agentType?: AgentType | undefined;
  readonly useLocalAgentPrompting?: boolean | undefined;
  readonly userInfoDisplayOptions?: PromptTokenTrackingParamsLike["userInfoDisplayOptions"];
  readonly model?: { readonly mcid?: string | undefined; readonly parameters?: readonly unknown[] | undefined } | undefined;
  readonly strictArgParsing?: boolean | undefined;
  readonly fireAndForgetCheckpoints?: boolean | undefined;
  readonly immediatelyUpdateStateOnNewTurn?: boolean | undefined;
  readonly doNotFailOnMaxSteps?: boolean | undefined;
  readonly skipErrorStateCheckpoint?: boolean | undefined;
  readonly enableExecuteHookExec?: boolean | undefined;
}

type UserMessageActionHandlerConfig = UserMessageActionHandlerConfigLike & AgentConfigTooling;

interface RedactedActionCarrier {
  readonly _privacyMode: PrivacyMode;
  readonly [key: string]: unknown;
}

interface RedactedUserMessageActionValue extends RedactedActionCarrier {
  readonly userMessage?: Parameters<typeof fromRedactedUserMessageInterop>[0];
  readonly requestContext?: {
    readonly tools?: readonly Parameters<typeof fromRedactedMcpToolDefinitionInterop>[0][];
  };
}

type RedactedConversationActionOneof =
  | { readonly case: "asyncAskQuestionCompletionAction"; readonly value: AskQuestionCompletionAction }
  | { readonly case: "userMessageAction"; readonly value: RedactedUserMessageActionValue }
  | { readonly case: "resumeAction" | "cancelAction" | "summarizeAction" | "shellCommandAction" | "startPlanAction" | "executePlanAction" | "cancelSubagentAction" | "backgroundTaskCompletionAction" | "backgroundShellAction" | "backgroundSubagentAction" | "subscriptionNotificationAction" | "goalContinuationAction" | "injectContextAction"; readonly value: RedactedActionCarrier }
  | { readonly case: undefined; readonly value?: undefined };

type RedactedConversationAction = { readonly action: RedactedConversationActionOneof };

interface ConversationActionReceiverLike {
  peek(runContext: Context): Promise<{ readonly action: RedactedConversationAction["action"] } | undefined>;
  pop(runContext: Context): Promise<undefined>;
  peekIsClaimedInjection?(): boolean;
  failConsumedInjectionDelivery?(): void;
  getContextInjectionToolSignal?(): unknown;
}

interface RetryStateHandlerLike {
  backgroundSummarizationPromiseInfo: SummarizationStateHandler["backgroundSummarizationPromiseInfo"];
  readonly backgroundSummarizationHasCompleted: boolean;
  readonly tokenDetails: SummarizationStateHandler["tokenDetails"];
  tokenDetailsStaleAfterSummarization: SummarizationStateHandler["tokenDetailsStaleAfterSummarization"];
  readonly lastStepInvocationId?: string | undefined;
  shouldSuppressSelfSummaryAfterInputLimitFailure(consumedTokens: number): boolean;
}

interface RetryRootPromptExecutorLike {
  appendMessages(turnMessages: ReturnType<typeof toRedactedCoreMessages>): void;
  clearMessages(): void;
  getState(): unknown;
  getMessages(): readonly (
    Parameters<typeof extractAutomationTriggerContext>[0][number] &
    Parameters<typeof fromRedactedCoreMessages>[0][number]
  )[];
  executeToolStream(...toolArgs: readonly unknown[]): StepStreamResultLike;
  executeModelStreamOnly(...toolArgs: readonly unknown[]): ModelOnlyStreamResultLike;
  stream(...toolArgs: readonly unknown[]): PromptSuggestionStreamResultLike;
}

interface StepStreamResultLike {
  readonly fullStream: AsyncIterable<ResponseComparisonStreamPartLike>;
  readonly response: Promise<{
    readonly messages: readonly CoreMessageLike[];
    readonly error?: unknown;
  }>;
  readonly extendedUsage: Promise<{
    readonly maxTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
  }>;
  readonly usage: Promise<{ readonly totalTokens: number }>;
  readonly invocationId: Promise<string>;
}

interface StepResultLike {
  readonly hasToolCall: boolean;
  readonly responseMessages: readonly CoreMessageLike[];
}

interface ModelOnlyStreamResultLike {
  readonly fullStream: AsyncIterable<ResponseComparisonStreamPartLike>;
  readonly response: Promise<{
    readonly messages: readonly CoreMessageLike[];
    readonly error?: unknown;
  }>;
  readonly extendedUsage: Promise<{
    readonly maxTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
  }>;
  readonly usage: Promise<{ readonly totalTokens: number }>;
  readonly toolCallDescriptors: Promise<readonly unknown[]>;
  readonly invocationId: Promise<string>;
}

interface ModelOnlyStepResultLike {
  readonly toolCallDescriptors: readonly unknown[];
  readonly responseMessages: readonly CoreMessageLike[];
}

interface RunStepTurnLike extends SetupStepTurnLike {
  readonly steps: readonly {
    get(runContext: Context): Promise<SlateConversationStep>;
  }[];
  readonly userMessage: {
    get(runContext: Context): Promise<{
      readonly mode?: AgentModeInterop | SlateModeValue | undefined;
      readonly selectedContext?: PromptTokenTrackingParamsLike["selectedContext"];
      readonly messageId?: string | undefined;
    }>;
  };
  appendPromptMessages(turnMessages: ReturnType<typeof toRedactedCoreMessages>): void;
  upsertToolCall(runContext: Context, pendingCall: unknown, callIdentifier?: string): Promise<unknown>;
}

interface RunStepStateHandlerLike extends RetryStateHandlerLike, SummarizationStateHandler {
  mode?: SlateModeValue | undefined;
  readonly turns: SummarizationStateHandler["turns"];
  lastStepInvocationId?: string | undefined;
  lastSkillCatalogBudgetStrategy?: string | undefined;
  getPrivacyMode(): PrivacyMode;
  assertRootPromptBlobsLoadedForFullPromptRead(): void;
  invalidateRootPromptPrefix(): void;
  computeNewStructure(runContext: Context): Promise<{ pendingToolCalls: unknown[] }>;
  setTokenDetails(tokenUsageDetails: ReturnType<typeof createRedactedConversationTokenDetailsInterop>): void;
  addTurnUsage(tokenUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
  }): void;
  setMode(mode: SlateModeValue): void;
  createAgentTurn(
    runContext: Context,
    promptUserMessage: unknown,
    requestState: unknown,
    config: unknown,
    resourceAccessor: unknown,
  ): Promise<RunStepTurnLike>;
  hasCompletedAskQuestion(callIdentifier: string): boolean;
  markAskQuestionCompleted(callIdentifier: string): void;
  readonly readPaths: ReadonlySet<string>;
  readonly backgroundSummarizationCancellationToken: { cancelled: boolean } | undefined;
  readonly selfSummaryInputLimitFailureTokenCount: number | undefined;
  generateModeChangeContent(config: unknown, requestState: unknown, previousMode?: SlateModeValue): string;
}

interface RetryOrchestratorLike {
  shouldStartBackgroundSummarization(...toolArgs: unknown[]): boolean;
  handleSummarization(...toolArgs: unknown[]): Promise<void>;
  canUseSelfSummary(toolArgs: { readonly tools: unknown; readonly extraT: unknown }): boolean;
}

type ToolCountingExecutorLike = Parameters<ReturnType<typeof createToolCountingMiddleware>>[0];

interface StepExecutorsLike {
    readonly rootPromptExecutor: RetryRootPromptExecutorLike;
  readonly wrappedPromptExecutor: ToolCountingExecutorLike;
}

interface EmptyResponseRetryTurnBudgetLike {
  retriesUsed: number;
}

interface MaxOutputTokenRetryDebugLike {
  readonly didAddOutputTokenReminder: boolean;
  readonly outputTokenLimitRetryCount: number;
  readonly didRetryAfterEmptyResponse: boolean;
  readonly retryLoopIteration: number;
  readonly emptyResponseRetryTurnBudget: EmptyResponseRetryTurnBudgetLike | undefined;
}

interface StepToolCountingStateLike {
  readonly toolCallCount: number;
  hasFailedToolCalls(): "true" | "false";
  hasUnexpectedToolCallErrors(): "true" | "false";
}

interface RequestContextToolLike extends McpInputSchemaLike {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description: string;
}

interface RedactedRequestContextToolLike {
  readonly _privacyMode: unknown;
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description: {
    unwrap(purpose: PrivacyCapability, options?: unknown): string;
  };
  readonly inputSchema?: unknown;
  readonly inputSchemaJson?: string | undefined;
}

type RequestContextToolInputLike = RequestContextToolLike | RedactedRequestContextToolLike;

interface MergedRequestContextToolLike {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly clientKey?: string | undefined;
}

interface SetupStepStateHandlerLike {
  readonly mode?: SlateModeValue | undefined;
  setMode(mode: SlateModeValue): void;
}

interface SetupStepTurnLike {
  readonly userMessage: {
    get(runContext: Context): Promise<{ readonly mode?: AgentModeInterop | SlateModeValue | undefined }>;
  };
}

interface PostStepTurnLike extends SetupStepTurnLike {
  appendPromptMessages(turnMessages: ReturnType<typeof toRedactedCoreMessages>): void;
}

interface InteractionListenerLike {
  sendUpdate(runContext: Context, update: unknown): Promise<void>;
  query(runContext: Context, query: unknown): Promise<any>;
  enqueuePostTurnEndedWork?: ((work: () => Promise<unknown>) => void) | undefined;
}

interface PromptSuggestionStreamResultLike {
  readonly response: Promise<unknown>;
  readonly fullStream: AsyncIterable<{ readonly type: string; readonly textDelta?: string | undefined }>;
  readonly extendedUsage: Promise<{ readonly inputTokens: number; readonly cacheReadTokens: number }>;
}

interface ResponseComparisonCandidateLike {
  readonly ctx: Context;
  readonly parentInvocationId: string;
  readonly responseText: string;
  readonly messages: readonly CoreMessageLike[];
  readonly tools: readonly unknown[];
  readonly privacyMode: PrivacyMode;
  readonly sequence: number;
}

interface ResponseComparisonPendingBaseLike {
  readonly kind: "awaiting-parent" | "parent-ready";
  readonly ctx: Context;
  readonly parentInvocationId: string;
  readonly messages: readonly CoreMessageLike[];
  readonly tools: readonly unknown[];
  readonly privacyMode: PrivacyMode;
  readonly preparedAttempt: PreparedResponseComparisonAttemptLike;
  readonly comparisonId: string;
  readonly alternateInvocationId: string;
}

type ResponseComparisonPendingLike =
  | (ResponseComparisonPendingBaseLike & { readonly kind: "awaiting-parent"; readonly parentResponse?: undefined })
  | (ResponseComparisonPendingBaseLike & { readonly kind: "parent-ready"; readonly parentResponse: string });

interface ResponseComparisonRunArgsLike {
  readonly ctx: Context;
  readonly parentInvocationId: string;
  readonly parentResponse: string;
  readonly messages: readonly CoreMessageLike[];
  readonly tools: readonly unknown[];
  readonly privacyMode: PrivacyMode;
  readonly selection: ResponseComparisonSelectionLike;
  readonly preparedAttempt: PreparedResponseComparisonAttemptLike;
  readonly pendingUi: boolean;
  readonly comparisonId?: string | undefined;
  readonly alternateInvocationId?: string | undefined;
}

type ResponseComparisonEventLike = ResponseComparisonEventInterop;

interface SplitStepStateMutationTarget {
  readonly mode?: SlateModeValue | undefined;
  readonly turns: readonly { get(runContext: Context): Promise<unknown> }[];
  getBlobStore(): unknown;
  setActiveBranchName(branchName: string | undefined): void;
  persistSubagentState(runContext: Context, subagentId: string, subagentType: unknown, turnStatus: Partial<Record<string, unknown>>): void;
  setPlan(plan: SlateConversationPlanState | undefined): void;
  setMode(mode: SlateModeValue): void;
  setTodos(todos: readonly SlateTodoItem[]): void;
  upsertPlanEntry(entry: unknown): void;
  setGoalState(goalState: unknown): void;
  appendCommunicateUpdateHistoryEntry(entry: unknown): void;
  recordReadPath(path: string): void;
  markAskQuestionCompleted?: (originalToolCallId: string) => void;
  getPrivacyMode(): PrivacyMode;
}

interface SplitStepTurnLike {
  upsertToolCall(runContext: Context, pendingCall: unknown, callIdentifier?: string): Promise<void>;
}

interface SplitStepToolCallRecorderLike {
  recordToolCall(pendingCall: unknown, callIdentifier?: string): void;
  recordPendingToolCall(runContext: Context, pendingCall: unknown, callIdentifier?: string): Promise<void>;
  upsertToolCall(runContext: Context, pendingCall: unknown, callIdentifier?: string): Promise<void>;
}

interface SplitStepReplayToolCallRecorderLike {
  recordToolCall(
    pendingCall: Parameters<AgentConversationTurnHandle["recordToolCall"]>[0],
    callIdentifier?: string,
  ): void;
  upsertToolCall(
    runContext: Context,
    pendingCall: Parameters<AgentConversationTurnHandle["recordToolCall"]>[0],
    callIdentifier?: string,
  ): Promise<void>;
}

interface SplitStepStateOpBase {
  readonly type: string;
}

type SplitStepStateOp =
  | (SplitStepStateOpBase & { readonly type: "setActiveBranchName"; readonly branchName: string | undefined })
  | (SplitStepStateOpBase & { readonly type: "persistSubagentState"; readonly subagentId: string; readonly subagentType: unknown; readonly state: Partial<Record<string, unknown>> })
  | (SplitStepStateOpBase & { readonly type: "setPlan"; readonly plan: SlateConversationPlanState | undefined })
  | (SplitStepStateOpBase & { readonly type: "setMode"; readonly mode: SlateModeValue })
  | (SplitStepStateOpBase & { readonly type: "setTodos"; readonly todos: readonly SlateTodoItem[] })
  | (SplitStepStateOpBase & { readonly type: "upsertPlanEntry"; readonly entry: unknown })
  | (SplitStepStateOpBase & { readonly type: "setGoalState"; readonly goalState: unknown })
  | (SplitStepStateOpBase & { readonly type: "appendCommunicateUpdateHistoryEntry"; readonly entry: unknown })
  | (SplitStepStateOpBase & { readonly type: "recordToolCall"; readonly toolCall: unknown; readonly toolCallId?: string | undefined })
  | (SplitStepStateOpBase & { readonly type: "recordReadPath"; readonly path: string })
  | (SplitStepStateOpBase & { readonly type: "markAskQuestionCompleted"; readonly originalToolCallId: string });

interface DeferredSplitStepDataLike {
  readonly allowedToolNames?: readonly string[] | undefined;
  stepReadPathDedup?: Set<string> | undefined;
}

interface ToolExecutionContextLike {
  readonly toolMap: Record<string, DeferredExecutableToolLike>;
  readonly interactionHandler: InteractionHandler;
  readonly extraT: UnknownRecord;
  readonly renderProps: { readonly allTools: Record<string, unknown> };
  readonly directDynamicToolNames: Set<string>;
  readonly recordToolCallResult: InteractionHandler["recordToolCallResult"];
}

interface DeferredExecutableToolLike extends Record<string, unknown> {
  readonly name: string;
  readonly toolIdentifier: string;
  readonly dynamicToolMetaRole?: string;
  readonly customToolFormat?: unknown;
  readonly prepareSubagent?: ((runContext: Context, toolArgs: unknown, metadata: Record<string, unknown>) => unknown | Promise<unknown>);
}

interface DeferredToolCallResultLike {
  readonly resultMessage: CoreMessageLike;
  readonly stateOps?: readonly SplitStepStateOp[] | undefined;
}

function isCoreMessageLike(fieldValue: Record<string, unknown>): fieldValue is CoreMessageLike {
  return typeof fieldValue.role === "string" && "content" in fieldValue;
}

function isDeferredExecutableTool(fieldValue: unknown): fieldValue is DeferredExecutableToolLike {
  return typeof fieldValue === "object" &&
    fieldValue !== null &&
    "name" in fieldValue &&
    typeof fieldValue.name === "string" &&
    "toolIdentifier" in fieldValue &&
    typeof fieldValue.toolIdentifier === "string";
}

function createSplitStepStateHandler(
  turnState: SplitStepStateMutationTarget,
  conversationTurn: SplitStepTurnLike,
): {
  readonly stateHandler: SplitStepStateMutationTarget;
  readonly toolCallRecorder: SplitStepToolCallRecorderLike;
  readonly stateOps: SplitStepStateOp[];
} {
  const stateOperations: SplitStepStateOp[] = [];
  const splitStateHandler = new Proxy(turnState, {
    get(target, property, receiver) {
      if (property === "setActiveBranchName") {
        return (branchName: string | undefined) => {
          stateOperations.push({ type: "setActiveBranchName", branchName });
          return target.setActiveBranchName(branchName);
        };
      }
      if (property === "persistSubagentState") {
        return (runContext: Context, subagentId: string, subagentType: unknown, turnStatus: Partial<Record<string, unknown>>) => {
          stateOperations.push({ type: "persistSubagentState", subagentId, subagentType, state: turnStatus });
          return target.persistSubagentState(runContext, subagentId, subagentType, turnStatus);
        };
      }
      if (property === "setPlan") {
        return (plan: unknown | undefined) => {
          const slatePlan = plan === undefined ? undefined : slateConversationPlanFromValue(plan);
          stateOperations.push({
            type: "setPlan",
            plan: slatePlan,
          });
          return target.setPlan(slatePlan);
        };
      }
      if (property === "setMode") {
        return (mode: SlateModeValue) => {
          stateOperations.push({ type: "setMode", mode });
          return target.setMode(mode);
        };
      }
      if (property === "setTodos") {
        return (todos: readonly SlateTodoItem[]) => {
          stateOperations.push({
            type: "setTodos",
            todos: todos.map(cloneSlateTodoItem),
          });
          return target.setTodos(todos);
        };
      }
      if (property === "upsertPlanEntry") {
        return (entry: unknown) => {
          stateOperations.push({ type: "upsertPlanEntry", entry });
          return target.upsertPlanEntry(entry);
        };
      }
      if (property === "setGoalState") {
        return (goalState: unknown) => {
          stateOperations.push({ type: "setGoalState", goalState });
          return target.setGoalState(goalState);
        };
      }
      if (property === "appendCommunicateUpdateHistoryEntry") {
        return (entry: unknown) => {
          stateOperations.push({ type: "appendCommunicateUpdateHistoryEntry", entry });
          return target.appendCommunicateUpdateHistoryEntry(entry);
        };
      }
      if (property === "recordReadPath") {
        return (path: string) => {
          stateOperations.push({ type: "recordReadPath", path });
          return target.recordReadPath(path);
        };
      }
      if (property === "markAskQuestionCompleted") {
        return (originalToolCallId: string) => {
          stateOperations.push({ type: "markAskQuestionCompleted", originalToolCallId });
          return target.markAskQuestionCompleted?.(originalToolCallId);
        };
      }
      const fieldValue = Reflect.get(target, property, receiver);
      return typeof fieldValue === "function" ? fieldValue.bind(target) : fieldValue;
    },
  });
  const splitToolCallRecorder: SplitStepToolCallRecorderLike = {
    recordToolCall(pendingCall, callIdentifier) {
      stateOperations.push({
        type: "recordToolCall",
        toolCall: fromRedactedToolCallInterop(pendingCall, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
        toolCallId: callIdentifier,
      });
    },
    async recordPendingToolCall(runContext, pendingCall, callIdentifier) {
      await conversationTurn.upsertToolCall(runContext, pendingCall, callIdentifier);
    },
    async upsertToolCall(_ctx, pendingCall, callIdentifier) {
      stateOperations.push({
        type: "recordToolCall",
        toolCall: fromRedactedToolCallInterop(pendingCall, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
        toolCallId: callIdentifier,
      });
    },
  };
  return { stateHandler: splitStateHandler, toolCallRecorder: splitToolCallRecorder, stateOps: stateOperations };
}

async function applyConversationStateOp(
  runContext: Context,
  turnState: SplitStepStateMutationTarget,
  toolCallRecorder: SplitStepReplayToolCallRecorderLike,
  stateOperation: SplitStepStateOp,
): Promise<void> {
  switch (stateOperation.type) {
    case "setActiveBranchName":
      turnState.setActiveBranchName(stateOperation.branchName);
      break;
    case "persistSubagentState":
      turnState.persistSubagentState(runContext, stateOperation.subagentId, stateOperation.subagentType, stateOperation.state);
      break;
    case "setPlan":
      turnState.setPlan(stateOperation.plan);
      break;
    case "setMode":
      turnState.setMode(stateOperation.mode);
      break;
    case "setTodos":
      turnState.setTodos(stateOperation.todos);
      break;
    case "upsertPlanEntry":
      turnState.upsertPlanEntry(stateOperation.entry);
      break;
    case "setGoalState":
      turnState.setGoalState(stateOperation.goalState);
      break;
    case "appendCommunicateUpdateHistoryEntry":
      turnState.appendCommunicateUpdateHistoryEntry(stateOperation.entry);
      break;
    case "recordToolCall":
      const pendingCall = stateOperation.toolCall as { readonly tool?: { readonly case?: string } };
      if (pendingCall.tool?.case === "askQuestionToolCall" && stateOperation.toolCallId !== undefined) {
        await toolCallRecorder.upsertToolCall(runContext, toRedactedToolCallInterop(stateOperation.toolCall, turnState.getPrivacyMode()), stateOperation.toolCallId);
      } else {
        toolCallRecorder.recordToolCall(toRedactedToolCallInterop(stateOperation.toolCall, turnState.getPrivacyMode()), stateOperation.toolCallId);
      }
      break;
    case "recordReadPath":
      turnState.recordReadPath(stateOperation.path);
      break;
    case "markAskQuestionCompleted":
      if (typeof turnState.markAskQuestionCompleted === "function") {
        turnState.markAskQuestionCompleted(stateOperation.originalToolCallId);
      }
      break;
    default: {
      const exhaustiveCheck: never = stateOperation;
      throw new Error(`Unhandled conversation state op: ${exhaustiveCheck}`);
    }
  }
}

export class AbstractUserMessageActionHandler {
  protected readonly config: UserMessageActionHandlerConfig;
  protected readonly resourceAccessor: RequestContextResources & {
    get(resource: typeof agentStoreConflictNoticeExecutorResource): Parameters<typeof conflictNoticeSyncAndPeek>[0] | undefined;
  };
  protected readonly interactionListener: InteractionListenerLike;
  protected readonly summarizationHandler: unknown;
  protected readonly conversationActionReceiver: ConversationActionReceiverLike;
  protected readonly orchestrator: RetryOrchestratorLike;
  private cachedAutomationTriggerContext: string | undefined | null = null;
  private responseComparisonSequence = 0;
  private responseComparisonPendingUiAttempted = false;
  private responseComparisonModelStepStarted = false;
  private responseComparisonWarmupsInTurn = 0;
  private pendingResponseComparison: ResponseComparisonPendingLike | undefined;
  private responseComparisonCandidate: ResponseComparisonCandidateLike | undefined;

  constructor(
    config: UserMessageActionHandlerConfig,
    resourceAccessor: RequestContextResources & {
      get(resource: typeof agentStoreConflictNoticeExecutorResource): Parameters<typeof conflictNoticeSyncAndPeek>[0] | undefined;
    },
    interactionListener: InteractionListenerLike,
    summarizationHandler: unknown,
    conversationActionReceiver: ConversationActionReceiverLike,
    orchestrator: RetryOrchestratorLike,
  ) {
    this.config = config;
    this.resourceAccessor = resourceAccessor;
    this.interactionListener = interactionListener;
    this.summarizationHandler = summarizationHandler;
    this.conversationActionReceiver = conversationActionReceiver;
    this.orchestrator = orchestrator;
  }

  resolveWriteBarrierTimeoutMs(): number | undefined {
    return this.config.resolveWriteBarrierTimeoutMs?.() ?? this.config.featureFlags?.writeBarrierTimeoutMs;
  }

  getAutomationTriggerContext(
    turnMessages: Parameters<typeof extractAutomationTriggerContext>[0],
  ): string | undefined {
    if (this.config.automationInstructions === void 0) return undefined;
    if (this.cachedAutomationTriggerContext !== null) return this.cachedAutomationTriggerContext;
    const stepResult = extractAutomationTriggerContext(turnMessages);
    this.cachedAutomationTriggerContext = stepResult;
    return stepResult;
  }

  getUserPermissionsFileAutoRunInstructions(
    runContext: Context,
    requestState: SmartModeRequestContextLike,
  ): Promise<Awaited<ReturnType<typeof loadUserPermissionsFileAutoRunInstructions>>> {
    if (!this.config.smartModeClassifierMode && !this.config.smartModeClassifierShadowMode) {
      return Promise.resolve(undefined);
    }
    const { userAutoRunInstructions, hasAdminOverride } = smartModeAutoRunInstructionsFromRequestContext(requestState);
    if (hasAdminOverride) return Promise.resolve(undefined);
    if (userAutoRunInstructions !== undefined) return Promise.resolve(userAutoRunInstructions);
    return loadUserPermissionsFileAutoRunInstructions(runContext);
  }

  getProjectPermissionsFileAutoRunInstructions(
    requestState: SmartModeRequestContextLike,
  ) {
    const { projectAutoRunInstructions } = smartModeAutoRunInstructionsFromRequestContext(requestState);
    return projectAutoRunInstructions;
  }

  tapAgentResponseComparisonWarmup(
    runContext: Context,
    fullStream: AsyncIterable<ResponseComparisonStreamPartLike>,
    turnMessages: readonly CoreMessageLike[] | undefined,
    executableTools: readonly unknown[] | undefined,
  ): AsyncIterable<ResponseComparisonStreamPartLike> {
    const comparisonCapability = this.config.agentResponseComparison;
    if (comparisonCapability?.warm === undefined || turnMessages === undefined || executableTools === undefined || this.pendingResponseComparison === undefined) {
      return fullStream;
    }
    const maybeWarm = () => this.maybeWarmAgentResponseComparison(runContext, comparisonCapability, turnMessages, executableTools);
    return (async function* () {
      let warmTriggered = false;
      for await (const streamPart of fullStream) {
        if (!warmTriggered && streamPart.type === "text-delta") {
          warmTriggered = true;
          maybeWarm();
        }
        yield streamPart;
      }
    })();
  }

  maybeWarmAgentResponseComparison(
    runContext: Context,
    comparisonCapability: AgentResponseComparisonCapabilityLike,
    turnMessages: readonly CoreMessageLike[],
    executableTools: readonly unknown[],
  ): void {
    const pendingState = this.pendingResponseComparison;
    if (pendingState === undefined || comparisonCapability.warm === undefined || this.responseComparisonWarmupsInTurn >= MAX_RESPONSE_COMPARISON_WARMUPS_PER_TURN) return;
    this.responseComparisonWarmupsInTurn += 1;
    void comparisonCapability.warm({ ctx: runContext, selection: pendingState.preparedAttempt.selection, messages: turnMessages, tools: executableTools }).catch(error => {
      agentLogger.warn(runContext, "Agent response comparison warmup failed open", { error });
  });
}

  async preparePendingAgentResponseComparison(toolArgs: {
    readonly ctx: Context;
    readonly parentInvocationId: string;
    readonly messages: readonly CoreMessageLike[];
    readonly tools: readonly unknown[];
    readonly privacyMode: PrivacyMode;
  }): Promise<void> {
    const comparisonCapability = this.config.agentResponseComparison;
    if (this.responseComparisonPendingUiAttempted || comparisonCapability?.supportsPendingUi !== true || comparisonCapability.preselect === undefined || this.interactionListener.enqueuePostTurnEndedWork === undefined || toolArgs.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED) return;
    this.responseComparisonPendingUiAttempted = true;
    let preparedSelection: PreparedResponseComparisonAttemptLike | undefined;
    try {
      preparedAttempt: preparedSelection  = await comparisonCapability.preselect({
        isByok: getIsUserApiKeyFromContext(toolArgs.ctx),
        isSubagent: getIsSubagentFromContext(toolArgs.ctx),
      });
    } catch (error) {
      agentLogger.warn(toolArgs.ctx, "Agent response comparison preselection failed open", { error });
      return;
    }
    if (preparedSelection === undefined) return;
    const pendingState: ResponseComparisonPendingLike = {
      kind: "awaiting-parent",
      ...toolArgs,
      preparedAttempt: preparedSelection,
      comparisonId: randomUUID(),
      alternateInvocationId: getInvocationId(toolArgs.ctx),
    };
    this.pendingResponseComparison = pendingState;
    try {
      await this.sendAgentResponseComparisonEvent({
        ctx: toolArgs.ctx,
        privacyMode: toolArgs.privacyMode,
        comparisonId: pendingState.comparisonId,
        event: {
          kind: "started",
          displayOrder: preparedSelection.selection.displayOrder === "parent-first" ? "parent-first" : "alternate-first",
          parentInvocationId: toolArgs.parentInvocationId,
          alternateInvocationId: pendingState.alternateInvocationId,
          parentResponse: "",
          comparisonConfigId: preparedSelection.selection.comparisonConfigId,
          alternateModelId: alternateModelIdForAnalytics(preparedSelection.selection),
        },
      });
    } catch (error) {
      this.pendingResponseComparison = undefined;
      agentLogger.warn(toolArgs.ctx, "Agent response comparison pending update failed open", { error });
    }
  }

  async finalizePendingAgentResponseComparison(shouldCompare: boolean): Promise<void> {
    const pendingState = this.pendingResponseComparison;
    if (pendingState === undefined) return;
    if (!shouldCompare || pendingState.kind !== "parent-ready") {
      await this.cancelPendingAgentResponseComparison();
      return;
    }
    this.pendingResponseComparison = undefined;
    this.interactionListener.enqueuePostTurnEndedWork?.(() => this.runAgentResponseComparison({
      ctx: pendingState.ctx,
      parentInvocationId: pendingState.parentInvocationId,
      parentResponse: pendingState.parentResponse,
      messages: pendingState.messages,
      tools: pendingState.tools,
      privacyMode: pendingState.privacyMode,
      selection: pendingState.preparedAttempt.selection,
      preparedAttempt: pendingState.preparedAttempt,
      pendingUi: true,
      comparisonId: pendingState.comparisonId,
      alternateInvocationId: pendingState.alternateInvocationId,
    }));
  }

  async cancelPendingAgentResponseComparison(
    retryReason: Extract<ResponseComparisonEventLike, { readonly kind: "skipped" }>["reason"] = "cancelled",
  ): Promise<void> {
    const pendingState = this.pendingResponseComparison;
    if (pendingState === undefined) return;
    this.pendingResponseComparison = undefined;
    try {
      await this.sendAgentResponseComparisonEvent({
        ctx: pendingState.ctx,
        privacyMode: pendingState.privacyMode,
        comparisonId: pendingState.comparisonId,
        event: { kind: "skipped", reason: retryReason },
      });
    } catch (error) {
      agentLogger.warn(pendingState.ctx, "Agent response comparison skip update failed open", { error });
    }
  }

  async enqueueAgentResponseComparisonIfEligible(toolArgs: {
    readonly ctx: Context;
    readonly parentInvocationId: string;
    readonly responseMessages: readonly CoreMessageLike[];
    readonly messages: readonly CoreMessageLike[];
    readonly tools: readonly unknown[];
    readonly privacyMode: PrivacyMode;
  }): Promise<void> {
    const comparisonCapability = this.config.agentResponseComparison;
    if (comparisonCapability === undefined || this.interactionListener.enqueuePostTurnEndedWork === undefined) return;
    if (comparisonCapability.supportsPendingUi && this.responseComparisonPendingUiAttempted) {
      const pendingState = this.pendingResponseComparison;
      if (pendingState === undefined) return;
      if (toolArgs.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED || containsToolCall(toolArgs.responseMessages)) {
        await this.cancelPendingAgentResponseComparison();
        return;
      }
      const finalAssistantMessage = [...toolArgs.responseMessages].reverse().find(turnMessage => turnMessage.role === "assistant");
      const assistantResponseText = finalAssistantMessage === undefined ? undefined : extractAssistantText(finalAssistantMessage);
      if (assistantResponseText === undefined || !pendingState.preparedAttempt.isParentLengthEligible(assistantResponseText)) {
        await this.cancelPendingAgentResponseComparison();
        return;
      }
      this.pendingResponseComparison = {
        ...pendingState,
        kind: "parent-ready",
        parentInvocationId: toolArgs.parentInvocationId,
        parentResponse: assistantResponseText,
        messages: toolArgs.messages,
        tools: toolArgs.tools,
      };
      return;
    }
    if (toolArgs.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED || containsToolCall(toolArgs.responseMessages)) {
      this.responseComparisonCandidate = undefined;
      return;
    }
    const finalAssistantMessage = [...toolArgs.responseMessages].reverse().find(turnMessage => turnMessage.role === "assistant");
    const assistantResponseText = finalAssistantMessage === undefined ? undefined : extractAssistantText(finalAssistantMessage);
    if (assistantResponseText === undefined || assistantResponseText.length === 0) {
      this.responseComparisonCandidate = undefined;
      return;
    }
    const sequence = ++this.responseComparisonSequence;
    this.responseComparisonCandidate = { ...toolArgs, responseText: assistantResponseText, sequence };
    this.interactionListener.enqueuePostTurnEndedWork(() => this.runPendingAgentResponseComparison(comparisonCapability, sequence));
  }

  async runPendingAgentResponseComparison(
    comparisonCapability: AgentResponseComparisonCapabilityLike,
    sequence: number,
  ): Promise<void> {
    const candidate = this.responseComparisonCandidate;
    if (candidate === undefined || candidate.sequence !== sequence) return;
    this.responseComparisonCandidate = undefined;
    if (candidate.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED || comparisonCapability.resolve === undefined) return;
    let preparedSelection: PreparedResponseComparisonAttemptLike | undefined;
    try {
      preparedAttempt: preparedSelection  = await comparisonCapability.resolve({
        responseText: candidate.responseText,
        isByok: getIsUserApiKeyFromContext(candidate.ctx),
        isSubagent: getIsSubagentFromContext(candidate.ctx),
      });
    } catch (error) {
      agentLogger.warn(candidate.ctx, "Agent response comparison selection failed open", { error });
      return;
    }
    if (preparedSelection === undefined) return;
    await this.runAgentResponseComparison({
      ctx: candidate.ctx,
      parentInvocationId: candidate.parentInvocationId,
      parentResponse: candidate.responseText,
      messages: candidate.messages,
      tools: candidate.tools,
      privacyMode: candidate.privacyMode,
      selection: preparedSelection.selection,
      preparedAttempt: preparedSelection,
      pendingUi: false,
    });
  }

  async runAgentResponseComparison(toolArgs: ResponseComparisonRunArgsLike): Promise<void> {
    const comparisonCapability = this.config.agentResponseComparison;
    if (comparisonCapability === undefined || toolArgs.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED) return;
    const comparisonId = toolArgs.comparisonId ?? randomUUID();
    const alternateInvocationId = toolArgs.alternateInvocationId ?? getInvocationId(toolArgs.ctx);
    const comparisonCtx = toolArgs.ctx.withTimeout(AGENT_RESPONSE_COMPARISON_TIMEOUT_MS);
    const sendEvent = async (streamEvent: ResponseComparisonEventLike, eventCtx: Context = comparisonCtx) => {
      await this.sendAgentResponseComparisonEvent({ ctx: eventCtx, privacyMode: toolArgs.privacyMode, comparisonId, event: streamEvent });
    };
    let stepResult: ResponseComparisonResultLike | undefined;
    try {
      let modelSelection = toolArgs.selection;
      if (comparisonCapability.refineSelection !== undefined) {
        try {
          const refined = await comparisonCapability.refineSelection({ ctx: comparisonCtx, parentResponse: toolArgs.parentResponse, messages: toolArgs.messages, selection: modelSelection });
          if (refined === undefined) {
            await sendEvent({ kind: "skipped", reason: "cancelled" });
            return;
          }
          modelSelection = refined;
        } catch (error) {
          agentLogger.warn(toolArgs.ctx, "Agent response comparison selection refinement failed open", { error });
        }
      }
      if (!toolArgs.pendingUi) {
        await sendEvent({ kind: "started", displayOrder: modelSelection.displayOrder === "parent-first" ? "parent-first" : "alternate-first", parentInvocationId: toolArgs.parentInvocationId, alternateInvocationId, parentResponse: toolArgs.parentResponse, comparisonConfigId: modelSelection.comparisonConfigId, alternateModelId: alternateModelIdForAnalytics(modelSelection) });
      }
      stepResult = comparisonCapability.execute({ ctx: comparisonCtx, selection: modelSelection, messages: toolArgs.messages, tools: toolArgs.tools, invocationId: alternateInvocationId });
      let sawToolCall = false;
      let exceededMaxResponseChars = false;
      let bufferedTextLength = 0;
      const bufferedTextDeltas: string[] = [];
      for await (const streamPart of stepResult.fullStream) {
        if (streamPart.type === "tool-call-streaming-start" || streamPart.type === "tool-call-delta" || streamPart.type === "tool-call") {
          sawToolCall = true;
          continue;
        }
        if (!sawToolCall && !exceededMaxResponseChars && streamPart.type === "text-delta") {
          const textDelta = streamPart.textDelta ?? "";
          bufferedTextLength += textDelta.length;
          if (bufferedTextLength > toolArgs.preparedAttempt.maxResponseChars) {
            exceededMaxResponseChars = true;
            bufferedTextDeltas.length = 0;
            continue;
          }
          bufferedTextDeltas.push(textDelta);
        }
      }
      const modelResponse = await stepResult.response;
      if (sawToolCall || containsToolCall(modelResponse.messages)) {
        await sendEvent({ kind: "skipped", reason: "alternate-tool-call" });
        return;
      }
      if (modelResponse.error !== undefined) throw modelResponse.error;
      if (exceededMaxResponseChars) {
        await sendEvent({ kind: "skipped", reason: "cancelled" });
        return;
      }
      const alternateResponse = bufferedTextDeltas.join("");
      if (alternateResponse.trim().length === 0) throw new Error("Alternate response completed without text");
      if (!toolArgs.preparedAttempt.hasSufficientCharacterDiff(toolArgs.parentResponse, alternateResponse)) {
        await sendEvent({ kind: "skipped", reason: "cancelled" });
        return;
      }
      if (!toolArgs.pendingUi && !await toolArgs.preparedAttempt.commitCooldown()) {
        await sendEvent({ kind: "skipped", reason: "cancelled" });
        return;
      }
      if (toolArgs.pendingUi) {
        await sendEvent({ kind: "started", displayOrder: modelSelection.displayOrder === "parent-first" ? "parent-first" : "alternate-first", parentInvocationId: toolArgs.parentInvocationId, alternateInvocationId, parentResponse: toolArgs.parentResponse, comparisonConfigId: modelSelection.comparisonConfigId, alternateModelId: alternateModelIdForAnalytics(modelSelection) });
      }
      await sendEvent({ kind: "text-delta", text: alternateResponse });
      if (toolArgs.pendingUi && !await toolArgs.preparedAttempt.commitCooldown()) {
        await sendEvent({ kind: "skipped", reason: "cancelled" });
        return;
      }
      await sendEvent({ kind: "completed" });
    } catch (error) {
      const retryReason = toolArgs.ctx.signal.aborted ? "cancelled" : comparisonCtx.signal.aborted ? "timeout" : "inference-error";
      try {
        await sendEvent({ kind: "skipped", reason: retryReason }, toolArgs.ctx);
      } catch (sendError) {
        agentLogger.warn(toolArgs.ctx, "Agent response comparison failed open", { error, sendError });
      }
    } finally {
      if (stepResult !== undefined) {
        void Promise.allSettled([stepResult.response, stepResult.usage, stepResult.extendedUsage, stepResult.providerMetadata, stepResult.invocationId]);
      }
    }
  }

  async sendAgentResponseComparisonEvent(toolArgs: {
    readonly ctx: Context;
    readonly privacyMode: PrivacyMode;
    readonly comparisonId: string;
    readonly event: ResponseComparisonEventLike;
  }): Promise<void> {
    await this.interactionListener.sendUpdate(toolArgs.ctx, createRedactedResponseComparisonUpdateInterop({
      comparisonId: toolArgs.comparisonId,
      event: toolArgs.event,
      privacyMode: toolArgs.privacyMode,
    }));
  }

  createAfterAgentThoughtCallback(callInvocationId: string, requestState: {
    readonly hooksConfig?: { readonly configuredSteps?: readonly unknown[] | undefined } | undefined;
  }): (hookCtx: Context, params: { readonly text: string; readonly durationMs?: number | undefined }) => Promise<void> {
    return async (hookCtx, params) => {
      try {
        using span = createSpan(hookCtx.withName("agent.lifecycleHook.afterAgentThought"));
        await executeRemoteAfterAgentThoughtHook({
          ctx: span.ctx,
          text: params.text,
          durationMs: params.durationMs,
          requestContext: {
            toolCallId: `after-agent-thought:${this.config.conversationId ?? callInvocationId}:${callInvocationId}:v1`,
            conversationId: this.config.conversationId,
            generationId: callInvocationId,
            model: this.config.modelId,
            modelId: this.config.model?.mcid,
            modelParams: this.config.model?.parameters !== undefined ? [...this.config.model.parameters] : undefined,
          },
          options: {
            resourceAccessor: this.resourceAccessor,
            enableExecuteHookExec: this.config.enableExecuteHookExec,
            configuredSteps: requestState.hooksConfig?.configuredSteps,
            model: this.config.modelId,
            modelId: this.config.model?.mcid,
            modelParams: this.config.model?.parameters !== undefined ? [...this.config.model.parameters] : undefined,
          },
        });
      } catch {
        // The immutable host deliberately fails lifecycle hooks open.
      }
    };
  }

  async runStep(
    parentCtx: Context,
    conversationTurn: RunStepTurnLike,
    promptExecutor: RetryRootPromptExecutorLike,
    turnState: RunStepStateHandlerLike,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: PromptTokenTrackingParamsLike["mcpTools"],
    repositoryInfos: readonly unknown[],
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
    publishStateUpdate: ((runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
    previousQueuedMessageSource: unknown,
    maxOutputTokenRetryDebug: MaxOutputTokenRetryDebugLike | undefined,
  ): Promise<{ readonly hasToolCall: boolean; readonly responseMessages: readonly CoreMessageLike[] }> {
    using spanCtxt = createSpan(parentCtx.withName("runStep"));
    const runContext = spanCtxt.ctx;
    const callInvocationId = getInvocationId(runContext);
      turnState.lastStepInvocationId = callInvocationId;
      spanCtxt.span.setAttribute("invocationId", callInvocationId);
      agentLogger.info(runContext, "Running step");
      const stepSetupStart = performance.now();
      const isFirstStep = conversationTurn.steps.length === 0;
      const isResponseComparisonFirstModelStep = !this.responseComparisonModelStepStarted;
      this.responseComparisonModelStepStarted = true;
      const interactionHandler = new InteractionHandler(
        toUnredactedInteractionListener(this.interactionListener, turnState.getPrivacyMode()),
        conversationTurn,
        callInvocationId,
        undefined,
        this.config.thinkingStyle,
        this.config.featureFlags?.nalLoopDetection === true,
        this.createAfterAgentThoughtCallback(callInvocationId, requestState),
      );
      const promptUserMessage = await conversationTurn.userMessage.get(runContext);
      const mode = resolveCurrentStepMode(turnState.mode, slateModeFromUserMessage(promptUserMessage.mode));
      const toolSetLease = toolSetGenerator({
        resourceAccessor: this.resourceAccessor,
        stateHandler: turnState,
        agentSessionId: this.config.agentSessionId,
        mcpTools: mcpToolSet,
        repositoryInfos,
        blobStore: turnState.getBlobStore(),
        mode,
        loggingContext: runContext,
        requestContext: requestState,
        fileOperationLockManager: fileLockManager,
        smartModeClassifierMode: this.config.smartModeClassifierMode,
        smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
        autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
      });
      const initialMessages = fromRedactedCoreMessages(
        promptExecutor.getMessages(),
        PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      );
      if (isFirstStep) {
        warnIfLongTrailingUserMessageRun(runContext, initialMessages as Parameters<typeof warnIfLongTrailingUserMessageRun>[1], callInvocationId);
        firstStepSetupDuration.histogram(runContext, performance.now() - stepSetupStart);
      }
      trackPromptTokenUsage({
        ctx: runContext,
        mcpTools: mcpToolSet,
        requestContext: requestState,
        messages: initialMessages,
        selectedContext: promptUserMessage.selectedContext,
        userInfoDisplayOptions: this.config.userInfoDisplayOptions,
        agentTokenLimit: this.config.agentTokenLimit,
        readToolName: toolSetLease.getTool("READ")?.name,
        invocationId: callInvocationId,
        modelInfo: this.config.modelInfo,
        featureFlags: this.config.featureFlags,
        stateHandler: turnState,
      });
      const userAutoRunInstructions = await this.getUserPermissionsFileAutoRunInstructions(runContext, requestState);
      const projectAutoRunInstructions = this.getProjectPermissionsFileAutoRunInstructions(requestState);
      let responseComparisonMessages = this.config.agentResponseComparison === undefined
        ? undefined
        : [...initialMessages];
      let responseComparisonTools = this.config.agentResponseComparison === undefined
        ? undefined
        : Object.freeze(toAgentTools(toolSetLease.getStaticTools(), toolSetLease.getDescriptionProps()));
      if (
        isResponseComparisonFirstModelStep &&
        responseComparisonMessages !== undefined &&
        responseComparisonTools !== undefined
      ) {
        await this.preparePendingAgentResponseComparison({
          ctx: runContext,
          parentInvocationId: callInvocationId,
          messages: responseComparisonMessages,
          tools: responseComparisonTools,
          privacyMode: turnState.getPrivacyMode(),
        });
      }
      let stepResult: StepStreamResultLike;
      try {
        result: stepResult  = promptExecutor.executeToolStream(
          runContext,
          turnState,
          interactionHandler,
          toolSetLease.getToolExecutionSet(),
          {
            repositoryInfos,
            shouldQueryProd: requestState.repositoryInfoShouldQueryProd,
            stateHandler: turnState,
            strictArgParsing: this.config.strictArgParsing === true,
            enableToolArgPreservation: this.config.enableToolArgPreservation === true,
            enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
            enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
            enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
            writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
            onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
            workspacePaths: requestState.env?.workspacePaths,
            userAutoRunInstructions,
            projectAutoRunInstructions,
            cursorRules: getAllRules(requestState, this.config.nonFileRules, this.config.featureFlags),
            agentSkills: requestState.agentSkills ?? [],
            contextInjectionSignal: this.conversationActionReceiver.getContextInjectionToolSignal?.(),
          },
          interactionHandler.recordToolCallResult.bind(interactionHandler),
          toolSetLease.getDescriptionProps(),
          this.config.maxSteps === 1
            ? undefined
            : async (pendingState: readonly string[] | undefined) => {
              const pendingToolCallStartedAtMs = Date.now();
              const toolExecutionSet = toolSetLease.getToolExecutionSet();
              const allowedToolNames = toolExecutionSet.modelVisibleTools.map(executableTool => executableTool.name);
              const pendingWithContracts = (pendingState ?? []).map(pendingToolCall => enrichPendingToolCallJson(pendingToolCall, {
                resolveIdentity: input => toolSetLease.resolveToolCallIdentity(input),
                toolExecutionSet,
                allowedToolNames,
                pendingToolCallStartedAtMs,
              }));
              if (this.config.fireAndForgetCheckpoints) {
                void turnState.computeNewStructure(runContext).then(async current => {
                  current.pendingToolCalls = pendingWithContracts.map(pendingToolCall => createRedactedString(
                    pendingToolCall,
                    DataClassification.CODE,
                    "pendingToolCalls",
                    PrivacyMode.UNSPECIFIED,
                  ));
                  if (publishStateUpdate) await publishStateUpdate(runContext, current);
                }).catch(error => {
                  agentLogger.error(runContext, "Failed to persist checkpoint with pending tool calls", { error });
                });
              } else {
                const current = await turnState.computeNewStructure(runContext);
                current.pendingToolCalls = pendingWithContracts.map(pendingToolCall => createRedactedString(
                  pendingToolCall,
                  DataClassification.CODE,
                  "pendingToolCalls",
                  PrivacyMode.UNSPECIFIED,
                ));
                if (publishStateUpdate) await publishStateUpdate(runContext, current);
              }
            },
        );
      } catch (error) {
        await this.cancelPendingAgentResponseComparison();
        throw error;
      }
      const tokenUsageDetails = turnState.tokenDetails;
      const isCloudAgentSingleStep = this.config.maxSteps === 1;
      const shouldSuppressSelfSummaryAfterInputLimitFailure = turnState.shouldSuppressSelfSummaryAfterInputLimitFailure(tokenUsageDetails.usedTokens);
      const shouldStartBg = !isCloudAgentSingleStep &&
        !turnState.tokenDetailsStaleAfterSummarization &&
        !shouldSuppressSelfSummaryAfterInputLimitFailure &&
        this.orchestrator.shouldStartBackgroundSummarization(
          tokenUsageDetails,
          promptExecutor.getMessages(),
          runContext,
        );
      if (shouldStartBg) {
        agentLogger.info(runContext, "[summarization-trigger] Triggering background summarization since we are below free token threshold", {
          usedTokens: tokenUsageDetails.usedTokens,
          maxTokens: tokenUsageDetails.maxTokens,
          backgroundSummarizationConfig: this.config.backgroundSummarizationProps,
        });
        await this.orchestrator.handleSummarization(
          runContext,
          turnState,
          promptExecutor,
          this.interactionListener,
          this.config,
          requestState,
          {
            backgroundSummarizationMode: BackgroundSummarizationMode.Background,
            triggerReason: "approaching_token_limit",
            currentInvocationId: callInvocationId,
            resourceAccessor: this.resourceAccessor,
            tools: toolSetLease.getStaticTools(),
            descriptionProps: toolSetLease.getDescriptionProps(),
            extraT: {
              repositoryInfos,
              shouldQueryProd: requestState.repositoryInfoShouldQueryProd,
              stateHandler: turnState,
              strictArgParsing: this.config.strictArgParsing === true,
              enableToolArgPreservation: this.config.enableToolArgPreservation === true,
              enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
              enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
              enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
              writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
              onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
              workspacePaths: requestState.env?.workspacePaths,
              userAutoRunInstructions,
              projectAutoRunInstructions,
              cursorRules: getAllRules(requestState, this.config.nonFileRules, this.config.featureFlags),
              agentSkills: requestState.agentSkills ?? [],
            },
            automationTriggerContext: this.getAutomationTriggerContext(promptExecutor.getMessages()),
          },
        );
      }
      let modelResponse: { readonly messages: readonly CoreMessageLike[]; readonly error?: unknown };
      let usageDetails: Awaited<StepStreamResultLike["extendedUsage"]>;
      let tokenUsage: Awaited<StepStreamResultLike["usage"]>;
      let finalInvocationId: string;
      [modelResponse, usageDetails, tokenUsage, finalInvocationId] = await Promise.all([
        stepResult.response,
        stepResult.extendedUsage,
        stepResult.usage,
        stepResult.invocationId,
        interactionHandler.consumeStream(
          runContext,
          this.tapAgentResponseComparisonWarmup(runContext, stepResult.fullStream, responseComparisonMessages, responseComparisonTools),
          conversationTurn,
        ),
      ]);
      if (finalInvocationId !== callInvocationId) {
        agentLogger.error(runContext, "Invocation ID mismatch. Bug in executeToolStream", undefined, {
          initialInvocationId: callInvocationId,
          finalInvocationId,
        });
      }
      agentLogger.info(runContext, "Setting token details for client token ring", {
        usedTokens: tokenUsage.totalTokens,
        maxTokens: usageDetails.maxTokens,
        inputTokens: usageDetails.inputTokens,
        outputTokens: usageDetails.outputTokens,
        cacheReadTokens: usageDetails.cacheReadTokens,
        cacheWriteTokens: usageDetails.cacheWriteTokens,
      });
      const promptContextDetails = computeNextRedactedPromptContextDetails(runContext, this.config, turnState, {
        messages: initialMessages as unknown as PromptTokenBreakdownParams["messages"],
        tools: toolSetLease.getStaticTools() as unknown as PromptTokenBreakdownParams["tools"],
        descriptionProps: toolSetLease.getDescriptionProps(),
        totalUsedTokens: tokenUsage.totalTokens,
        maxTokens: usageDetails.maxTokens,
      }, redactedPromptTokenDetailsCodec);
      turnState.setTokenDetails(createRedactedConversationTokenDetailsInterop(turnState.getPrivacyMode(), {
        usedTokens: tokenUsage.totalTokens,
        maxTokens: usageDetails.maxTokens,
        breakdown: promptContextDetails!.breakdown,
        promptContextUsageTree: promptContextDetails!.promptContextUsageTree,
      }));
      if (modelResponse.error || runContext.signal.aborted) {
        await this.cancelPendingAgentResponseComparison();
        if (this.config.skipErrorStateCheckpoint !== true) {
          conversationTurn.appendPromptMessages(toRedactedCoreMessages(modelResponse.messages, turnState.getPrivacyMode()));
          const currentState = await turnState.computeNewStructure(runContext);
          if (publishStateUpdate) await publishStateUpdate(runContext, currentState);
        }
        throw modelResponse.error ?? new ConnectError("User aborted request", Code.Canceled);
      }
      turnState.addTurnUsage({
        inputTokens: usageDetails.inputTokens,
        outputTokens: usageDetails.outputTokens,
        cacheReadTokens: usageDetails.cacheReadTokens,
        cacheWriteTokens: usageDetails.cacheWriteTokens,
        reasoningTokens: usageDetails.reasoningTokens,
      });
      const madeToolCall = containsToolCall(modelResponse.messages);
      if (!madeToolCall && responseComparisonMessages !== undefined && responseComparisonTools !== undefined) {
        try {
          await this.enqueueAgentResponseComparisonIfEligible({
            ctx: runContext,
            parentInvocationId: finalInvocationId,
            responseMessages: modelResponse.messages,
            messages: responseComparisonMessages,
            tools: responseComparisonTools,
            privacyMode: turnState.getPrivacyMode(),
          });
        } finally {
          responseComparisonMessages = undefined;
          responseComparisonTools = undefined;
        }
      }
      if (usageDetails) {
        let currentToolCallName = "userMessage";
        for (const turnMessage of modelResponse.messages) {
          if (turnMessage.role === "assistant" && Array.isArray(turnMessage.content)) {
            for (const streamPart of turnMessage.content as AssistantContentPart[]) {
              if (streamPart.type === "tool-call") {
                currentToolCallName = streamPart.toolName ?? "userMessage";
                break;
              }
            }
            if (currentToolCallName !== "userMessage") break;
          }
        }
        const argsTags = { toolCallName: currentToolCallName };
        toolCallArgsOutputTokens.histogram(runContext, usageDetails.outputTokens, argsTags);
        toolCallArgsCacheWriteTokens.histogram(runContext, usageDetails.cacheWriteTokens, argsTags);
        let priorToolCallName = "userMessage";
        if (conversationTurn.steps.length > 0) {
          const lastStepRef = conversationTurn.steps[conversationTurn.steps.length - 1]!;
          const lastStep = await lastStepRef.get(runContext);
          if (lastStep.kind === "tool-call") {
            const toolCase = lastStep.tool.case;
            if (toolCase !== undefined) priorToolCallName = toolCase.replace("ToolCall", "").replace(/_/g, "-");
          }
        }
        const resultTags = { toolCallName: priorToolCallName };
        toolCallResultInputTokens.histogram(runContext, usageDetails.inputTokens, resultTags);
        toolCallResultCachedReadTokens.histogram(runContext, usageDetails.cacheReadTokens, resultTags);
      }
      if (!madeToolCall && hasEmptyAssistantText(modelResponse.messages)) {
        const executorMessages = promptExecutor.getMessages();
        const taskToolName = toolSetLease.getTool("TASK")?.name ??
          (this.config.modelInfo !== undefined ? getTaskToolName(this.config.modelInfo) : undefined);
        const unwrappedExecutorMessages = fromRedactedCoreMessages(executorMessages, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        const isTrailingTaskToolCall = isTrailingTaskToolCallMessage(unwrappedExecutorMessages, taskToolName, toolSetLease);
        const executorMessageCount = executorMessages.length;
        const lastExecutorMsg = executorMessages.at(-1);
        const lastExecutorMsgRole = lastExecutorMsg?.role ?? "unknown";
        let thinkingChars = 0;
        for (const turnMessage of modelResponse.messages) {
          if (turnMessage.role === "assistant" && Array.isArray(turnMessage.content)) {
            for (const streamPart of turnMessage.content as AssistantContentPart[]) {
              if (streamPart.type === "reasoning" && typeof streamPart.text === "string") thinkingChars += streamPart.text.length;
            }
          }
        }
        const emptyResponseAttrs = {
          outputTokens: usageDetails.outputTokens,
          inputTokens: usageDetails.inputTokens,
          invocationId: callInvocationId,
          earlyStopDebug: {
            hasThinkingContent: thinkingChars > 0,
            thinkingChars,
            lastExecutorMsgRole,
            executorMessageCount,
            previousQueuedMessageSource: previousQueuedMessageSource ?? "none",
            actionClass: this.constructor.name,
            maxOutputTokenRetry: maxOutputTokenRetryDebug ?? {
              didAddOutputTokenReminder: false,
              outputTokenLimitRetryCount: 0,
            },
          },
        };
        if (lastExecutorMsgRole === "assistant") agentLogger.warn(runContext, "nal.empty_response.sent_assistant_message", emptyResponseAttrs);
        if (lastExecutorMsgRole === "tool") agentLogger.warn(runContext, "nal.empty_response.sent_tool", emptyResponseAttrs);
        if (thinkingChars > 0) agentLogger.warn(runContext, "nal.empty_response.received_only_thinking", emptyResponseAttrs);
        if (usageDetails.outputTokens === 0) agentLogger.warn(runContext, "nal.empty_response.received_no_output_tokens", emptyResponseAttrs);
        agentLogger.warn(runContext, "nal.empty_response", emptyResponseAttrs);
        let retryOutcome: string;
        if (this.constructor.name === "ResumeActionHandler") retryOutcome = "ok_resume_action";
        else if (this.constructor.name === "BackgroundTaskCompletionActionHandler") retryOutcome = "ok_background_task_completion_action";
        else if (lastExecutorMsgRole === "tool") retryOutcome = "retry_tool_result";
        else if (lastExecutorMsgRole === "user") retryOutcome = "retry_user_msg";
        else if (usageDetails.outputTokens === 0) retryOutcome = "retry_no_output_tokens";
        else if (thinkingChars > 0) retryOutcome = "retry_thinking_only";
        else retryOutcome = "fallthrough";
        const trailingUserMsg = lastExecutorMsg === undefined
          ? undefined
          : fromRedactedCoreMessages([lastExecutorMsg], PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)[0];
        const isTrailingNotificationUserMsg = retryOutcome === "retry_user_msg" &&
          trailingUserMsg !== undefined &&
          isNotificationOnlyUserMessage(trailingUserMsg as Parameters<typeof isNotificationOnlyUserMessage>[0]) &&
          !isGoalContinuationNotificationMessage(trailingUserMsg as Parameters<typeof isGoalContinuationNotificationMessage>[0]);
        const hasSendMessageCapability = toolSetLease.getTool("SEND_MESSAGE") !== undefined;
        const deliveryOwed = hasSendMessageCapability && this.config.featureFlags?.slateSendMessageDeliveryOwed !== false
          ? await isSendMessageDeliveryOwed(runContext, turnState)
          : true;
        const hasTrailingToolFailure = trailingToolBatchHasFailure(unwrappedExecutorMessages);
        const deliveryObligationSatisfied = hasSendMessageCapability && !deliveryOwed && !hasTrailingToolFailure;
        const isRetryEnabled = this.config.featureFlags?.enableEmptyResponseRetry === true;
        const isMetaParentAgent = this.config.featureFlags?.glassMetaParentAgent === true;
        const isMultitaskMode = mode === SlateMode.MULTITASK;
        const alreadyRetried = maxOutputTokenRetryDebug?.didRetryAfterEmptyResponse === true;
        const isLastRetryLoopIteration = (maxOutputTokenRetryDebug?.retryLoopIteration ?? 0) >= MAX_RETRY_ITERATIONS - 1;
        const turnBudget = maxOutputTokenRetryDebug?.emptyResponseRetryTurnBudget;
        const turnRetriesUsed = turnBudget?.retriesUsed ?? 0;
        const turnBudgetExhausted = turnBudget !== undefined && turnRetriesUsed >= MAX_EMPTY_RESPONSE_RETRIES_PER_TURN;
        const shouldRetry = isRetryEnabled && !isMetaParentAgent && !isMultitaskMode && !alreadyRetried &&
          !isLastRetryLoopIteration && !turnBudgetExhausted && !isTrailingNotificationUserMsg &&
          !deliveryObligationSatisfied && retryOutcome !== "ok_resume_action" &&
          retryOutcome !== "ok_background_task_completion_action" && retryOutcome !== "fallthrough";
        const needsContinuationMessage = retryOutcome !== "retry_user_msg" && !isTrailingTaskToolCall;
        const retryInfo = {
          retryAction: retryOutcome,
          isRetryEnabled,
          isMetaParentAgent,
          isMultitaskMode,
          isTrailingTaskToolCall,
          isTrailingNotificationUserMsg,
          hasSendMessageCapability,
          deliveryOwed,
          hasTrailingToolFailure,
          deliveryObligationSatisfied,
          alreadyRetried,
          isLastRetryLoopIteration,
          turnRetriesUsed,
          turnBudgetExhausted,
          maxEmptyResponseRetriesPerTurn: MAX_EMPTY_RESPONSE_RETRIES_PER_TURN,
        };
        agentLogger.warn(runContext, "nal.empty_response.retry_dry_run", { ...emptyResponseAttrs, retryInfo, shouldRetry });
        emptyResponseRetryClassification.increment(runContext, 1, {
          retryAction: retryOutcome,
          didRetry: shouldRetry ? "true" : "false",
        });
        if (shouldRetry) {
          await this.cancelPendingAgentResponseComparison();
          throw new EmptyResponseRetryError(retryOutcome, needsContinuationMessage);
        }
        if (turnBudgetExhausted) agentLogger.warn(runContext, "nal.empty_response.turn_budget_exceeded", { ...emptyResponseAttrs, retryInfo });
        agentLogger.warn(runContext, "nal.empty_response.did_not_retry", { ...emptyResponseAttrs, retryInfo });
      }
      return { hasToolCall: madeToolCall, responseMessages: modelResponse.messages };
  }

  async runWithMaxTokensRetry<T>(
    parentCtx: Context,
    promptExecutor: RetryRootPromptExecutorLike,
    fn: (runContext: Context, debug: MaxOutputTokenRetryDebugLike) => Promise<T>,
    emptyResponseRetryTurnBudget: EmptyResponseRetryTurnBudgetLike | undefined,
  ): Promise<T> {
    using spanContext = createSpan(parentCtx.withName("runWithMaxTokensRetry"));
    const runContext = spanContext.ctx;
    let didAddOutputTokenReminder = false;
    let outputTokenLimitRetryCount = 0;
    let didRetryAfterSingleMessageLoop = false;
    let didRetryAfterEmptyResponse = false;
    const isSingleMessageLoopRetryEnabled = this.config.featureFlags?.nalLoopDetection === true;
    for (let i = 0; i < MAX_RETRY_ITERATIONS; i += 1) {
      try {
        return await fn(runContext, {
          didAddOutputTokenReminder,
          outputTokenLimitRetryCount,
          didRetryAfterEmptyResponse,
          retryLoopIteration: i,
          emptyResponseRetryTurnBudget,
        });
      } catch (error) {
        if (error instanceof OutputTokensLimitExceededError) {
          outputTokenLimitRetryCount += 1;
          if (!didAddOutputTokenReminder) {
            didAddOutputTokenReminder = true;
            promptExecutor.appendMessages(toRedactedCoreMessages([
              {
                role: "user",
                content: "<system_reminder>Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.</system_reminder>",
              },
            ], PrivacyMode.UNSPECIFIED));
            agentLogger.info(runContext, "Hit max tokens error, added reminder");
          } else {
            agentLogger.info(runContext, "Hit max tokens error, but already added reminder");
          }
        } else if (error instanceof EmptyResponseRetryError && !didRetryAfterEmptyResponse) {
          didRetryAfterEmptyResponse = true;
          if (emptyResponseRetryTurnBudget !== undefined) {
            emptyResponseRetryTurnBudget.retriesUsed += 1;
          }
          if (error.needsContinuationMessage) {
            promptExecutor.appendMessages(toRedactedCoreMessages([
              { role: "user", content: EMPTY_RESPONSE_CONTINUATION_MESSAGE },
            ], PrivacyMode.UNSPECIFIED));
          }
          agentLogger.info(runContext, "nal.empty_response.retrying", {
            retryAction: error.retryAction,
            needsContinuationMessage: error.needsContinuationMessage,
            turnRetriesUsed: emptyResponseRetryTurnBudget?.retriesUsed,
            maxEmptyResponseRetriesPerTurn: MAX_EMPTY_RESPONSE_RETRIES_PER_TURN,
          });
        } else if (isSingleMessageLoopRetryEnabled && isSingleMessageLoopError(error)) {
          if (didRetryAfterSingleMessageLoop) {
            agentLogger.warn(runContext, "Single-message loop detected again after retry", {
              loopKind: error.singleMessageLoopKind,
              repetitions: error.repetitions,
              period: error.period,
            });
            throw error;
          }
          didRetryAfterSingleMessageLoop = true;
          const reminder = createLoopReminderMessage({
            kind: error.singleMessageLoopKind ?? "single_message_multi_line",
          });
          promptExecutor.appendMessages(toRedactedCoreMessages([reminder], PrivacyMode.UNSPECIFIED));
          agentLogger.info(runContext, "Single-message loop detected, added reminder and retrying", {
            loopKind: error.singleMessageLoopKind,
            repetitions: error.repetitions,
            period: error.period,
          });
        } else {
          throw error;
        }
      }
    }
    throw new StepRetriesExhaustedError("step-retries");
  }

  async runWithSummarizationRetry<T>(
    parentCtx: Context,
    turnState: RetryStateHandlerLike,
    promptExecutor: RetryRootPromptExecutorLike,
    requestState: unknown,
    executableTools: unknown,
    extraTools: unknown,
    descriptionProps: unknown,
    fn: (runContext: Context) => Promise<T>,
  ): Promise<T> {
    using spanContext = createSpan(parentCtx.withName("runWithSummarizationRetry"));
    const runContext = spanContext.ctx;
    const automationTriggerContext = this.getAutomationTriggerContext(promptExecutor.getMessages());
    for (let i = 0; i < 5; i += 1) {
      try {
        const evalCompletionMode = EVAL_ENFORCED_WAIT_FOR_SUMMARIZATION_COMPLETION(runContext);
        const forcedSummarizationMode = shouldForceSummarizationForTesting(
          fromRedactedCoreMessages(promptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
          evalCompletionMode,
        );
        if (forcedSummarizationMode !== undefined) {
          agentLogger.info(runContext, "[summarization-trigger] Force summarization triggered", {
            evalCompletionMode,
            mode: forcedSummarizationMode,
          });
          await this.orchestrator.handleSummarization(runContext, turnState, promptExecutor, this.interactionListener, this.config, requestState, {
            backgroundSummarizationMode: forcedSummarizationMode,
            fullSummarization: true,
            triggerReason: "force_dev_testing",
            currentInvocationId: turnState.lastStepInvocationId,
            resourceAccessor: this.resourceAccessor,
            tools: executableTools,
            extraT: extraTools,
            descriptionProps,
            automationTriggerContext,
          });
        }
        if (
          turnState.backgroundSummarizationPromiseInfo !== null &&
          turnState.backgroundSummarizationHasCompleted &&
          !turnState.shouldSuppressSelfSummaryAfterInputLimitFailure(turnState.tokenDetails.usedTokens)
        ) {
          const midLoopTokenDetails = turnState.tokenDetails;
          const wouldMeetPersistThreshold = shouldPersistBackgroundSummarization(
            midLoopTokenDetails.usedTokens,
            midLoopTokenDetails.maxTokens,
            this.config.backgroundSummarizationProps,
          );
          const wouldMeetTriggerThreshold = shouldStartBackgroundSummarization(
            midLoopTokenDetails.usedTokens,
            midLoopTokenDetails.maxTokens,
            this.config.backgroundSummarizationProps,
          );
          const requireTriggerThreshold = this.config.backgroundSummarizationProps.requireTriggerThresholdForMidLoopPersist === true;
          const imageCountMidLoop = countImagePartsInMessages(
            fromRedactedCoreMessages(promptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
          );
          const shouldPersistForImageThresholdMidLoop = imageCountMidLoop >= IMAGE_SUMMARIZATION_TRIGGER_COUNT;
          const shouldPersistMidLoop = shouldPersistForImageThresholdMidLoop || !requireTriggerThreshold || wouldMeetTriggerThreshold;
          agentLogger.info(runContext, "[summarization-persist] Mid-loop background summarization persistence: checking persist threshold", {
            usedTokens: midLoopTokenDetails.usedTokens,
            maxTokens: midLoopTokenDetails.maxTokens,
            unusedTokens: midLoopTokenDetails.maxTokens - midLoopTokenDetails.usedTokens,
            wouldMeetPersistThreshold,
            wouldMeetTriggerThreshold,
            requireTriggerThreshold,
            imageCountMidLoop,
            imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
            shouldPersistForImageThresholdMidLoop,
            shouldPersistMidLoop,
            triggerThreshold: getBackgroundSummarizationTriggerThreshold(midLoopTokenDetails.maxTokens, this.config.backgroundSummarizationProps),
            persistConfig: {
              unusedTokensThreshold: this.config.backgroundSummarizationProps.unusedTokensThresholdToPersistBackgroundSummarization,
              unusedPercentTokensThreshold: this.config.backgroundSummarizationProps.unusedPercentTokensThresholdToPersistBackgroundSummarization,
            },
          });
          if (shouldPersistMidLoop) {
            await this.orchestrator.handleSummarization(runContext, turnState, promptExecutor, this.interactionListener, this.config, requestState, {
              backgroundSummarizationMode: BackgroundSummarizationMode.BackgroundAndPersistIfCompleted,
              triggerReason: shouldPersistForImageThresholdMidLoop && !wouldMeetTriggerThreshold ? "approaching_image_limit" : "approaching_token_limit",
              currentInvocationId: turnState.lastStepInvocationId,
              resourceAccessor: this.resourceAccessor,
              tools: executableTools,
              extraT: extraTools,
              descriptionProps,
              automationTriggerContext,
            });
          }
        }
        if (turnState.backgroundSummarizationPromiseInfo !== null && !turnState.backgroundSummarizationHasCompleted) {
          const currentTokenDetails = turnState.tokenDetails;
          const overageThreshold = Math.min(0.25 * currentTokenDetails.maxTokens, 5e4);
          if (currentTokenDetails.maxTokens > 0 && currentTokenDetails.usedTokens > currentTokenDetails.maxTokens + overageThreshold) {
            agentLogger.info(runContext, "[summarization-persist] Blocking on background summarization because token usage significantly exceeds max tokens", {
              usedTokens: currentTokenDetails.usedTokens,
              maxTokens: currentTokenDetails.maxTokens,
              overageThreshold,
            });
            await this.orchestrator.handleSummarization(runContext, turnState, promptExecutor, this.interactionListener, this.config, requestState, {
              backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
              triggerReason: "significantly_over_token_limit",
              currentInvocationId: turnState.lastStepInvocationId,
              resourceAccessor: this.resourceAccessor,
              tools: executableTools,
              extraT: extraTools,
              descriptionProps,
              automationTriggerContext,
            });
          }
        }
        const messagesBeforeImageCompaction = fromRedactedCoreMessages(promptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        const imageCount = countImagePartsInMessages(messagesBeforeImageCompaction);
        if (imageCount >= IMAGE_SUMMARIZATION_TRIGGER_COUNT) {
          agentLogger.info(runContext, "Image count reached threshold; starting background summarization", {
            imageCount,
            triggerCount: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
          });
          await this.orchestrator.handleSummarization(runContext, turnState, promptExecutor, this.interactionListener, this.config, requestState, {
            backgroundSummarizationMode: BackgroundSummarizationMode.Background,
            triggerReason: "approaching_image_limit",
            currentInvocationId: turnState.lastStepInvocationId,
            resourceAccessor: this.resourceAccessor,
            tools: executableTools,
            extraT: extraTools,
            descriptionProps,
            automationTriggerContext,
          });
        }
        if (this.config.maxSteps === 1 && this.config.featureFlags?.cloudAgentProactiveTokenLimitError === true && !turnState.tokenDetailsStaleAfterSummarization) {
          const tokenUsageDetails = turnState.tokenDetails;
          if (shouldPersistBackgroundSummarization(tokenUsageDetails.usedTokens, tokenUsageDetails.maxTokens, this.config.backgroundSummarizationProps)) {
            const useProactiveSelfSummarization = this.config.featureFlags?.cloudAgentProactiveSelfSummarization === true;
            agentLogger.info(runContext, useProactiveSelfSummarization ? "[cloud-summarization] Token usage hit configured threshold, throwing ProactiveSummarizationThresholdError to trigger compaction" : "[cloud-summarization] Token usage hit configured threshold, throwing InputTokenLimitError to trigger external compaction", {
              usedTokens: tokenUsageDetails.usedTokens,
              maxTokens: tokenUsageDetails.maxTokens,
              useProactiveSelfSummarization,
            });
            throw useProactiveSelfSummarization ? new ProactiveSummarizationThresholdError() : new InputTokenLimitError();
          }
        }
        return await fn(runContext);
      } catch (error) {
        const isProactiveSummarizationThresholdError = error instanceof ProactiveSummarizationThresholdError;
        const isTokenLimitError = SummarizationHandler.isTokenLimitError(error);
        const isImagePartsLimitError = isTooManyImagesOrDocumentsError(error);
        if (isProactiveSummarizationThresholdError || isTokenLimitError || isImagePartsLimitError) {
          const wouldUseSelfSummary = this.orchestrator.canUseSelfSummary({ tools: executableTools, extraT: extraTools });
          agentLogger.info(runContext, isImagePartsLimitError ? "[summarization-trigger] Hit image limit error, running blocking summarization in order to compress context" : isProactiveSummarizationThresholdError ? "[summarization-trigger] Hit configured summarization threshold, running blocking summarization in order to compress context" : "[summarization-trigger] Hit token limit error, running blocking summarization in order to compress context");
          const forceExternalModel = isTokenLimitError || isImagePartsLimitError ? true : undefined;
          const summarizationOptions = {
            backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
            currentInvocationId: turnState.lastStepInvocationId,
            triggerReason: isImagePartsLimitError ? "approaching_image_limit" : isProactiveSummarizationThresholdError ? "approaching_token_limit" : wouldUseSelfSummary ? "fallback_on_limit_error" : "input_token_limit_error",
            resourceAccessor: this.resourceAccessor,
            forceExternalModel,
            tools: executableTools,
            extraT: extraTools,
            descriptionProps,
            automationTriggerContext,
          };
          try {
            await this.orchestrator.handleSummarization(runContext, turnState, promptExecutor, this.interactionListener, this.config, requestState, summarizationOptions);
          } catch (summarizationError) {
            const shouldFallbackToExternalSummarization = this.config.featureFlags?.cloudAgentProactiveSelfSummarization === true && forceExternalModel !== true && wouldUseSelfSummary && SummarizationHandler.isTokenLimitError(summarizationError);
            if (!shouldFallbackToExternalSummarization) throw summarizationError;
            agentLogger.info(runContext, "[summarization-trigger] Self-summary hit token limit, falling back to external summarization");
            await this.orchestrator.handleSummarization(runContext, turnState, promptExecutor, this.interactionListener, this.config, requestState, {
              ...summarizationOptions,
              triggerReason: "fallback_on_limit_error",
              forceExternalModel: true,
            });
          }
          continue;
        }
        throw error;
      }
    }
    throw new StepRetriesExhaustedError("summarization-retries");
  }

  async runTurnLoop(
    parentCtx: Context,
    promptExecutor: RetryRootPromptExecutorLike,
    turnState: RunStepStateHandlerLike,
    initialTurn: RunStepTurnLike,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: readonly MergedRequestContextToolLike[],
    repositoryDetails: readonly unknown[],
    requestState: RequestContextInterop,
    publishStateUpdate: (runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<void> {
    using spanContext = createSpan(parentCtx.withName("runTurnLoop"));
    const runContext = spanContext.ctx;
    await this.cancelPendingAgentResponseComparison();
    this.responseComparisonPendingUiAttempted = false;
    this.responseComparisonModelStepStarted = false;
    this.responseComparisonWarmupsInTurn = 0;
    this.responseComparisonCandidate = undefined;
    const turnStartTime = performance.now();
    let totalToolCallsInTurn = 0;
    const turnToolCountingState = new ToolCountingStateTracker();
    const turnToolCountingMiddleware = createToolCountingMiddleware(turnToolCountingState);
    const wrappedRootPromptExecutor = turnToolCountingMiddleware(promptExecutor);
    const hadPreviousAssistantMessage = promptExecutor.getMessages().some(turnMessage => turnMessage.role === "assistant");
    const initialTodos = await Promise.all(turnState.todos.map(todoRef => todoRef.get(runContext)));
    const initialTodoCount = initialTodos.length;
    const hadUnfinishedTodosAtStart = initialTodos.some(todo => todo.status === "pending" || todo.status === "in_progress");
    const unfinishedTodosAtStart = initialTodos.filter(todo => todo.status === "pending" || todo.status === "in_progress").length;
    let conversationTurn = initialTurn;
    let currentMcpTools = mcpToolSet;
    let assistantMessagesSinceLastReflectGeneral = 0;
    const cliReflectGeneralReminderInterval = this.config.featureFlags?.cliReflectGeneralConfig?.stepsUntilForcedFollowUp ?? DEFAULT_CLI_REFLECT_GENERAL_REMINDER_INTERVAL;
    const cliReflectGeneralMaxFollowUpsPerTurn = this.config.featureFlags?.cliReflectGeneralConfig?.maxForcedFollowUpsPerTurn ?? DEFAULT_CLI_REFLECT_GENERAL_MAX_FOLLOW_UPS_PER_TURN;
    const cliReflectGeneralReminderText = this.config.featureFlags?.cliReflectGeneralConfig?.forcedFollowUpMessage ?? DEFAULT_CLI_REFLECT_GENERAL_REMINDER_TEXT;
    let cliReflectGeneralFollowUpsSentInTurn = 0;
    const promptUserMessage = await initialTurn.userMessage.get(runContext);
    turnState.setMode(resolveCurrentTurnMode(turnState.mode, slateModeFromUserMessage(promptUserMessage.mode)));
    const maxSteps = this.config.maxSteps;
    if (typeof maxSteps !== "number" || !Number.isFinite(maxSteps) || maxSteps <= 0) {
      throw new Error("Max steps must be a finite number greater than 0");
    }
    const fileLockManager = new FileOperationLockManager();
    let previousStepCount = conversationTurn.steps.length;
    let previousMode = turnState.mode;
    let previousQueuedMessageSource = "none";
    let finalAssistantMessageCharacterCount: number | undefined;
    let finalAssistantMessageUxStats: FinalAssistantMessageUxStats | undefined;
    const emptyResponseRetryTurnBudget: EmptyResponseRetryTurnBudgetLike = { retriesUsed: 0 };
    let conflictBarrierInjectionsRemaining = 2;
    try {
      for (let agentStep = 0; agentStep < maxSteps && !runContext.signal.aborted; agentStep += 1) {
        try {
          const currentMode = turnState.mode;
          if (previousMode !== undefined && currentMode !== undefined && currentMode !== previousMode) {
            const modeReminder = turnState.generateModeChangeContent(this.config, requestState, previousMode);
            agentLogger.info(runContext, "Mode changed, adding nudge", { previousMode, newMode: currentMode });
            if (modeReminder) {
              promptExecutor.appendMessages(toRedactedCoreMessages([{ role: "user", content: modeReminder }], turnState.getPrivacyMode()));
            }
            previousMode = currentMode;
          }
          const readPathsBefore = new Set(turnState.readPaths);
          const { hasToolCall: madeToolCall, responseMessages: modelMessages, toolCallIdentityResolver } = await this.executeStepWithMetrics(
            runContext,
            conversationTurn,
            { wrappedPromptExecutor: wrappedRootPromptExecutor, rootPromptExecutor: promptExecutor },
            turnState,
            toolSetGenerator,
            currentMcpTools,
            repositoryDetails,
            requestState,
            fileLockManager,
            publishStateUpdate,
            previousQueuedMessageSource,
            emptyResponseRetryTurnBudget,
          );
          const toolCallsInStep = modelMessages.filter(turnMessage => turnMessage.role === "tool").length;
          totalToolCallsInTurn += toolCallsInStep;
          const assistantMessagesInStep = countAssistantMessages(modelMessages);
          const hasReflectGeneralCall = hasReflectGeneralToolCall(modelMessages, toolCallIdentityResolver);
          assistantMessagesSinceLastReflectGeneral = hasReflectGeneralCall
            ? 0
            : assistantMessagesSinceLastReflectGeneral + assistantMessagesInStep;
          previousStepCount = conversationTurn.steps.length;
          await this.applyPostStepProcessing(runContext, conversationTurn, promptExecutor, turnState, madeToolCall, [...modelMessages], publishStateUpdate, {
            requestContext: requestState,
            toolsGenerator: toolSetGenerator,
            repositoryInfo: repositoryDetails,
            mcpTools: currentMcpTools,
            fileOperationLockManager: fileLockManager,
          });
          const isLastIteration = agentStep === maxSteps - 1;
          let updatedTurn = conversationTurn;
          let hasQueuedMessages = false;
          let queuedMessageSource = "none";
          let hasQueuedUserTurn = false;
          let updatedMcpTools = currentMcpTools;
          const queuedAction = await this.conversationActionReceiver.peek(runContext);
          if (queuedAction?.action.case === "asyncAskQuestionCompletionAction") {
            agentLogger.info(runContext, "Found queued AsyncAskQuestionCompletionAction - processing immediately", {
              originalToolCallId: queuedAction.action.value.originalToolCallId,
            });
            await this.conversationActionReceiver.pop(runContext);
            const completionAction = queuedAction.action.value;
            const application = await applyAskQuestionCompletion(runContext, {
              action: completionAction,
              stateHandler: turnState,
              turn: conversationTurn,
              rootPromptExecutor: promptExecutor,
              resultFormat: "json-object",
            });
            if (application.outcome === "applied") {
              const syntheticModelCallId = randomUUID();
              await this.interactionListener.sendUpdate(runContext, RedactedUpdates.toolCallStarted(application.recordedToolCallId, application.toolCall, syntheticModelCallId));
              await this.interactionListener.sendUpdate(runContext, RedactedUpdates.toolCallCompleted(application.recordedToolCallId, application.toolCall, syntheticModelCallId));
              agentLogger.info(runContext, "Injected async completion into current turn", {
                originalToolCallId: completionAction.originalToolCallId,
                resultCase: completionAction.result?.result.case,
              });
              totalToolCallsInTurn += 1;
              hasQueuedMessages = true;
              queuedMessageSource = "asyncAskQuestionCompletion";
            } else {
              agentLogger.info(runContext, "Dropped queued async completion", {
                originalToolCallId: completionAction.originalToolCallId,
                outcome: application.outcome,
              });
            }
          }
          if (!isLastIteration) {
            const stepResult = await this.consumeQueuedUserMessagesAndMaybeCreateNewTurns(runContext, turnState, conversationTurn, currentMcpTools, publishStateUpdate);
            updatedTurn = stepResult.turn;
            hasQueuedMessages = hasQueuedMessages || stepResult.hasQueuedMessages;
            if (stepResult.hasQueuedMessages) queuedMessageSource = "consumeQueuedUserMessages";
            hasQueuedUserTurn = stepResult.hasQueuedMessages;
            updatedMcpTools = stepResult.mcpTools;
          }
          const crossedReflectReminderThreshold = !hasReflectGeneralCall && assistantMessagesInStep > 0 &&
            Math.floor((assistantMessagesSinceLastReflectGeneral - assistantMessagesInStep) / cliReflectGeneralReminderInterval) <
            Math.floor(assistantMessagesSinceLastReflectGeneral / cliReflectGeneralReminderInterval);
          const canInjectReflectReminderThisTurn = cliReflectGeneralMaxFollowUpsPerTurn === -1 || cliReflectGeneralFollowUpsSentInTurn < cliReflectGeneralMaxFollowUpsPerTurn;
          if (!isLastIteration && !hasQueuedUserTurn && crossedReflectReminderThreshold && canInjectReflectReminderThisTurn && await this.shouldInjectCliReflectGeneralFollowUp(runContext, turnState, conversationTurn, toolSetGenerator, updatedMcpTools, repositoryDetails, requestState, fileLockManager)) {
            updatedTurn = await this.createCliReflectGeneralFollowUpTurn(runContext, turnState, conversationTurn, cliReflectGeneralReminderText, requestState, publishStateUpdate);
            hasQueuedMessages = true;
            queuedMessageSource = "cliReflectGeneralFollowUp";
            cliReflectGeneralFollowUpsSentInTurn += 1;
            agentLogger.info(runContext, "Injected CLI reflect-general follow-up", {
              assistantMessagesSinceLastReflectGeneral,
              cliReflectGeneralFollowUpsSentInTurn,
              cliReflectGeneralMaxFollowUpsPerTurn,
            });
          }
          conversationTurn = updatedTurn;
          currentMcpTools = updatedMcpTools;
          const hasEnded = (!madeToolCall && !hasQueuedMessages) || isLastIteration;
          if (!madeToolCall && !hasQueuedMessages && conflictBarrierInjectionsRemaining > 0 && !isLastIteration && this.config.featureFlags?.enableAgentStoreConflictNotices === true && await this.maybeInjectPreFinalConflictBarrier(runContext, promptExecutor, turnState.getPrivacyMode())) {
            conflictBarrierInjectionsRemaining -= 1;
            this.responseComparisonCandidate = undefined;
            continue;
          }
          if (!hasEnded) {
            this.responseComparisonCandidate = undefined;
          } else if (madeToolCall || hasQueuedMessages) {
            this.responseComparisonCandidate = undefined;
            await this.finalizePendingAgentResponseComparison(false);
          }
          if (hasEnded) {
            try {
              finalAssistantMessageCharacterCount = getFinalAssistantMessageCharacterCount(modelMessages);
            } catch (error) {
              agentLogger.error(runContext, "Failed to count final assistant message characters", error);
              finalAssistantMessageCharacterCount = undefined;
            }
            if (this.config.featureFlags?.collectModelUxStats !== false) {
              try {
                finalAssistantMessageUxStats = getFinalAssistantMessageUxStats(modelMessages);
              } catch (error) {
                agentLogger.error(runContext, "Failed to analyze final assistant message UX stats", error);
                finalAssistantMessageUxStats = undefined;
              }
            }
          }
          previousQueuedMessageSource = queuedMessageSource;
          if (hasEnded && turnState.backgroundSummarizationPromiseInfo !== null) {
            const backgroundSummarizationPromiseInfo = turnState.backgroundSummarizationPromiseInfo;
            const tokenUsageDetails = turnState.tokenDetails;
            const isSelfSummary = backgroundSummarizationPromiseInfo.summarizerType === "self";
            const shouldPersistForTokenThreshold = shouldPersistBackgroundSummarization(tokenUsageDetails.usedTokens, tokenUsageDetails.maxTokens, this.config.backgroundSummarizationProps);
            const endOfTurnMessages = fromRedactedCoreMessages(promptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
            const imageCountAtTurnEnd = countImagePartsInMessages(endOfTurnMessages);
            const shouldPersistForImageThreshold = imageCountAtTurnEnd >= IMAGE_SUMMARIZATION_TRIGGER_COUNT;
            const shouldPersist = shouldPersistForTokenThreshold || shouldPersistForImageThreshold;
            const completedPersistTriggerReason = shouldPersistForImageThreshold ? "approaching_image_limit" : isSelfSummary ? "self_summary_completed" : "threshold_met";
            if (shouldPersist) {
              if (turnState.backgroundSummarizationHasCompleted) {
                if (turnState.shouldSuppressSelfSummaryAfterInputLimitFailure(tokenUsageDetails.usedTokens)) {
                  agentLogger.info(runContext, "[summarization-discard] At end of turn, suppressing completed self-summary persistence after input-limit failure", {
                    usedTokens: tokenUsageDetails.usedTokens,
                    selfSummaryInputLimitFailureTokenCount: turnState.selfSummaryInputLimitFailureTokenCount,
                    imageCountAtTurnEnd,
                    imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                    shouldPersistForImageThreshold,
                  });
                } else {
                  agentLogger.info(runContext, "[summarization-persist] At end of turn, background summarization has completed and persistence threshold has been hit. Persisting summarization.", {
                    usedTokens: tokenUsageDetails.usedTokens,
                    maxTokens: tokenUsageDetails.maxTokens,
                    imageCountAtTurnEnd,
                    imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                    shouldPersistForImageThreshold,
                  });
                  await this.orchestrator.handleSummarization(runContext, turnState, promptExecutor, this.interactionListener, this.config, requestState, {
                    backgroundSummarizationMode: BackgroundSummarizationMode.BackgroundAndPersistIfCompleted,
                    currentInvocationId: turnState.lastStepInvocationId,
                    isToolCall: totalToolCallsInTurn > 0,
                    triggerReason: completedPersistTriggerReason,
                    resourceAccessor: this.resourceAccessor,
                  });
                }
              } else {
                const overageThreshold = Math.min(0.25 * tokenUsageDetails.maxTokens, 5e4);
                const shouldBlockForTokenOverage = tokenUsageDetails.maxTokens > 0 && tokenUsageDetails.usedTokens > tokenUsageDetails.maxTokens + overageThreshold;
                const shouldBlockForImageThreshold = shouldPersistForImageThreshold;
                if (shouldBlockForTokenOverage || shouldBlockForImageThreshold) {
                  agentLogger.info(runContext, shouldBlockForImageThreshold ? "[summarization-persist] At end of turn, blocking on background summarization before persistence because image count reached threshold" : "[summarization-persist] At end of turn, blocking on background summarization because token usage significantly exceeds max tokens", {
                    usedTokens: tokenUsageDetails.usedTokens,
                    maxTokens: tokenUsageDetails.maxTokens,
                    overageThreshold,
                    imageCountAtTurnEnd,
                    imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                    blockedForImageThreshold: shouldBlockForImageThreshold,
                    blockedForTokenOverage: shouldBlockForTokenOverage,
                  });
                  await this.orchestrator.handleSummarization(runContext, turnState, promptExecutor, this.interactionListener, this.config, requestState, {
                    backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
                    currentInvocationId: turnState.lastStepInvocationId,
                    isToolCall: totalToolCallsInTurn > 0,
                    triggerReason: shouldBlockForImageThreshold ? "approaching_image_limit" : "significantly_over_token_limit",
                    resourceAccessor: this.resourceAccessor,
                  });
                } else {
                  agentLogger.info(runContext, "[summarization-discard] At end of turn, persistence threshold is met, but we are discarding background summarization as it has not completed", {
                    usedTokens: tokenUsageDetails.usedTokens,
                    maxTokens: tokenUsageDetails.maxTokens,
                    imageCountAtTurnEnd,
                    imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                    shouldPersistForImageThreshold,
                  });
                  backgroundSummarizationDiscarded.increment(runContext, 1, { reason: "not_completed", model: backgroundSummarizationPromiseInfo.modelId });
                }
              }
            } else if (isSelfSummary) {
              agentLogger.info(runContext, "[summarization-discard] At end of turn, discarding self-summary as persistence threshold is not met", {
                usedTokens: tokenUsageDetails.usedTokens,
                maxTokens: tokenUsageDetails.maxTokens,
                imageCountAtTurnEnd,
                imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                shouldPersistForImageThreshold,
                backgroundSummarizationHasCompleted: turnState.backgroundSummarizationHasCompleted,
              });
              backgroundSummarizationDiscarded.increment(runContext, 1, { reason: "self_summary_persist_threshold_not_met", model: backgroundSummarizationPromiseInfo.modelId });
            } else {
              agentLogger.info(runContext, "[summarization-discard] At end of turn, we are discarding background summarization as persistence threshold is not met", {
                usedTokens: tokenUsageDetails.usedTokens,
                maxTokens: tokenUsageDetails.maxTokens,
                imageCountAtTurnEnd,
                imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                shouldPersistForImageThreshold,
                backgroundSummarizationConfig: this.config.backgroundSummarizationProps,
                backgroundSummarizationHasCompleted: turnState.backgroundSummarizationHasCompleted,
              });
              const completed = turnState.backgroundSummarizationHasCompleted;
              const triggerThreshold = getBackgroundSummarizationTriggerThreshold(tokenUsageDetails.maxTokens, this.config.backgroundSummarizationProps);
              let retryReason = completed ? "threshold_not_met_completed" : "threshold_not_met_not_completed";
              if (triggerThreshold !== undefined && tokenUsageDetails.usedTokens < triggerThreshold * 0.6) retryReason = "incorrectly_triggered_summarization";
              backgroundSummarizationDiscarded.increment(runContext, 1, { reason: retryReason, model: backgroundSummarizationPromiseInfo.modelId });
            }
          }
          if (hasEnded && turnState.backgroundSummarizationPromiseInfo !== null) {
            const backgroundSummarizationPromiseInfo = turnState.backgroundSummarizationPromiseInfo;
            if (turnState.backgroundSummarizationCancellationToken !== undefined) {
              turnState.backgroundSummarizationCancellationToken.cancelled = true;
            }
            backgroundSummarizationPromiseInfo.promise.catch(error => {
              agentLogger.error(runContext, "Background summarization failed", {
                error,
                summarizationMode: "unspecified",
                triggerReason: "unspecified",
                model: backgroundSummarizationPromiseInfo.modelId,
              });
            });
          }
          if (hasEnded && !madeToolCall && !hasQueuedMessages) await this.finalizePendingAgentResponseComparison(true);
          const lastTurn = await turnState.turns.at(-1)?.get(runContext);
          if (lastTurn instanceof AgentConversationTurnHandle) {
            const lastStep = await lastTurn.steps.at(-1)?.get(runContext);
            if (isSuccessfulCreatePlanStep(lastStep)) {
              agentLogger.info(runContext, "Plan created, breaking out of turn loop");
              this.responseComparisonCandidate = undefined;
              await this.cancelPendingAgentResponseComparison();
              break;
            }
          }
          if (!madeToolCall && !hasQueuedMessages) break;
          if (!this.config.doNotFailOnMaxSteps && isLastIteration) throw new Error("Reached maximum number of steps before turn ended (possible looping?)");
        } finally {
          agentStepCount.increment(runContext, 1, {});
        }
      }
      try {
        const finalTodos = await Promise.all(turnState.todos.map(todoRef => todoRef.get(runContext)));
        const unfinishedTodoCount = finalTodos.filter(todo => todo.status === "pending" || todo.status === "in_progress").length;
        if (unfinishedTodoCount > 0) {
          unfinishedTodosMetric.increment(runContext, unfinishedTodoCount);
          agentLogger.info(runContext, "Turn ended with unfinished todos", { unfinishedTodoCount });
        }
        const eventTracker = getAgentEventTracker(runContext);
        const finalTodoCount = finalTodos.length;
        eventTracker.trackUnfinishedTodos(runContext, { unfinishedTodoCount });
        if (finalTodoCount > initialTodoCount) eventTracker.trackUnfinishedTodosWhenCreatedTodos(runContext, { unfinishedTodoCount, createdTodoCount: finalTodoCount - initialTodoCount });
        if (hadUnfinishedTodosAtStart) eventTracker.trackUnfinishedTodosWhenHadUnfinishedTodosAtStart(runContext, { unfinishedTodosAtEnd: unfinishedTodoCount, unfinishedTodosAtStart });
      } catch (error) {
        agentLogger.error(runContext, "Failed to track unfinished todos metric", error);
      }
      const turnDuration = performance.now() - turnStartTime;
      agentTurnDuration.histogram(runContext, turnDuration);
      const outcomeTags = {
        newConversation: hadPreviousAssistantMessage ? "false" : "true",
        isauto: getIsAutoFromContext(runContext) ? "true" : "false",
        ispremium: getIsPremiumFromContext(runContext) ? "true" : "false",
        isinternalteam: getIsInternalTeamFromContext(runContext) ? "true" : "false",
        isuserapikey: getIsUserApiKeyFromContext(runContext) ? "true" : "false",
        issubagent: getIsSubagentFromContext(runContext) ? "true" : "false",
        autoroutingreason: getAutoRoutingReasonFromContext(runContext),
      };
      agentTurnResult.increment(runContext, 1, { outcome: "success", ...outcomeTags });
      if (finalAssistantMessageCharacterCount !== undefined) {
        try { finalAssistantMessageCharacters.histogram(runContext, finalAssistantMessageCharacterCount); } catch (error) { agentLogger.error(runContext, "Failed to record final assistant message character metric", error); }
      }
      if (finalAssistantMessageUxStats !== undefined) {
        try {
          for (const stat of FINAL_ASSISTANT_MESSAGE_UX_STAT_NAMES) finalAssistantMessageUxStatsMetric.histogram(runContext, finalAssistantMessageUxStats[stat], { stat });
        } catch (error) { agentLogger.error(runContext, "Failed to record final assistant message UX stats", error); }
      }
      await this.interactionListener.sendUpdate(runContext, RedactedUpdates.stepCompleted(turnState.getPrivacyMode(), conversationTurn.steps.length, Math.round(turnDuration)));
      if (this.config.featureFlags?.enablePromptSuggestion && this.config.modelId !== undefined) {
        try {
          const userMessageForTools = await conversationTurn.userMessage.get(runContext);
          const modeForTools = resolveCurrentStepMode(turnState.mode, slateModeFromUserMessage(userMessageForTools.mode));
          const toolSetHandleForSuggestion = toolSetGenerator({
            resourceAccessor: this.resourceAccessor,
            stateHandler: turnState,
            agentSessionId: this.config.agentSessionId,
            mcpTools: currentMcpTools,
            repositoryInfos: repositoryDetails,
            blobStore: turnState.getBlobStore(),
            mode: modeForTools,
            loggingContext: runContext,
            requestContext: requestState,
            fileOperationLockManager: fileLockManager,
            smartModeClassifierMode: this.config.smartModeClassifierMode,
            smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
            autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
          });
          const toolsForSuggestion = toAgentTools(toolSetHandleForSuggestion.getStaticTools(), toolSetHandleForSuggestion.getDescriptionProps());
          const messagesSnapshot = promptExecutor.getMessages();
          const maxInputTokenCost = this.config.featureFlags?.promptSuggestionMaxInputTokenCost;
          const costChecker = this.config.featureFlags?.getModelInputCostForContext;
          this.interactionListener.enqueuePostTurnEndedWork?.(async () => {
            try {
              await requestPromptSuggestion(runContext, getInvocationId(runContext), this.config.modelId!, promptExecutor, toUnredactedInteractionListener(this.interactionListener, turnState.getPrivacyMode()), toolsForSuggestion, messagesSnapshot, { maxInputTokenCost, getModelInputCostForContext: costChecker });
            } catch (error) { agentLogger.error(runContext, "Failed to request prompt suggestion", error); }
          });
        } catch (error) { agentLogger.error(runContext, "Failed to setup prompt suggestion", error); }
      }
      const getFeedbackRequestDetails = this.config.featureFlags?.getFeedbackRequestDetails;
      if (getFeedbackRequestDetails !== undefined && !getIsSubagentFromContext(runContext)) {
        const feedbackRequestId = getRequestId(runContext);
        if (feedbackRequestId !== undefined) {
          this.interactionListener.enqueuePostTurnEndedWork?.(async () => {
            try {
              if (!hadPreviousAssistantMessage) return;
              const feedbackRequestDetails = await getFeedbackRequestDetails({ canonicalModelName: this.config.canonicalModelName });
              if (feedbackRequestDetails === undefined) return;
              await this.interactionListener.sendUpdate(runContext, RedactedUpdates.feedbackRequest(feedbackRequestId, this.config.canonicalModelName ?? "", turnState.getPrivacyMode(), feedbackRequestDetails.categories, feedbackRequestDetails.categoryGroups ?? [], { title: feedbackRequestDetails.title, negativeTitle: feedbackRequestDetails.negativeTitle, commentPlaceholder: feedbackRequestDetails.commentPlaceholder }));
            } catch (error) { agentLogger.error(runContext, "Failed to emit feedback request", error); }
          });
        }
      }
      agentToolCallsPerTurn.histogram(runContext, totalToolCallsInTurn, { outcome: "success", ...getClientVersionMetricTagsFromContext(runContext), ...getSdkFlavorMetricTagFromContext(runContext), "user.is_dev": getIsDevFromContext(runContext) ? "true" : "false" });
      const modelName = this.config.modelId ?? "unknown";
      unifiedHandlerNumberOfToolCalls.histogram(runContext, totalToolCallsInTurn, { model: modelName, hasFailedToolCalls: turnToolCountingState.hasFailedToolCalls(), hasUnexpectedToolCallErrors: turnToolCountingState.hasUnexpectedToolCallErrors(), success: "true", errorName: "none" });
      const eventTrackerForToolCalls = getAgentEventTracker(runContext);
      eventTrackerForToolCalls.trackNumberOfToolCalls(runContext, { numberOfToolCalls: totalToolCallsInTurn, numberOfFailedToolCalls: turnToolCountingState.getFailedToolCallCount(), numberOfUnexpectedToolCallErrors: turnToolCountingState.getUnexpectedToolCallErrorCount(), success: true });
    } catch (error) {
      await this.cancelPendingAgentResponseComparison();
      const turnDuration = performance.now() - turnStartTime;
      agentTurnDuration.histogram(runContext, turnDuration);
      const outcome = runContext.signal.aborted ? "aborted" : "error";
      agentTurnResult.increment(runContext, 1, { outcome, newConversation: hadPreviousAssistantMessage ? "false" : "true", isauto: getIsAutoFromContext(runContext) ? "true" : "false", ispremium: getIsPremiumFromContext(runContext) ? "true" : "false", isinternalteam: getIsInternalTeamFromContext(runContext) ? "true" : "false", isuserapikey: getIsUserApiKeyFromContext(runContext) ? "true" : "false", issubagent: getIsSubagentFromContext(runContext) ? "true" : "false", autoroutingreason: getAutoRoutingReasonFromContext(runContext) });
      await this.interactionListener.sendUpdate(runContext, RedactedUpdates.stepCompleted(turnState.getPrivacyMode(), conversationTurn.steps.length, Math.round(turnDuration)));
      agentToolCallsPerTurn.histogram(runContext, totalToolCallsInTurn, { outcome, ...getClientVersionMetricTagsFromContext(runContext), ...getSdkFlavorMetricTagFromContext(runContext), "user.is_dev": getIsDevFromContext(runContext) ? "true" : "false" });
      const modelName = this.config.modelId ?? "unknown";
      const errorName = error instanceof Error ? error.constructor.name : "unknown";
      unifiedHandlerNumberOfToolCalls.histogram(runContext, totalToolCallsInTurn, { model: modelName, hasFailedToolCalls: turnToolCountingState.hasFailedToolCalls(), hasUnexpectedToolCallErrors: turnToolCountingState.hasUnexpectedToolCallErrors(), success: "false", errorName });
      const eventTrackerForToolCalls = getAgentEventTracker(runContext);
      eventTrackerForToolCalls.trackNumberOfToolCalls(runContext, { numberOfToolCalls: totalToolCallsInTurn, numberOfFailedToolCalls: turnToolCountingState.getFailedToolCallCount(), numberOfUnexpectedToolCallErrors: turnToolCountingState.getUnexpectedToolCallErrorCount(), success: false });
      throw error;
    }
  }

  async createCliReflectGeneralFollowUpTurn(
    runContext: Context,
    turnState: RunStepStateHandlerLike,
    _turn: RunStepTurnLike,
    reminderText: string,
    requestState: RequestContextInterop,
    publishStateUpdate: (runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<RunStepTurnLike> {
    const syntheticUserMessage = createSyntheticUserMessageInterop({
      text: reminderText,
      messageId: randomUUID(),
      isSimulatedMsg: true,
    });
    await this.interactionListener.sendUpdate(runContext, toRedactedInteractionUpdateInterop(Updates.userMessageAppended(syntheticUserMessage), turnState.getPrivacyMode()));
    const newTurn = await turnState.createAgentTurn(runContext, fromInteropUserMessage(syntheticUserMessage), requestState, this.config, this.resourceAccessor);
    if (this.config.immediatelyUpdateStateOnNewTurn) {
      if (this.config.fireAndForgetCheckpoints) {
        void turnState.computeNewStructure(runContext).then(async newState => { await publishStateUpdate(runContext, newState); }).catch(error => { agentLogger.error(runContext, "Failed to persist checkpoint after creating CLI reflect-general follow-up turn", { error }); });
      } else {
        const newState = await turnState.computeNewStructure(runContext);
        await publishStateUpdate(runContext, newState);
      }
    }
    return newTurn;
  }

  async consumeQueuedUserMessagesAndMaybeCreateNewTurns(
    runContext: Context,
    turnState: RunStepStateHandlerLike,
    currentTurn: RunStepTurnLike,
    currentMcpTools: readonly MergedRequestContextToolLike[],
    publishStateUpdate: (runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<{ readonly turn: RunStepTurnLike; readonly hasQueuedMessages: boolean; readonly mcpTools: MergedRequestContextToolLike[] }> {
    let conversationTurn = currentTurn;
    let hasQueuedMessages = false;
    let mcpToolSet = [...currentMcpTools];
    while (true) {
      const queuedAction = await this.conversationActionReceiver.peek(runContext);
      if (queuedAction?.action.case === "asyncAskQuestionCompletionAction") {
        agentLogger.warn(runContext, "Found AsyncAskQuestionCompletionAction in queue handler - should have been handled by inline handler", { originalToolCallId: queuedAction.action.value.originalToolCallId });
        break;
      }
      if (queuedAction?.action.case !== "userMessageAction") break;
      const { userMessage: queuedMsg, requestContext: queuedReqContext } = queuedAction.action.value;
      if (queuedMsg === undefined) throw new Error("User message is required");
      let consumedClaimedInjection = false;
      if (this.conversationActionReceiver.peekIsClaimedInjection?.() === true) {
        await this.conversationActionReceiver.pop(runContext);
        consumedClaimedInjection = true;
      }
      const turnMsg = await conversationTurn.userMessage.get(runContext);
      const shouldCreateNewTurn = turnMsg.messageId !== queuedMsg.messageId;
      if (!shouldCreateNewTurn || queuedReqContext === undefined) {
        agentLogger.info(runContext, "Queued user message consumption decision", { queuedMessageId: queuedMsg.messageId, currentTurnMessageId: turnMsg.messageId, decision: shouldCreateNewTurn ? "new_turn_created" : "already_has_turn", missingQueuedRequestContext: queuedReqContext === undefined, immediatelyUpdateStateOnNewTurn: this.config.immediatelyUpdateStateOnNewTurn, fireAndForgetCheckpoints: this.config.fireAndForgetCheckpoints });
      }
      if (shouldCreateNewTurn) {
        try {
          await this.interactionListener.sendUpdate(runContext, RedactedUpdates.userMessageAppended(queuedMsg));
          conversationTurn = await turnState.createAgentTurn(runContext, fromInteropUserMessage(fromRedactedUserMessageInterop(queuedMsg, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)), queuedReqContext === undefined ? createEmptyRequestContextInterop() : fromRedactedRequestContextInterop(queuedReqContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined), this.config, this.resourceAccessor);
        } catch (error) {
          if (consumedClaimedInjection) this.conversationActionReceiver.failConsumedInjectionDelivery?.();
          throw error;
        }
        hasQueuedMessages = true;
        if (this.config.immediatelyUpdateStateOnNewTurn) {
          if (this.config.fireAndForgetCheckpoints) {
            void turnState.computeNewStructure(runContext).then(async newState => { await publishStateUpdate(runContext, newState); }).catch(error => { agentLogger.error(runContext, "Failed to persist checkpoint after creating queued turn", { error }); });
          } else {
            const newState = await turnState.computeNewStructure(runContext);
            await publishStateUpdate(runContext, newState);
          }
        }
      }
      if (!consumedClaimedInjection) await this.conversationActionReceiver.pop(runContext);
      const unredactedTools = queuedReqContext?.tools?.map(executableTool => fromRedactedMcpToolDefinitionInterop(executableTool, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)) ?? [];
      mcpToolSet = this.mergeRequestContextTools(currentMcpTools, unredactedTools);
    }
    return { turn: conversationTurn, hasQueuedMessages, mcpTools: mcpToolSet };
  }

  async shouldInjectCliReflectGeneralFollowUp(
    runContext: Context,
    turnState: SummarizationStateHandler,
    conversationTurn: SetupStepTurnLike,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: readonly unknown[],
    repositoryDetails: readonly unknown[],
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
  ): Promise<boolean> {
    if (this.config.featureFlags?.enableCliReflectGeneralTool !== true) {
      return false;
    }
    const promptUserMessage = await conversationTurn.userMessage.get(runContext);
    const mode = resolveCurrentStepMode(turnState.mode, slateModeFromUserMessage(promptUserMessage.mode));
    return toolSetGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler: turnState,
      agentSessionId: this.config.agentSessionId,
      mcpTools: mcpToolSet,
      repositoryInfos: repositoryDetails,
      blobStore: turnState.getBlobStore(),
      mode,
      loggingContext: runContext,
      requestContext: requestState,
      fileOperationLockManager: fileLockManager,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    }).hasTool("REFLECT_GENERAL");
  }

  async maybeInjectPreFinalConflictBarrier(
    runContext: Context,
    promptExecutor: RetryRootPromptExecutorLike,
    privacySetting: PrivacyMode,
  ): Promise<boolean> {
    let executor: Parameters<typeof conflictNoticeSyncAndPeek>[0] | undefined;
    try {
      executor = (this.resourceAccessor as {
        get(resource: typeof agentStoreConflictNoticeExecutorResource): Parameters<typeof conflictNoticeSyncAndPeek>[0] | undefined;
      }).get(agentStoreConflictNoticeExecutorResource);
    } catch {
      executor = undefined;
    }
    if (executor === undefined) {
      return false;
    }
    const isAbortSignalAborted = () => runContext.signal?.aborted === true;
    if (isAbortSignalAborted()) {
      return false;
    }
    const releaseConflictNoticeEvents = async (eventIds: readonly string[]) => {
      if (eventIds.length === 0) {
        return;
      }
      try {
        await conflictNoticeRelease(executor, runContext, eventIds, this.config.conversationId !== undefined ? { conversationId: this.config.conversationId } : undefined);
      } catch (releaseError) {
        agentLogger.warn(runContext, "Conflict barrier release failed", { error: releaseError });
      }
    };
    try {
      const stepResult = await conflictNoticeSyncAndPeek(executor, runContext, {
        ...(this.config.conversationId !== undefined ? { conversationId: this.config.conversationId } : {}),
      }) as ConflictNoticeSyncAndPeekResultLike;
      const timedOut = stepResult.kind === "timed-out" ? "true" : "false";
      if (stepResult.kind === "mount-passive") {
        agentStoreConflictBarrier.increment(runContext, 1, { outcome: "mount_passive", timed_out: timedOut });
        return false;
      }
      const reminder = stepResult.kind === "completed" || stepResult.kind === "timed-out" ? stepResult.reminder : undefined;
      const eventIds = stepResult.kind === "completed" || stepResult.kind === "timed-out" ? stepResult.events.map(streamEvent => streamEvent.eventId) : [];
      if (isAbortSignalAborted()) {
        await releaseConflictNoticeEvents(eventIds);
        return false;
      }
      if (reminder === undefined || reminder.length === 0) {
        agentStoreConflictBarrier.increment(runContext, 1, { outcome: "checked", timed_out: timedOut });
        return false;
      }
      const sanitizedReminder = sanitizeSystemReminderContent(reminder);
      try {
        promptExecutor.appendMessages(toRedactedCoreMessages([
          {
            role: "user",
            content: `<system_reminder>\n${sanitizedReminder}\n</system_reminder>`,
          },
        ], privacySetting));
      } catch (error) {
        await releaseConflictNoticeEvents(eventIds);
        throw error;
      }
      try {
        await conflictNoticeAck(executor, runContext, eventIds, this.config.conversationId !== undefined ? { conversationId: this.config.conversationId } : undefined);
      } catch (error) {
        agentLogger.warn(runContext, "Conflict barrier ack failed", { error });
        await releaseConflictNoticeEvents(eventIds);
      }
      agentStoreConflictBarrier.increment(runContext, 1, { outcome: "rescued", timed_out: timedOut });
      agentLogger.info(runContext, "Local-sync conflict turn-end barrier injected", {
        eventCount: eventIds.length,
        timedOut: stepResult.kind === "timed-out",
      });
      return true;
    } catch (error) {
      agentStoreConflictBarrier.increment(runContext, 1, { outcome: "error", timed_out: "false" });
      agentLogger.warn(runContext, "Conflict turn-end barrier failed", { error });
      return false;
    }
  }

  mergeRequestContextTools(
    existingTools: readonly MergedRequestContextToolLike[],
    requestContextTools: readonly RequestContextToolInputLike[],
  ): MergedRequestContextToolLike[] {
    const mergedTools = [...existingTools];
    for (const maybeRedTool of requestContextTools) {
      const executableTool = "_privacyMode" in maybeRedTool
        ? fromRedactedMcpToolDefinitionInterop(maybeRedTool, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)
        : maybeRedTool;
      const exists = mergedTools.some((t) => t.name === executableTool.name);
      if (!exists) {
        mergedTools.push({
          name: executableTool.name,
          providerIdentifier: executableTool.providerIdentifier,
          toolName: executableTool.toolName,
          description: executableTool.description,
          inputSchema: mcpInputSchemaToJson(executableTool),
          clientKey: executableTool.providerIdentifier,
        });
      }
    }
    return mergedTools;
  }

  async executeStepWithMetrics(
    runContext: Context,
    conversationTurn: SetupStepTurnLike,
    executors: StepExecutorsLike,
    turnState: SummarizationStateHandler & RetryStateHandlerLike,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: readonly unknown[],
    repositoryDetails: readonly unknown[],
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
    publishStateUpdate: ((runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
    previousQueuedMessageSource?: unknown,
    emptyResponseRetryTurnBudget?: EmptyResponseRetryTurnBudgetLike,
  ): Promise<StepResultLike & {
    readonly stepToolCountingState: ToolCountingStateTracker;
    readonly toolCallIdentityResolver: ToolSetHandle;
  }> {
    const { result: stepResult, stepToolCountingState, toolCallIdentityResolver } = await this.executeStepWithCommonMetrics(
      runContext,
      conversationTurn,
      executors,
      turnState,
      toolSetGenerator,
      mcpToolSet,
      repositoryDetails,
      requestState,
      fileLockManager,
      (innerCtx, wrappedPromptExecutor, maxOutputTokenRetryDebug) => this.runStep(
        innerCtx,
        conversationTurn as RunStepTurnLike,
        wrappedPromptExecutor,
        turnState as unknown as RunStepStateHandlerLike,
        toolSetGenerator,
        mcpToolSet as PromptTokenTrackingParamsLike["mcpTools"],
        repositoryDetails,
        requestState,
        fileLockManager,
        publishStateUpdate,
        previousQueuedMessageSource,
        maxOutputTokenRetryDebug,
      ),
      emptyResponseRetryTurnBudget,
    );
    return {
      ...stepResult,
      stepToolCountingState,
      toolCallIdentityResolver,
    };
  }

  async buildStepSummarizationContext(
    runContext: Context,
    conversationTurn: SetupStepTurnLike,
    turnState: SummarizationStateHandler,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: readonly unknown[],
    repositoryDetails: readonly unknown[],
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
  ): Promise<{
    readonly tools: ReturnType<ToolSetHandle["getStaticTools"]>;
    readonly extraT: UnknownRecord;
    readonly descriptionProps: ReturnType<ToolSetHandle["getDescriptionProps"]>;
    readonly toolCallIdentityResolver: ToolSetHandle;
  }> {
    const promptUserMessage = await conversationTurn.userMessage.get(runContext);
    const mode = resolveCurrentStepMode(turnState.mode, slateModeFromUserMessage(promptUserMessage.mode));
    const toolSetLease = toolSetGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler: turnState,
      agentSessionId: this.config.agentSessionId,
      mcpTools: mcpToolSet,
      repositoryInfos: repositoryDetails,
      blobStore: turnState.getBlobStore(),
      mode,
      loggingContext: runContext,
      requestContext: requestState,
      fileOperationLockManager: fileLockManager,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    });
    const executableTools = toolSetLease.getStaticTools();
    const userAutoRunInstructions = await this.getUserPermissionsFileAutoRunInstructions(runContext, requestState);
    const projectAutoRunInstructions = this.getProjectPermissionsFileAutoRunInstructions(requestState);
    const extraTools = {
      repositoryInfos: repositoryDetails,
      shouldQueryProd: requestState.repositoryInfoShouldQueryProd,
      stateHandler: turnState,
      enableToolArgPreservation: this.config.enableToolArgPreservation === true,
      enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
      enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
      enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
      writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
      onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
      workspacePaths: requestState.env?.workspacePaths,
      userAutoRunInstructions,
      projectAutoRunInstructions,
      cursorRules: getAllRules(requestState, this.config.nonFileRules, this.config.featureFlags),
      agentSkills: requestState.agentSkills ?? [],
      contextInjectionSignal: this.conversationActionReceiver.getContextInjectionToolSignal?.(),
    };
    return {
      tools: executableTools,
      extraT: extraTools,
      descriptionProps: toolSetLease.getDescriptionProps(),
      toolCallIdentityResolver: toolSetLease,
    };
  }

  recordStepToolCallMetrics(runContext: Context, stepToolCountingState: StepToolCountingStateLike): void {
    const baseParallelToolCallTags = {
      hasFailedToolCalls: stepToolCountingState.hasFailedToolCalls(),
      hasUnexpectedToolCallErrors: stepToolCountingState.hasUnexpectedToolCallErrors(),
      success: "true",
      errorName: "none",
    };
    numberOfParallelToolCalls.histogram(runContext, stepToolCountingState.toolCallCount, baseParallelToolCallTags);
    if (stepToolCountingState.toolCallCount > 0) {
      numberOfParallelToolCallsWithAtLeastOneCall.histogram(runContext, stepToolCountingState.toolCallCount, {
        ...baseParallelToolCallTags,
        ...getClientVersionMetricTagsFromContext(runContext),
        "user.is_dev": getIsDevFromContext(runContext) ? "true" : "false",
      });
    }
  }

  async executeStepWithCommonMetrics<T>(
    runContext: Context,
    conversationTurn: SetupStepTurnLike,
    executors: StepExecutorsLike,
    turnState: SummarizationStateHandler & RetryStateHandlerLike,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: readonly unknown[],
    repositoryDetails: readonly unknown[],
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
    runStep: (
      runContext: Context,
      wrappedPromptExecutor: RetryRootPromptExecutorLike,
      maxOutputTokenRetryDebug: MaxOutputTokenRetryDebugLike,
    ) => Promise<T>,
    emptyResponseRetryTurnBudget: EmptyResponseRetryTurnBudgetLike | undefined,
  ): Promise<{
    readonly result: T;
    readonly stepToolCountingState: ToolCountingStateTracker;
    readonly tools: ReturnType<ToolSetHandle["getStaticTools"]>;
    readonly toolCallIdentityResolver: ToolSetHandle;
  }> {
    const stepToolCountingState = new ToolCountingStateTracker();
    const stepToolCountingMiddleware = createToolCountingMiddleware(stepToolCountingState);
    const stepWrappedExecutor = stepToolCountingMiddleware(executors.wrappedPromptExecutor);
    const { tools: executableTools, extraT: extraTools, descriptionProps, toolCallIdentityResolver } = await this.buildStepSummarizationContext(
      runContext,
      conversationTurn,
      turnState,
      toolSetGenerator,
      mcpToolSet,
      repositoryDetails,
      requestState,
      fileLockManager,
    );
    const stepResult = await this.runWithSummarizationRetry(
      runContext,
      turnState,
      executors.rootPromptExecutor,
      requestState,
      executableTools,
      extraTools,
      descriptionProps,
        innerCtx => this.runWithMaxTokensRetry(
          innerCtx,
          executors.rootPromptExecutor,
          (retryCtx, maxOutputTokenRetryDebug) => runStep(
            retryCtx,
            stepWrappedExecutor as unknown as RetryRootPromptExecutorLike,
            maxOutputTokenRetryDebug,
          ),
          emptyResponseRetryTurnBudget,
        ),
    );
    this.recordStepToolCallMetrics(runContext, stepToolCountingState);
    return {
      result: stepResult,
      stepToolCountingState,
      tools: executableTools,
      toolCallIdentityResolver,
    };
  }

  async applyPostStepProcessing(
    runContext: Context,
    conversationTurn: PostStepTurnLike,
    promptExecutor: RetryRootPromptExecutorLike,
    turnState: RunStepStateHandlerLike,
    madeToolCall: boolean,
    modelMessages: CoreMessageLike[],
    publishStateUpdate: (runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>,
    grindRebuildParams: {
      readonly requestContext: RequestContextInterop;
      readonly toolsGenerator: AgentToolsGenerator;
      readonly repositoryInfo: readonly unknown[];
      readonly mcpTools: readonly unknown[];
      readonly fileOperationLockManager: FileOperationLockManager;
    },
  ): Promise<void> {
    if (madeToolCall && this.config.reminders && this.config.reminders.length > 0) {
      const currentTodos = await Promise.all(turnState.todos.map((todo) => todo.get(runContext)));
      turnState.assertRootPromptBlobsLoadedForFullPromptRead();
      const conversationMessages = fromRedactedCoreMessages(promptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
      await applyRemindersToToolResults(
        modelMessages,
        this.config.reminders,
        currentTodos.map(slateTodoItemWithReadableContent),
        conversationMessages,
      );
    }
    if (shouldExposeToolReferencesInCurrentContext(runContext)) {
      attachToolReferenceHints(modelMessages);
    }
    conversationTurn.appendPromptMessages(toRedactedCoreMessages(modelMessages, turnState.getPrivacyMode()));
    if (this.config.messageHistoryModifier) {
      turnState.assertRootPromptBlobsLoadedForFullPromptRead();
      const currentMessages = fromRedactedCoreMessages(promptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
      const modifiedHistory = this.config.messageHistoryModifier(currentMessages);
      if (modifiedHistory) {
        turnState.invalidateRootPromptPrefix();
        promptExecutor.clearMessages();
        promptExecutor.appendMessages(toRedactedCoreMessages(modifiedHistory, turnState.getPrivacyMode()));
      }
    }
    const grindPhaseOverride = getGrindPhaseOverrideFromResponse(modelMessages);
    if (grindPhaseOverride !== undefined && grindRebuildParams) {
      const { requestContext: requestState, toolsGenerator: toolSetGenerator, repositoryInfo: repositoryDetails, mcpTools: mcpToolSet, fileOperationLockManager: fileLockManager } = grindRebuildParams;
      const promptUserMessage = await conversationTurn.userMessage.get(runContext);
      const mode = resolveCurrentStepMode(turnState.mode, slateModeFromUserMessage(promptUserMessage.mode));
      const toolSetLease = toolSetGenerator({
        resourceAccessor: this.resourceAccessor,
        stateHandler: turnState,
        agentSessionId: this.config.agentSessionId,
        mcpTools: mcpToolSet,
        repositoryInfos: repositoryDetails,
        blobStore: turnState.getBlobStore(),
        mode,
        loggingContext: runContext,
        requestContext: requestState,
        fileOperationLockManager: fileLockManager,
        smartModeClassifierMode: this.config.smartModeClassifierMode,
        smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
        autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
        grindMode: { phase: grindPhaseOverride },
      } as Parameters<AgentToolsGenerator>[0]);
      turnState.assertRootPromptBlobsLoadedForFullPromptRead();
      const messagesWithoutSystemPrompt = promptExecutor.getMessages().filter((turnMessage) => turnMessage.role !== "system");
      turnState.invalidateRootPromptPrefix();
      promptExecutor.clearMessages();
      promptExecutor.appendMessages(toRedactedCoreMessages([
        {
          role: "system",
          content: this.config.systemPromptGenerator({
            requestContext: requestState,
            cursorRules: getAllRules(requestState, this.config.nonFileRules, this.config.featureFlags),
            env: requestState.env,
            browserTools: getBrowserToolNames(mcpToolSet as Parameters<typeof getBrowserToolNames>[0]),
            cloudRule: requestState.cloudRule,
            mode,
            grindMode: { phase: grindPhaseOverride },
          }, toolSetLease),
        },
      ], turnState.getPrivacyMode()));
      promptExecutor.appendMessages(messagesWithoutSystemPrompt);
    }
    if (this.config.fireAndForgetCheckpoints) {
      void turnState.computeNewStructure(runContext).then(async (currentState) => {
        await publishStateUpdate(runContext, currentState);
      }).catch((error) => {
        agentLogger.error(runContext, "Failed to persist checkpoint after step", { error });
      });
    } else {
      const currentState = await turnState.computeNewStructure(runContext);
      await publishStateUpdate(runContext, currentState);
    }
  }

  async setupStep(
    runContext: Context,
    turnState: SetupStepStateHandlerLike,
    conversationTurn: SetupStepTurnLike,
  ): Promise<{ readonly fileOperationLockManager: FileOperationLockManager }> {
    const promptUserMessage = await conversationTurn.userMessage.get(runContext);
    if (turnState.mode === void 0) {
      turnState.setMode(resolveCurrentTurnMode(turnState.mode, slateModeFromUserMessage(promptUserMessage.mode)));
    }
    const fileLockManager = new FileOperationLockManager();
    return { fileOperationLockManager: fileLockManager };
  }

  async runSingleStep(
    parentCtx: Context,
    promptExecutor: RetryRootPromptExecutorLike,
    turnState: RunStepStateHandlerLike,
    conversationTurn: RunStepTurnLike,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: PromptTokenTrackingParamsLike["mcpTools"],
    repositoryDetails: readonly unknown[],
    requestState: RequestContextInterop,
    publishStateUpdate: (runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<{ readonly hasToolCall: boolean }> {
    using span = createSpan(parentCtx.withName("runSingleStep"));
    const runContext = span.ctx;
    const { fileOperationLockManager: fileLockManager } = await this.setupStep(runContext, turnState as unknown as SetupStepStateHandlerLike, conversationTurn);
    try {
      const { hasToolCall: madeToolCall, responseMessages: modelMessages } = await this.executeStepWithMetrics(
        runContext,
        conversationTurn,
        {
          wrappedPromptExecutor: promptExecutor as unknown as ToolCountingExecutorLike,
          rootPromptExecutor: promptExecutor,
        },
        turnState as unknown as SummarizationStateHandler & RetryStateHandlerLike,
        toolSetGenerator,
        mcpToolSet,
        repositoryDetails,
        requestState,
        fileLockManager,
        publishStateUpdate,
      );
      await this.applyPostStepProcessing(runContext, conversationTurn, promptExecutor, turnState, madeToolCall, modelMessages as CoreMessageLike[], publishStateUpdate, {
        requestContext: requestState,
        toolsGenerator: toolSetGenerator,
        repositoryInfo: repositoryDetails,
        mcpTools: mcpToolSet,
        fileOperationLockManager: fileLockManager,
      });
      return { hasToolCall: madeToolCall };
    } finally {
      agentStepCount.increment(runContext, 1, {});
    }
  }

  async buildToolExecutionContext(
    runContext: Context,
    turnState: SplitStepStateMutationTarget,
    toolCallRecorder: SplitStepToolCallRecorderLike,
    mcpToolSet: readonly unknown[],
    repositoryDetails: readonly unknown[],
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
    allowedToolNames: ReadonlySet<string> | undefined,
    admittedEffectiveToolName: string | undefined,
  ): Promise<ToolExecutionContextLike> {
    const callInvocationId = getInvocationId(runContext);
    if (turnState.mode === undefined) {
      throw new Error("stateHandler.mode must be set before building tool execution context");
    }
    const mode = turnState.mode;
    const toolSetLease = this.config.toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler: turnState,
      agentSessionId: this.config.agentSessionId,
      mcpTools: mcpToolSet,
      repositoryInfos: repositoryDetails,
      blobStore: turnState.getBlobStore(),
      mode,
      loggingContext: runContext,
      requestContext: requestState,
      fileOperationLockManager: fileLockManager,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    });
    const modelVisibleTools = toolSetLease.getStaticTools();
    const scopedModelVisibleTools = allowedToolNames === undefined
      ? modelVisibleTools
      : modelVisibleTools.filter(executableTool => allowedToolNames.has(executableTool.name) || executableTool.name === admittedEffectiveToolName);
    const toolExecutionSet = toolSetLease.getToolExecutionSet(scopedModelVisibleTools);
    const executableTools = getExecutableTools(toolExecutionSet);
    const directDynamicToolNames = getDirectDynamicToolNames(toolExecutionSet);
    const toolMap: Record<string, DeferredExecutableToolLike> = {};
    for (const executableTool of executableTools) {
      if (!isDeferredExecutableTool(executableTool)) {
        throw new Error("Executable tool is missing name or toolIdentifier");
      }
      toolMap[executableTool.name] = executableTool;
    }
    const renderProps = {
      allTools: extractToolMetadataMap(executableTools),
    };
    const userAutoRunInstructions = await this.getUserPermissionsFileAutoRunInstructions(runContext, requestState);
    const projectAutoRunInstructions = this.getProjectPermissionsFileAutoRunInstructions(requestState);
    const extraTools: UnknownRecord = {
      repositoryInfos: repositoryDetails,
      shouldQueryProd: requestState.repositoryInfoShouldQueryProd,
      stateHandler: turnState,
      strictArgParsing: this.config.strictArgParsing === true,
      enableToolArgPreservation: this.config.enableToolArgPreservation === true,
      enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
      enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
      enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
      writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
      onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
      workspacePaths: requestState.env?.workspacePaths,
      userAutoRunInstructions,
      projectAutoRunInstructions,
      cursorRules: getAllRules(requestState, this.config.nonFileRules, this.config.featureFlags),
      agentSkills: requestState.agentSkills ?? [],
      contextInjectionSignal: this.conversationActionReceiver.getContextInjectionToolSignal?.(),
    };
    const interactionHandler = new InteractionHandler(
      toUnredactedInteractionListener(this.interactionListener, turnState.getPrivacyMode()),
      toolCallRecorder,
      callInvocationId,
      undefined,
      this.config.thinkingStyle,
      this.config.featureFlags?.nalLoopDetection === true,
      this.createAfterAgentThoughtCallback(callInvocationId, requestState),
    );
    return {
      toolMap,
      interactionHandler,
      extraT: extraTools,
      renderProps,
      directDynamicToolNames,
      recordToolCallResult: interactionHandler.recordToolCallResult.bind(interactionHandler),
    };
  }

  async buildDeferredToolExecutionContext(
    runContext: Context,
    descriptor: NativeToolCallDescriptor,
    turnState: SplitStepStateMutationTarget,
    mcpToolSet: readonly MergedRequestContextToolLike[],
    splitStepData: DeferredSplitStepDataLike,
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
    logMessage: string,
  ): Promise<ToolExecutionContextLike & { readonly stateOps: readonly SplitStepStateOp[] }> {
    const lastTurnRef = turnState.turns.at(-1);
    if (lastTurnRef === undefined) {
      throw new Error("No turns in conversation state");
    }
    const conversationTurn = await lastTurnRef.get(runContext);
    if (!(conversationTurn instanceof AgentConversationTurnHandle)) {
      throw new Error("Expected last turn to be an agent turn");
    }
    const { stateHandler: splitStateHandler, toolCallRecorder, stateOps: stateOperations } = createSplitStepStateHandler(turnState, conversationTurn);
    const allowedToolNames = splitStepData.allowedToolNames === undefined
      ? undefined
      : new Set(splitStepData.allowedToolNames);
    const admittedEffectiveToolName = getAdmittedEffectiveToolName(descriptor, allowedToolNames);
    const mergedMcpTools = this.mergeRequestContextTools(mcpToolSet, requestState.tools);
    const executionContext = await this.buildToolExecutionContext(
      runContext,
      splitStateHandler,
      toolCallRecorder,
      mergedMcpTools,
      requestState.repositoryInfo,
      requestState,
      fileLockManager,
      allowedToolNames,
      admittedEffectiveToolName,
    );
    if (
      allowedToolNames !== undefined &&
      !allowedToolNames.has(descriptor.toolName) &&
      !executionContext.directDynamicToolNames.has(getEffectiveToolCallName(descriptor))
    ) {
      agentLogger.warn(runContext, logMessage, {
        toolCallId: descriptor.toolCallId,
        toolName: descriptor.toolName,
        allowedToolCount: allowedToolNames.size,
      });
    }
    splitStepData.stepReadPathDedup ??= new Set();
    executionContext.extraT.stepReadPathDedup = splitStepData.stepReadPathDedup;
    return {
      stateOps: stateOperations,
      ...executionContext,
    };
  }

  async runModelStep(
    parentCtx: Context,
    promptExecutor: RetryRootPromptExecutorLike,
    turnState: RunStepStateHandlerLike,
    conversationTurn: RunStepTurnLike,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: PromptTokenTrackingParamsLike["mcpTools"],
    repositoryDetails: readonly unknown[],
    requestState: RequestContextInterop,
    publishStateUpdate: ((runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
  ): Promise<{
    readonly toolCallDescriptors: readonly unknown[];
    readonly splitStepData: {
      readonly modelResponseMessages: readonly CoreMessageLike[];
      readonly requestContext: RequestContextInterop;
      readonly allowedToolNames: readonly string[];
    };
  }> {
    using span = createSpan(parentCtx.withName("runModelStep"));
    const runContext = span.ctx;
    const { fileOperationLockManager: fileLockManager } = await this.setupStep(runContext, turnState as unknown as SetupStepStateHandlerLike, conversationTurn);
    const { toolCallDescriptors: toolCallSpecs, responseMessages: modelMessages, availableToolNames } = await this.executeModelStepWithMetrics(
      runContext,
      conversationTurn,
      {
        wrappedPromptExecutor: promptExecutor as unknown as ToolCountingExecutorLike,
        rootPromptExecutor: promptExecutor,
      },
      turnState as unknown as SummarizationStateHandler & RetryStateHandlerLike,
      toolSetGenerator,
      mcpToolSet,
      repositoryDetails,
      requestState,
      fileLockManager,
      publishStateUpdate,
    );
    return {
      toolCallDescriptors: toolCallSpecs,
      splitStepData: {
        modelResponseMessages: modelMessages,
        requestContext: requestState,
        allowedToolNames: availableToolNames,
      },
    };
  }

  async executeToolCall(
    runContext: Context,
    descriptor: NativeToolCallDescriptor,
    turnState: SplitStepStateMutationTarget,
    mcpToolSet: readonly MergedRequestContextToolLike[],
    splitStepData: DeferredSplitStepDataLike,
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
  ): Promise<{
    readonly toolCallId: string;
    readonly resultMessage: Record<string, unknown>;
    readonly stateOps: readonly SplitStepStateOp[];
  }> {
    const {
      stateOps: stateOperations,
      toolMap,
      interactionHandler,
      extraT: extraTools,
      recordToolCallResult,
      renderProps,
      directDynamicToolNames,
    } = await this.buildDeferredToolExecutionContext(
      runContext,
      descriptor,
      turnState,
      mcpToolSet,
      splitStepData,
      requestState,
      fileLockManager,
      "Rejected deferred split-step tool call outside model-visible tool allowlist",
    );
    const rawResultMessage = await executeDeferredToolCall(
      runContext,
      descriptor,
      toolMap,
      interactionHandler,
      extraTools,
      recordToolCallResult,
      renderProps,
      undefined,
      undefined,
      directDynamicToolNames,
    );
    if (!isCoreMessageLike(rawResultMessage)) {
      throw new Error("Deferred tool executor returned an invalid tool result message");
    }
    return {
      toolCallId: descriptor.toolCallId,
      resultMessage: rawResultMessage,
      stateOps: stateOperations,
    };
  }

  async prepareSubagent(
    runContext: Context,
    descriptor: NativeToolCallDescriptor,
    turnState: SplitStepStateMutationTarget,
    mcpToolSet: readonly MergedRequestContextToolLike[],
    splitStepData: DeferredSplitStepDataLike,
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
  ): Promise<unknown> {
    const { toolMap, extraT: extraTools } = await this.buildDeferredToolExecutionContext(
      runContext,
      descriptor,
      turnState,
      mcpToolSet,
      splitStepData,
      requestState,
      fileLockManager,
      "Rejected deferred split-step subagent preparation outside model-visible tool allowlist",
    );
    const effectiveToolName = getEffectiveToolCallName(descriptor);
    const executableTool = toolMap[effectiveToolName];
    if (executableTool === undefined) {
      throw new Error(`Tool not found: ${effectiveToolName}`);
    }
    if (executableTool.prepareSubagent === undefined) {
      throw new Error(`Tool does not support subagent preparation: ${effectiveToolName}`);
    }
    return await executableTool.prepareSubagent(runContext, getEffectiveToolCallArgs(descriptor), {
      toolCallId: descriptor.toolCallId,
      ...extraTools,
    });
  }

  async finalizeStep(
    parentCtx: Context,
    splitStepData: { readonly modelResponseMessages: readonly CoreMessageLike[] },
    toolCallResults: readonly DeferredToolCallResultLike[],
    promptExecutor: RetryRootPromptExecutorLike,
    turnState: RunStepStateHandlerLike & SplitStepStateMutationTarget,
    mcpToolSet: readonly MergedRequestContextToolLike[],
    requestState: RequestContextInterop,
    publishStateUpdate: (runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<{ readonly state: { pendingToolCalls: unknown[] }; readonly hasToolCall: boolean }> {
    using span = createSpan(parentCtx.withName("finalizeStep"));
    const runContext = span.ctx;
    const lastTurnRef = turnState.turns[turnState.turns.length - 1];
    if (lastTurnRef === undefined) {
      return {
        state: await turnState.computeNewStructure(runContext),
        hasToolCall: false,
      };
    }
    const conversationTurn = await lastTurnRef.get(runContext);
    if (!(conversationTurn instanceof AgentConversationTurnHandle)) {
      throw new Error("Expected last turn to be an agent turn");
    }
    const fileLockManager = new FileOperationLockManager();
    const modelMessages: CoreMessageLike[] = [
      ...splitStepData.modelResponseMessages,
      ...toolCallResults.map(stepResult => stepResult.resultMessage),
    ];
    const madeToolCall = toolCallResults.length > 0;
    for (const stateOperation of toolCallResults.flatMap(stepResult => stepResult.stateOps ?? [])) {
      await applyConversationStateOp(runContext, turnState, conversationTurn, stateOperation);
    }
    const mergedMcpTools = this.mergeRequestContextTools(mcpToolSet, requestState.tools);
    try {
      await this.applyPostStepProcessing(
        runContext,
        conversationTurn,
        promptExecutor,
        turnState,
        madeToolCall,
        modelMessages,
        publishStateUpdate,
        {
          requestContext: requestState,
          toolsGenerator: this.config.toolsGenerator,
          repositoryInfo: requestState.repositoryInfo,
          mcpTools: mergedMcpTools,
          fileOperationLockManager: fileLockManager,
        },
      );
      const turnStatus = await turnState.computeNewStructure(runContext);
      return { state: turnStatus, hasToolCall: madeToolCall };
    } finally {
      agentStepCount.increment(runContext, 1, {});
    }
  }

  async executeModelStepWithMetrics(
    runContext: Context,
    conversationTurn: RunStepTurnLike,
    executors: StepExecutorsLike,
    turnState: SummarizationStateHandler & RetryStateHandlerLike,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: readonly unknown[],
    repositoryDetails: readonly unknown[],
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
    publishStateUpdate: ((runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
  ): Promise<ModelOnlyStepResultLike & { readonly availableToolNames: readonly string[] }> {
    const { result: stepResult, tools: executableTools } = await this.executeStepWithCommonMetrics(
      runContext,
      conversationTurn,
      executors,
      turnState,
      toolSetGenerator,
      mcpToolSet,
      repositoryDetails,
      requestState,
      fileLockManager,
      (innerCtx, wrappedPromptExecutor) => this.runModelOnlyStep(
        innerCtx,
        conversationTurn,
        wrappedPromptExecutor,
        turnState as unknown as RunStepStateHandlerLike,
        toolSetGenerator,
        mcpToolSet as PromptTokenTrackingParamsLike["mcpTools"],
        repositoryDetails,
        requestState,
        fileLockManager,
        publishStateUpdate,
      ),
      undefined,
    );
    return {
      ...stepResult,
      availableToolNames: executableTools.map(executableTool => executableTool.name),
    };
  }

  async runModelOnlyStep(
    parentCtx: Context,
    conversationTurn: RunStepTurnLike,
    promptExecutor: RetryRootPromptExecutorLike,
    turnState: RunStepStateHandlerLike,
    toolSetGenerator: AgentToolsGenerator,
    mcpToolSet: PromptTokenTrackingParamsLike["mcpTools"],
    repositoryInfos: readonly unknown[],
    requestState: RequestContextInterop,
    fileLockManager: FileOperationLockManager,
    publishStateUpdate: ((runContext: Context, turnStatus: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
  ): Promise<ModelOnlyStepResultLike> {
    using spanCtxt = createSpan(parentCtx.withName("runModelOnlyStep"));
    const runContext = spanCtxt.ctx;
    const callInvocationId = getInvocationId(runContext);
    turnState.lastStepInvocationId = callInvocationId;
    spanCtxt.span.setAttribute("invocationId", callInvocationId);
    agentLogger.info(runContext, "Running model-only step");
    const stepSetupStart = performance.now();
    const isFirstStep = conversationTurn.steps.length === 0;
    const isResponseComparisonFirstModelStep = !this.responseComparisonModelStepStarted;
    this.responseComparisonModelStepStarted = true;
    const interactionHandler = new InteractionHandler(
      toUnredactedInteractionListener(this.interactionListener, turnState.getPrivacyMode()),
      conversationTurn,
      callInvocationId,
      undefined,
      this.config.thinkingStyle,
      this.config.featureFlags?.nalLoopDetection === true,
      this.createAfterAgentThoughtCallback(callInvocationId, requestState),
    );
    const promptUserMessage = await conversationTurn.userMessage.get(runContext);
    const mode = resolveCurrentStepMode(turnState.mode, slateModeFromUserMessage(promptUserMessage.mode));
    const toolSetLease = toolSetGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler: turnState,
      agentSessionId: this.config.agentSessionId,
      mcpTools: mcpToolSet,
      repositoryInfos,
      blobStore: turnState.getBlobStore(),
      mode,
      loggingContext: runContext,
      requestContext: requestState,
      fileOperationLockManager: fileLockManager,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    });
    const initialMessages = fromRedactedCoreMessages(promptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    if (isFirstStep) {
      warnIfLongTrailingUserMessageRun(runContext, initialMessages as Parameters<typeof warnIfLongTrailingUserMessageRun>[1], callInvocationId);
      firstStepSetupDuration.histogram(runContext, performance.now() - stepSetupStart);
    }
    trackPromptTokenUsage({
      ctx: runContext,
      mcpTools: mcpToolSet,
      requestContext: requestState,
      messages: initialMessages,
      selectedContext: promptUserMessage.selectedContext,
      userInfoDisplayOptions: this.config.userInfoDisplayOptions,
      agentTokenLimit: this.config.agentTokenLimit,
      readToolName: toolSetLease.getTool("READ")?.name,
      invocationId: callInvocationId,
      modelInfo: this.config.modelInfo,
      featureFlags: this.config.featureFlags,
      stateHandler: turnState,
    });
    let responseComparisonMessages = this.config.agentResponseComparison === undefined ? undefined : [...initialMessages];
    let responseComparisonTools = this.config.agentResponseComparison === undefined
      ? undefined
      : Object.freeze(toAgentTools(toolSetLease.getStaticTools(), toolSetLease.getDescriptionProps()));
    if (isResponseComparisonFirstModelStep && responseComparisonMessages !== undefined && responseComparisonTools !== undefined) {
      await this.preparePendingAgentResponseComparison({
        ctx: runContext,
        parentInvocationId: callInvocationId,
        messages: responseComparisonMessages,
        tools: responseComparisonTools,
        privacyMode: turnState.getPrivacyMode(),
      });
    }
    let stepResult: ModelOnlyStreamResultLike;
    try {
      result: stepResult  = promptExecutor.executeModelStreamOnly(
        runContext,
        turnState,
        interactionHandler,
        toolSetLease.getToolExecutionSet(),
        toolSetLease.getDescriptionProps(),
        undefined,
      );
    } catch (error) {
      await this.cancelPendingAgentResponseComparison();
      throw error;
    }
    const isCloudAgentSingleStep = this.config.maxSteps === 1;
    const tokenUsageDetails = turnState.tokenDetails;
    const shouldSuppressSelfSummaryAfterInputLimitFailure = turnState.shouldSuppressSelfSummaryAfterInputLimitFailure(tokenUsageDetails.usedTokens);
    const shouldStartBg = !isCloudAgentSingleStep && !turnState.tokenDetailsStaleAfterSummarization && !shouldSuppressSelfSummaryAfterInputLimitFailure && this.orchestrator.shouldStartBackgroundSummarization(tokenUsageDetails, promptExecutor.getMessages(), runContext);
    if (shouldStartBg) {
      const wouldMeetPersistThreshold = shouldPersistBackgroundSummarization(tokenUsageDetails.usedTokens, tokenUsageDetails.maxTokens, this.config.backgroundSummarizationProps);
      agentLogger.info(runContext, "Mid-loop background summarization trigger (model-stream-only): checking persist threshold", {
        usedTokens: tokenUsageDetails.usedTokens,
        maxTokens: tokenUsageDetails.maxTokens,
        unusedTokens: tokenUsageDetails.maxTokens - tokenUsageDetails.usedTokens,
        wouldMeetPersistThreshold,
        triggerThreshold: getBackgroundSummarizationTriggerThreshold(tokenUsageDetails.maxTokens, this.config.backgroundSummarizationProps),
        backgroundSummarizationConfig: this.config.backgroundSummarizationProps,
        persistConfig: {
          unusedTokensThreshold: this.config.backgroundSummarizationProps.unusedTokensThresholdToPersistBackgroundSummarization,
          unusedPercentTokensThreshold: this.config.backgroundSummarizationProps.unusedPercentTokensThresholdToPersistBackgroundSummarization,
        },
      });
      await this.orchestrator.handleSummarization(runContext, turnState, promptExecutor, this.interactionListener, this.config, requestState, {
        backgroundSummarizationMode: BackgroundSummarizationMode.Background,
        triggerReason: "approaching_token_limit",
        currentInvocationId: callInvocationId,
        resourceAccessor: this.resourceAccessor,
        tools: toolSetLease.getStaticTools(),
        descriptionProps: toolSetLease.getDescriptionProps(),
        extraT: {
          repositoryInfos,
          shouldQueryProd: requestState.repositoryInfoShouldQueryProd,
          stateHandler: turnState,
          enableToolArgPreservation: this.config.enableToolArgPreservation === true,
          enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
          enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
          enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
          writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
          onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
          workspacePaths: requestState.env?.workspacePaths,
          userAutoRunInstructions: await this.getUserPermissionsFileAutoRunInstructions(runContext, requestState),
          projectAutoRunInstructions: this.getProjectPermissionsFileAutoRunInstructions(requestState),
          cursorRules: getAllRules(requestState, this.config.nonFileRules, this.config.featureFlags),
          agentSkills: requestState.agentSkills ?? [],
        },
        automationTriggerContext: this.getAutomationTriggerContext(promptExecutor.getMessages()),
      });
    }
    let modelResponse: Awaited<ModelOnlyStreamResultLike["response"]>;
    let usageDetails: Awaited<ModelOnlyStreamResultLike["extendedUsage"]>;
    let tokenUsage: Awaited<ModelOnlyStreamResultLike["usage"]>;
    let toolCallSpecs: readonly unknown[];
    let finalInvocationId: string;
    try {
      [modelResponse, usageDetails, tokenUsage, toolCallSpecs, finalInvocationId] = await Promise.all([
        stepResult.response,
        stepResult.extendedUsage,
        stepResult.usage,
        stepResult.toolCallDescriptors,
        stepResult.invocationId,
        interactionHandler.consumeStream(runContext, this.tapAgentResponseComparisonWarmup(runContext, stepResult.fullStream, responseComparisonMessages, responseComparisonTools), conversationTurn),
      ]);
    } catch (error) {
      await this.cancelPendingAgentResponseComparison();
      throw error;
    }
    if (finalInvocationId !== callInvocationId) {
      agentLogger.error(runContext, "Invocation ID mismatch. Bug in executeModelStreamOnly", undefined, {
        initialInvocationId: callInvocationId,
        finalInvocationId,
      });
    }
    agentLogger.info(runContext, "Setting token details for client token ring (model-stream-only)", {
      usedTokens: tokenUsage.totalTokens,
      maxTokens: usageDetails.maxTokens,
      inputTokens: usageDetails.inputTokens,
      outputTokens: usageDetails.outputTokens,
      cacheReadTokens: usageDetails.cacheReadTokens,
      cacheWriteTokens: usageDetails.cacheWriteTokens,
    });
    const promptContextDetails = computeNextRedactedPromptContextDetails(runContext, this.config, turnState, {
      messages: initialMessages as unknown as PromptTokenBreakdownParams["messages"],
      tools: toolSetLease.getStaticTools() as unknown as PromptTokenBreakdownParams["tools"],
      descriptionProps: toolSetLease.getDescriptionProps(),
      totalUsedTokens: tokenUsage.totalTokens,
      maxTokens: usageDetails.maxTokens,
    }, redactedPromptTokenDetailsCodec);
    turnState.setTokenDetails(createRedactedConversationTokenDetailsInterop(turnState.getPrivacyMode(), {
      usedTokens: tokenUsage.totalTokens,
      maxTokens: usageDetails.maxTokens,
      breakdown: promptContextDetails!.breakdown,
      promptContextUsageTree: promptContextDetails!.promptContextUsageTree,
    }));
    if (modelResponse.error || runContext.signal.aborted) {
      await this.cancelPendingAgentResponseComparison();
      if (this.config.skipErrorStateCheckpoint !== true) {
        conversationTurn.appendPromptMessages(toRedactedCoreMessages(modelResponse.messages, turnState.getPrivacyMode()));
        const currentState = await turnState.computeNewStructure(runContext);
        if (publishStateUpdate) {
          await publishStateUpdate(runContext, currentState);
        }
      }
      throw modelResponse.error ?? new ConnectError("User aborted request", Code.Canceled);
    }
    turnState.addTurnUsage({
      inputTokens: usageDetails.inputTokens,
      outputTokens: usageDetails.outputTokens,
      cacheReadTokens: usageDetails.cacheReadTokens,
      cacheWriteTokens: usageDetails.cacheWriteTokens,
      reasoningTokens: usageDetails.reasoningTokens,
    });
    if (toolCallSpecs.length === 0 && responseComparisonMessages !== undefined && responseComparisonTools !== undefined) {
      try {
        await this.enqueueAgentResponseComparisonIfEligible({
          ctx: runContext,
          parentInvocationId: finalInvocationId,
          responseMessages: modelResponse.messages,
          messages: responseComparisonMessages,
          tools: responseComparisonTools,
          privacyMode: turnState.getPrivacyMode(),
        });
      } finally {
        responseComparisonMessages = undefined;
        responseComparisonTools = undefined;
      }
    }
    if (toolCallSpecs.length === 0) {
      await this.finalizePendingAgentResponseComparison(true);
    }
    return {
      toolCallDescriptors: toolCallSpecs,
      responseMessages: modelResponse.messages,
    };
  }
}

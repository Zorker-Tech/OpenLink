/**
 * The conversation's own state, and the turns it is made of.
 *
 * A conversation is stored as a chain of blobs — a state structure naming its turns, each turn naming its
 * steps — so that a long conversation does not have to be read whole to be continued. This is the object
 * that reads and writes that chain: it hydrates a state into the redacted shapes the rest of the agent
 * works with, keeps the blob store and the formatting options beside it, and offers a handle for the turn
 * being worked on so a caller can append a step without holding the whole structure.
 *
 * Two things make it more than a store. It is where a turn's timing and usage are accounted for, because
 * that is what the structure carries and what the platform reports about a turn. And it is where a
 * conversation's plan, its todos, its goal, its subagent runs and its shell turns live, each with its own
 * way of being written back: a plan is stored once per conversation, a todo list is a step, a goal is a
 * field that may be paused or finished, and a subagent's run is a record that outlives the turn that
 * started it. The handle is what keeps those writes from each having to re-read the state.
 *
 * Everything written out is written redacted, and read back under the privacy mode the conversation was
 * loaded with, so a stored conversation never carries an unredacted value it was not allowed to keep.
 */

import { pathToFileURL } from "node:url"

import { getBlobId, isBlobDurable, type BlobStore } from "../agent-kv/blob-store.ts"
import { BlobNotFoundError } from "../agent-kv/blob-not-found-error.ts"
import { toHex, utf8Serde, type Serde } from "../agent-kv/serde.ts"
import { EagerReference, LazyReference, Writeable } from "../agent-kv/references.ts"
import { metadataObserverForStore } from "../agent-kv/typed-blob-store.ts"
import { createRedactedCoreMessageSerde } from "./serde.ts"
import {
  createAgentStateMessageSerdesInterop,
  createAgentStateCommunicateHistoryEntryInterop,
  createAgentStateCommunicateTurnStateInterop,
  createEmptyRedactedShellOutputInterop,
  createSlateConversationStepSerde,
  fromInteropToolCallStep,
  fromInteropConversationState,
  fromInteropGoalState,
  fromInteropPlanRegistryEntry,
  attachAgentSelectedContextMediaInterop,
  createRedactedConversationTokenDetailsInterop,
  emptyAgentSelectedContextInterop,
  type AgentStateGitRepoInfoInterop,
  type AgentStateCommunicateHistoryEntryInterop,
  type AgentStateCommunicateTurnStateInterop,
  type AgentStateRequestContextInterop,
  type RedactedAgentConversationStateInterop,
  encodeSlateConversationStateSnapshotInterop,
  fromRedactedCommunicateUpdateHistoryEntryInterop,
  fromRedactedCommunicateUpdateTurnStateInterop,
  fromRedactedConversationSummaryArchiveInterop,
  fromRedactedConversationSummaryInterop,
  fromRedactedConversationTokenDetailsInterop,
  fromRedactedGoalStateInterop,
  fromRedactedPlanRegistryEntryInterop,
  fromRedactedSubagentPersistedStateInterop,
  fromRedactedSubagentRunStateInterop,
  fromRedactedTodoItemInterop,
  fromRedactedUserMessageInterop,
  serializeRedactedConversationStateInterop,
  toInteropConversationState,
  toInteropGoalState,
  toInteropPlanRegistryEntry,
  toRedactedConversationSummaryArchiveInterop,
  toRedactedConversationSummaryInterop,
  toRedactedSubagentPersistedStateInterop,
  toRedactedTodoItemInterop,
  toRedactedUserMessageInterop,
} from "../../adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import {
  fromInteropSubagentPersistedState,
  toInteropSubagentPersistedState,
} from "../../adapters/interop/agent/subagent-persisted-state-adapter.ts"
import {
  slateConversationTurnSerde,
} from "../../adapters/interop/agent/agent-conversation-state-serdes-adapter.ts"
import {
  createSlateAgentConversationTurn,
  createSlateShellConversationTurn,
  type SlateAgentConversationTurn,
  type SlateShellConversationTurn,
} from "./conversation-turn-state.ts"
import {
  createSlateAssistantMessageStep,
  createSlateThinkingMessageStep,
  createSlateToolCallStep,
  type SlateConversationStep,
  type SlateToolCallStep,
} from "./conversation-step-state.ts"
import type { SlateConversationState } from "./conversation-state.ts"
import {
  slateConversationPlanFromValue,
  type SlateConversationPlanState,
} from "./conversation-plan-state.ts"
import {
  type SlateGoalState,
  type SlatePlanRegistryEntry,
} from "./goal-state.ts"
import {
  fromInteropUserMessage,
  toInteropSimulatedMessageReason,
  toInteropUserMessage,
  type UserMessageInterop,
} from "../../adapters/interop/agent/user-message-action-protocol-adapter.ts"
import {
  cloneSlateUserMessage,
  SlateSimulatedMessageReason,
  type SlateSimulatedMessageReason as SlateSimulatedMessageReasonValue,
} from "./user-message-state.ts"
import {
  fromInteropSubagentRunState,
  toInteropSubagentRunState,
} from "../../adapters/interop/agent/subagent-run-state-adapter.ts"
import { DataClassification, PrivacyCapability } from "../redaction/classification.ts"
import { createRedactedString } from "../redaction/create.ts"
import { fromRedactedCoreMessage, toRedactedCoreMessage } from "../redaction/message-redaction.ts"
import { PrivacyMode as PrivacyModes, type PrivacyMode } from "../redaction/privacy-mode.ts"
import type { Context as OperationContext } from "../context/context.ts"
import { createLogger } from "../context/index.ts"
import { createSpan, withSuppressedChildSpans } from "../context/telemetry.ts"
import { recordCompletedSpanIfParented } from "../context/telemetry.ts"
import type { SlateSubagentTypeLike } from "./subagent-type.ts"
import type { SlateBackgroundTaskCompletion } from "./actions/background-task-completion-contracts.ts"
import {
  updateSlateSubagentRun,
  type SlateSubagentRunState,
} from "./subagent-run-state.ts"
import {
  createSlateSubagentPersistedState,
  type SlateSubagentPersistedState,
} from "./subagent-persisted-state.ts"
import { isEqual } from "./array-equality.ts"
import { createCounter, createHistogram } from "../metrics/index.ts"
import { asyncMapValues } from "../utils/promise-tools.ts"
import { isLargeContextModel } from "../utils/model-markers.ts"
import { resolveAgentType } from "./state-agent-type.ts"
import { computeCoreMessageImagePresence } from "./conversation-image-presence.ts"

import {
  resolveCurrentTurnMode,
  SlateMode,
  type SlateMode as SlateModeValue,
  joinUserTurnSystemReminders,
  processAntiAskQuestionSystemReminder,
  processWorkspaceChangeReminder,
  type ModeProcessingRequestContext,
} from "./mode-processing.ts"
import {
  type AgentModeInterop,
  fromInteropAgentMode,
  processModeSystemReminderWithInteropConfig,
  toInteropAgentMode,
  type InteropModeProcessingConfig,
} from "../../adapters/interop/agent/mode-processing-adapter.ts"
import {
  formatProjectPrompt,
  formatProjectSideChatPrompt,
  formatProjectSubagentPrompt,
  formatProjectThreadPrompt,
  normalizeProjectName,
} from "./prompts/project-prompts.ts"
import { canRootConversationSendToProject } from "../constants/project-send-message.ts"
import { getConversationId, getRequestId } from "./utils/request-scope.ts"
import { slateSubagentTypeName } from "./subagent-type.ts"
import { escapePromptXmlText } from "./utils/prompt-xml-escape.ts"
import { persistPromptContextUsageSnapshot } from "./utils/usage-snapshot.ts"
import { isNotificationOnlyUserMessage } from "./actions/user-message-action/synthetic-user-message.ts"
import { createPromptReferenceId, parseLeadingUserMessageIdTag, renderUserMessageIdTag } from "./tools/prompt-reference-contract.ts"
import { renderHookContextReminder } from "../hooks-carriers/hook-context-rendering.ts"
import { processSelectedContext } from "./context/process-selected-context.ts"

// remain deliberately absent and uncomposed. The
// recovered tracking and serde helpers are private implementation details.

const stateLog = createLogger("@slate/agent:state");
const utf8Decoder = new TextDecoder();

const restoreDurationHistogram = createHistogram("agent.conversation_state.restore.duration_ms", {
  description: "Wall time for fromConversationStateStructure (KV blob loads + handle setup).",
  labelNames: ["crossed_large_threshold"],
});
const restoreRootPromptHistogram = createHistogram("agent.conversation_state.restore.root_prompt_message_count", {
  description: "Count of root prompt message blobs loaded (one getBlob per persisted message).",
  labelNames: ["crossed_large_threshold"],
});
const restoreTurnRefHistogram = createHistogram("agent.conversation_state.restore.turn_reference_count", {
  description: "Count of lazy turn references in persisted state (not materialized here).",
  labelNames: ["crossed_large_threshold"],
});
const restoreFilePathHistogram = createHistogram("agent.conversation_state.restore.file_state_path_count", {
  description: "Number of paths in file_states_v2.",
  labelNames: ["crossed_large_threshold"],
});
const restoreBytesHistogram = createHistogram("agent.conversation_state.restore.total_restored_bytes", {
  description: "Bytes eagerly loaded during restore (root prompt blobs).",
  labelNames: ["crossed_large_threshold"],
});
const restorePhaseHistogram = createHistogram("agent.conversation_state.restore.phase_ms", {
  description: "Wall time for each phase of fromConversationStateStructure (root prompt blob loads, file-state wiring, subagent state refs, other setup). Sum ≈ restore.duration_ms.",
  labelNames: ["phase", "crossed_large_threshold"],
});
const restoreFetchConcurrencyHistogram = createHistogram("agent.conversation_state.restore.blob_fetch_concurrency", {
  description: "Effective max concurrent blob reads for this restore (agent_state_restore_config.blob_fetch_concurrency after schema validation; the 32 fallback means the console value was absent or failed to parse).",
});
const rootPromptModeCounter = createCounter("agent.conversation_state.compute.root_prompt_mode", {
  description: "Counts whether computeNewStructure rebuilt root prompt blobs or reused a persisted prefix.",
  labelNames: ["mode"],
});

const SLOW_SERIALIZE_MS = 1;
const LARGE_RESTORE_BYTES = 2 * 1024 * 1024;
const LARGE_RESTORE_IMAGE = 512 * 1024;
const SLOW_RESTORE_MS = 200;
const RESTORE_FETCH_CONCURRENCY = 32;

type RestoreMetricValues = {
  context: OperationContext;
  restoreDurationMs: number;
  rootPromptPhaseMs: number;
  fileStatesPhaseMs: number;
  subagentStateRefsPhaseMs: number;
  rootPromptMessageCount: number;
  turnReferenceCount: number;
  fileStatePathCount: number;
  rootPromptBytes: number;
  restoreBlobFetchConcurrency: number;
  crossedLargeThreshold: boolean;
};

function recordRestoreMetrics({
  context,
  restoreDurationMs,
  rootPromptPhaseMs,
  fileStatesPhaseMs,
  subagentStateRefsPhaseMs,
  rootPromptMessageCount,
  turnReferenceCount,
  fileStatePathCount,
  rootPromptBytes,
  restoreBlobFetchConcurrency,
  crossedLargeThreshold,
}: RestoreMetricValues): void {
  const largeLabel = {
    crossed_large_threshold: crossedLargeThreshold ? "true" : "false",
  };
  const namedPhasesMs = rootPromptPhaseMs + fileStatesPhaseMs + subagentStateRefsPhaseMs;
  const otherPhaseMs = Math.max(0, restoreDurationMs - namedPhasesMs);
  restorePhaseHistogram.histogram(context, rootPromptPhaseMs, {
    phase: "root_prompt_messages",
    ...largeLabel,
  });
  restorePhaseHistogram.histogram(context, fileStatesPhaseMs, {
    phase: "file_states",
    ...largeLabel,
  });
  restorePhaseHistogram.histogram(context, subagentStateRefsPhaseMs, { phase: "subagent_state_refs", ...largeLabel });
  restorePhaseHistogram.histogram(context, otherPhaseMs, {
    phase: "other",
    ...largeLabel,
  });
  restoreDurationHistogram.histogram(context, restoreDurationMs, largeLabel);
  restoreFetchConcurrencyHistogram.histogram(context, restoreBlobFetchConcurrency);
  restoreRootPromptHistogram.histogram(context, rootPromptMessageCount, largeLabel);
  restoreTurnRefHistogram.histogram(context, turnReferenceCount, largeLabel);
  restoreFilePathHistogram.histogram(context, fileStatePathCount, largeLabel);
  restoreBytesHistogram.histogram(context, rootPromptBytes, largeLabel);
}

function payloadBytes(payload: unknown): number {
  if (typeof payload === "string") {
    return Buffer.byteLength(payload, "utf8");
  }
  if (payload instanceof Uint8Array) {
    return payload.byteLength;
  }
  if (payload instanceof ArrayBuffer) {
    return payload.byteLength;
  }
  if (payload instanceof URL) {
    return Buffer.byteLength(payload.toString(), "utf8");
  }
  return 0;
}

function imagePayloadStats(message: { content?: unknown }): { imageBytes: number; imagePartCount: number } {
  const stats = { imageBytes: 0, imagePartCount: 0 };
  if (!Array.isArray(message.content)) {
    return stats;
  }
  for (const part of message.content) {
    if (part !== null && typeof part === "object" && "type" in part && part.type === "image") {
      const image = "image" in part ? part.image : undefined;
      const data = "data" in part ? part.data : undefined;
      stats.imagePartCount++;
      stats.imageBytes += payloadBytes(image ?? data);
    }
  }
  return stats;
}

function validTimeZone(timeZone?: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function startTimeZone(timeZone?: string): string {
  if (timeZone && validTimeZone(timeZone)) {
    return timeZone;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function dateStringForTimestamp(timestampMs: bigint, timeZone?: string): string {
  const timestamp = new Date(Number(timestampMs));
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimeZone(timeZone) ? timeZone : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(timestamp);
  const partLookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type === "literal") {
      continue;
    }
    partLookup[part.type] = part.value;
  }
  const year = partLookup.year;
  const month = partLookup.month;
  const day = partLookup.day;
  if (!year || !month || !day) {
    throw new Error(`Failed to build local date for timestamp ${timestampMs.toString()} in timezone ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

type BlobCacheEntry = {
  readonly blobId: Uint8Array;
  readonly blobData: Uint8Array;
};

const messageBlobCache = new WeakMap<object, BlobCacheEntry>();
const plainToRedacted = new WeakMap<object, object>();
const subagentBlobCache = new WeakMap<object, BlobCacheEntry>();

type Disposable = {
  [Symbol.dispose]?: (this: Disposable) => void;
  [Symbol.asyncDispose]?: (this: Disposable) => void | Promise<void>;
};

type DisposableResourceEntry = {
  value?: Disposable;
  dispose?: (this: Disposable) => void | Promise<void>;
  async?: boolean;
};

type DisposableEnvironmentEntry = {
  stack: DisposableResourceEntry[];
  error: unknown;
  hasError: boolean;
};

function isDisposable(value: unknown): value is Disposable {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function addDisposableResource(env: DisposableEnvironmentEntry, value: unknown, async: boolean): unknown {
  if (value !== null && value !== undefined) {
    if (!isDisposable(value)) throw new TypeError("Object expected.");
    const disposableValue = value;
    let dispose = async ? disposableValue[Symbol.asyncDispose] : undefined;
    let inner: ((this: Disposable) => void | Promise<void>) | undefined;
    if (dispose === undefined) {
      if (Symbol.dispose === undefined) throw new TypeError("Symbol.dispose is not defined.");
      dispose = disposableValue[Symbol.dispose];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
    if (inner !== undefined) {
      dispose = function () {
        try {
          inner!.call(this);
        } catch (error) {
          return Promise.reject(error);
        }
      };
    }
    env.stack.push({ value: disposableValue, dispose, async });
  } else if (async) {
    env.stack.push({ async: true });
  }
  return value;
}

function disposeResources(env: DisposableEnvironmentEntry): Promise<void> | void {
  const SuppressedErrorConstructor = typeof SuppressedError === "function"
    ? SuppressedError
    : class extends Error {
      readonly error: unknown;
      readonly suppressed: unknown;
      constructor(error: unknown, suppressed: unknown, message: string) {
        super(message);
        this.name = "SuppressedError";
        this.error = error;
        this.suppressed = suppressed;
      }
    };
  const fail = (error: unknown): void => {
    env.error = env.hasError
      ? new SuppressedErrorConstructor(error, env.error, "An error was suppressed during disposal.")
      : error;
    env.hasError = true;
  };
  let asyncState = 0;
  const next = (): Promise<void> | void => {
    let resource: DisposableResourceEntry | undefined;
    while ((resource = env.stack.pop()) !== undefined) {
      try {
        if (!resource.async && asyncState === 1) {
          asyncState = 0;
          env.stack.push(resource);
          return Promise.resolve().then(next).then(() => undefined);
        }
        if (resource.dispose !== undefined) {
          const result = resource.dispose.call(resource.value!);
          if (resource.async) {
            asyncState |= 2;
            return Promise.resolve(result).then(next, error => {
              fail(error);
              return next();
            }).then(() => undefined);
          }
        } else {
          asyncState |= 1;
        }
      } catch (error) {
        fail(error);
      }
    }
    if (asyncState === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
    if (env.hasError) throw env.error;
  };
  return next();
}

function invalidXmlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return true;
    }
  }
  return false;
}

export function renderIncomingMessageIdTag(messageId?: string): string | undefined {
  const normalizedMessageId = messageId?.trim();
  if (
    normalizedMessageId === undefined ||
    normalizedMessageId.length === 0 ||
    invalidXmlCharacter(normalizedMessageId)
  ) {
    return undefined;
  }
  return `<incoming_message_id>${escapePromptXmlText(normalizedMessageId)}</incoming_message_id>`;
}

function exposeIncomingMessageId(userMessage: {
  readonly isSimulatedMsg: boolean;
  readonly simulatedMsgReason: SlateSimulatedMessageReasonValue;
  readonly text: string;
}): boolean {
  if (userMessage.isSimulatedMsg !== true) return true;
  if (userMessage.simulatedMsgReason !== SlateSimulatedMessageReason.SUBSCRIPTION) return false;
  return isNotificationOnlyUserMessage({ role: "user", content: userMessage.text });
}

function dynamicToolsReminder(toolNames: {
  readonly discoveryToolName: string;
  readonly invocationToolName: string;
}): string {
  const { discoveryToolName, invocationToolName } = toolNames;
  return `<system_reminder>
Dynamic tools have been enabled for this conversation. Some tools that appeared as direct tool calls in earlier turns must now be called through ${invocationToolName}. Discover tool schemas with ${discoveryToolName}.
</system_reminder>`;
}

async function getPreviousAgentConversationTurn(
  ctx: OperationContext,
  turns: readonly { get(ctx: OperationContext): Promise<unknown> }[],
): Promise<AgentConversationTurnHandle | undefined> {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turnHandle = await turns[i]!.get(ctx);
    if (turnHandle instanceof AgentConversationTurnHandle) return turnHandle;
  }
  return undefined;
}

async function getPreviousRecordedDynamicToolCount(
  ctx: OperationContext,
  turns: readonly { get(ctx: OperationContext): Promise<unknown> }[],
): Promise<number | undefined> {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turnHandle = await turns[i]!.get(ctx);
    if (!(turnHandle instanceof AgentConversationTurnHandle)) continue;
    const count = turnHandle.dynamicToolCount;
    if (count !== undefined) return count;
  }
  return undefined;
}

function decryptModelMcid(
  turnHandle: AgentConversationTurnHandle,
  decryptMcidAndParams: ((encrypted: string) => string | undefined) | undefined,
): string | undefined {
  if (decryptMcidAndParams === undefined) return undefined;
  const encrypted = turnHandle.encryptedModel;
  if (encrypted === undefined || encrypted.length === 0) return undefined;
  try {
    return decryptMcidAndParams(encrypted);
  } catch {
    return undefined;
  }
}

const MODEL_SWITCH_NOTICE = `<system_reminder>
Earlier turns were produced by a different AI model. It may have called tools that are no longer available to you. Call only the tools currently defined for you, using your current schemas, and follow your own response style rather than imitating the prior model's behavior.
</system_reminder>`;

const stateSnapshotHistogram = createHistogram("agent.ttft.createTurn.stateSnapshotMs", {
  description: "Time for computeNewStructure + serialize + getBlobId at the start of createAgentTurn",
  labelNames: ["overlap"],
});
const snapshotJoinHistogram = createHistogram("agent.ttft.createTurn.snapshotJoinWaitMs", {
  description: "Time the overlap treatment waits for the pre-turn snapshot after selected-context processing",
});
const overlapSavedHistogram = createHistogram("agent.ttft.createTurn.overlapSavedMs", {
  description: "Wall-clock pre-turn snapshot time hidden by concurrent turn preparation in the overlap treatment",
});
const userMessageBlobHistogram = createHistogram("agent.ttft.createTurn.userMessageBlobMs", {
  description: "Time to serialize, hash, and persist the user message blob at the end of createAgentTurn",
});

function isText(part: { readonly type?: string; readonly text?: string }): part is { readonly type: "text"; readonly text: string } {
  return part.type === "text";
}

function carriesMessageIdTag(contentParts: readonly { readonly type?: string; readonly text?: string }[]): boolean {
  if (contentParts.length === 0) return false;
  const firstPart = contentParts[0]!;
  return isText(firstPart) && parseLeadingUserMessageIdTag(firstPart.text) !== undefined;
}

function promptReferenceId(
  isMetaParentAgent: boolean,
  promptReferenceIdFromUserMessage: string | undefined,
  userMessageId: string,
  userContent: readonly { readonly type?: string; readonly text?: string }[],
): {
  hasStructuredPromptReferenceId: boolean;
  promptReferenceId: string | undefined;
  shouldIncludePromptReferenceIdTag: boolean;
} {
  const alreadyHasPromptReferenceIdTag = carriesMessageIdTag(userContent);
  const existingPromptReferenceIdTag = alreadyHasPromptReferenceIdTag && userContent.length > 0 && isText(userContent[0]!)
    ? parseLeadingUserMessageIdTag(userContent[0]!.text)
    : undefined;
  const hasStructuredPromptReferenceId = promptReferenceIdFromUserMessage !== undefined && promptReferenceIdFromUserMessage.length > 0;
  let promptReferenceId = hasStructuredPromptReferenceId ? promptReferenceIdFromUserMessage : existingPromptReferenceIdTag?.id;
  const shouldIncludePromptReferenceIdTag = isMetaParentAgent && !hasStructuredPromptReferenceId && !alreadyHasPromptReferenceIdTag;
  if (shouldIncludePromptReferenceIdTag && promptReferenceId === undefined) {
    promptReferenceId = createPromptReferenceId(userMessageId);
  }
  return { hasStructuredPromptReferenceId, promptReferenceId, shouldIncludePromptReferenceIdTag };
}

function trackedGitBranches(gitRepos: readonly AgentStateGitRepoInfoInterop[]): BranchRef[] {
  return gitRepos.map((repo) => ({ repoPath: repo.path, branchName: repo.branchName }));
}

function trackedGitChanges(
  previousRepos: readonly BranchRef[],
  currentRepos: readonly BranchRef[],
): { repoPath: string; from: string; to: string }[] {
  if (previousRepos.length === 0 || currentRepos.length === 0) return [];
  const previousByPath = new Map(previousRepos.map((repo) => [repo.repoPath, repo.branchName]));
  const changes: { repoPath: string; from: string; to: string }[] = [];
  for (const currentRepo of currentRepos) {
    const previousBranchName = previousByPath.get(currentRepo.repoPath);
    if (previousBranchName === undefined || previousBranchName === currentRepo.branchName) continue;
    changes.push({ repoPath: currentRepo.repoPath, from: previousBranchName, to: currentRepo.branchName });
  }
  return changes;
}

function legacyGitReminder(changes: readonly { repoPath: string; from: string; to: string }[]): string {
  if (changes.length === 0) return "";
  const changedLines = changes.map((change) => `${change.repoPath} changed from ${change.from} to ${change.to}.`);
  return `<system_reminder>
The active branch changed since the last turn:
${changedLines.join("\n")}
Assume these branch changes were intentional and use the new branch state as the current working context.
</system_reminder>`;
}

function gitReminder(
  previousRepos: readonly BranchRef[],
  currentGitRepos: readonly AgentStateGitRepoInfoInterop[],
  enhancedBranchChangeReminder: boolean,
): string {
  const currentTracked = trackedGitBranches(currentGitRepos);
  const changes = trackedGitChanges(previousRepos, currentTracked);
  if (changes.length === 0) return "";
  if (!enhancedBranchChangeReminder) return legacyGitReminder(changes);
  const repoByPath = new Map(currentGitRepos.map((repo) => [repo.path, repo]));
  const bodyLines: string[] = [];
  let anyAncestor = false;
  for (const change of changes) {
    let line = `${change.repoPath}: changed from "${change.from}" to "${change.to}".`;
    const repo = repoByPath.get(change.repoPath);
    if (repo?.previousBranchIsAncestor === true) {
      line += " The previous branch is an ancestor of the current HEAD.";
      anyAncestor = true;
    }
    bodyLines.push(line);
  }
  const footer = anyAncestor ? "Prior edits should be present on the current branch." : "Use the current branch as the working context.";
  return `<system_reminder>
The active git branch changed since the last turn:
${bodyLines.join("\n")}
${footer}
</system_reminder>`;
}

type PluginEntry = {
  readonly displayName?: string;
  readonly description?: string;
  readonly skills: readonly { readonly name: string; readonly description?: string }[];
  readonly subagents: readonly { readonly name: string; readonly description?: string }[];
  readonly hooks: readonly { readonly name: string; readonly description?: string }[];
  readonly rules: readonly { readonly name: string; readonly description?: string }[];
  readonly commands: readonly { readonly name: string; readonly description?: string }[];
  readonly mcpServers: readonly string[];
};

function pluginReminder(plugin: PluginEntry | undefined): string {
  if (!plugin || !plugin.displayName) return "";
  const capabilities: string[] = [];
  if (plugin.skills.length) capabilities.push(`Skills:\n${plugin.skills.map((skill) => `  - ${skill.name}${skill.description ? `: ${skill.description}` : ""}`).join("\n")}`);
  if (plugin.subagents.length) capabilities.push(`Subagents:\n${plugin.subagents.map((subagent) => `  - ${subagent.name}${subagent.description ? `: ${subagent.description}` : ""}`).join("\n")}`);
  if (plugin.hooks.length) capabilities.push(`Hooks:\n${plugin.hooks.map((hook) => `  - ${hook.name}${hook.description ? `: ${hook.description}` : ""}`).join("\n")}`);
  if (plugin.rules.length) capabilities.push(`Rules:\n${plugin.rules.map((rule) => `  - ${rule.name}${rule.description ? `: ${rule.description}` : ""}`).join("\n")}`);
  if (plugin.commands.length) capabilities.push(`Commands:\n${plugin.commands.map((command) => `  - ${command.name}${command.description ? `: ${command.description}` : ""}`).join("\n")}`);
  if (plugin.mcpServers.length) capabilities.push(`MCP Servers:\n${plugin.mcpServers.map((server) => `  - ${server}`).join("\n")}`);
  let prompt = `The user just installed the "${plugin.displayName}" plugin`;
  if (plugin.description) prompt += ` (${plugin.description})`;
  if (capabilities.length) prompt += ` with the following capabilities:\n\n${capabilities.join("\n\n")}`;
  prompt += `

Provide them with an overview of what is contained in the plugin. Keep in mind that:
- Commands can be invoked with \`/\`
- Skills and subagents can be invoked directly with \`/\` or will be used by the agent automatically
- Rules and hooks will be applied automatically`;
  if (plugin.mcpServers.length) prompt += `
- MCP servers likely require authentication. After providing an overview of the plugin, check the STATUS.md file in the server's folder to see if it needs authentication, and follow the instructions in the file to authenticate.`;
  prompt += `

Do NOT do any other searches over file system contents, search the web, etc. and do not think for too long. Just give the user an overview of the plugin they installed.`;
  return `<system_reminder>
${prompt}
</system_reminder>`;
}

function currentTimestamp(timeZone?: string): string {
  const now = new Date();
  try {
    const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const formatted = dateTimeFormatter.format(now);
    const offsetFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      timeZoneName: "shortOffset",
    });
    const parts = offsetFormatter.formatToParts(now);
    const tzPart = parts.find(part => part.type === "timeZoneName");
    const utcOffset = (tzPart?.value ?? "UTC").replace("GMT", "UTC");
    return `${formatted} (${utcOffset})`;
  } catch {
    return now.toISOString();
  }
}

export function buildTimestampPrefix(timeZone?: string): string {
  return `<timestamp>${currentTimestamp(timeZone)}</timestamp>\n`;
}

function createSerdes(privacyMode: PrivacyMode) {
  const interopSerdes = createAgentStateMessageSerdesInterop(privacyMode);
  return {
    ...interopSerdes,
    conversationStep: createSlateConversationStepSerde(privacyMode),
    coreMessage: createRedactedCoreMessageSerde(privacyMode),
  };
}

type FileStateBlobReference<Context extends OperationContext> = EagerReference<string, Context> | LazyReference<string, Context> | undefined;
type FileStateBlobReferences<Context extends OperationContext> = {
  content: FileStateBlobReference<Context>;
  initialContent: FileStateBlobReference<Context>;
};

type WorkspaceRequestShape = {
  readonly env?: {
    readonly workspacePaths?: readonly unknown[];
  };
};

function fileStateReference<Context extends OperationContext>(
  blobStore: BlobStore<Context>,
  content: string | undefined,
): FileStateBlobReference<Context> {
  return content !== undefined ? new EagerReference(utf8Serde, blobStore, content) : undefined;
}

function noteFileState<Context extends OperationContext>(
  fileStates: Map<string, FileStateBlobReferences<Context>>,
  blobStore: BlobStore<Context>,
  path: string,
  content: string | undefined,
  prevContent: string | undefined,
  skipReprioritization: boolean | undefined,
): void {
  const existing = fileStates.get(path);
  const next = existing === undefined ? {
    content: fileStateReference(blobStore, content),
    initialContent: fileStateReference(blobStore, prevContent),
  } : {
    content: fileStateReference(blobStore, content),
    initialContent: existing.initialContent,
  };
  if (skipReprioritization) {
    fileStates.set(path, next);
    return;
  }
  const otherEntries = Array.from(fileStates).filter(([key]) => key !== path);
  fileStates.clear();
  fileStates.set(path, next);
  for (const [key, value] of otherEntries) {
    fileStates.set(key, value);
  }
}

function workspaceUrisFrom(_ctx: unknown, requestContext: WorkspaceRequestShape) {
  const workspacePaths = requestContext.env?.workspacePaths ?? [];
  const uris: string[] = [];
  for (const workspacePath of workspacePaths) {
    if (typeof workspacePath !== "string") {
      continue;
    }
    const trimmedPath = workspacePath.trim();
    if (trimmedPath.length === 0) {
      continue;
    }
    if (trimmedPath.includes("://")) {
      uris.push(trimmedPath);
      continue;
    }
    try {
      uris.push(pathToFileURL(trimmedPath).toString());
    } catch {
    }
  }
  const sortedUris = uris.slice().sort((a, b) => a.localeCompare(b));
  return sortedUris.map(uri => createRedactedString(uri, DataClassification.PATH, "workspaceUri", PrivacyModes.UNSPECIFIED));
}

function trimmedString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

type ThreadFields = {
  readonly threadId?: string;
  readonly promptReferenceId?: string;
  readonly messageId?: string;
};

function explicitThreadId(userMessage: ThreadFields): string | undefined {
  return trimmedString(userMessage.threadId);
}

function messageThreadId(userMessage: ThreadFields): string | undefined {
  return explicitThreadId(userMessage)
    ?? trimmedString(userMessage.promptReferenceId)
    ?? trimmedString(userMessage.messageId);
}

function attachThreadId<T extends object>(userMessage: T, threadId: string): T & { threadId: string } {
  return { ...userMessage, threadId };
}

type RedactedCodeString = { unwrap: (purpose: PrivacyCapability) => string };
type MaybeRedactedCodeString = string | RedactedCodeString | null | undefined;

function unwrapCodeString(value: MaybeRedactedCodeString): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
}

type CommunicateStateLike = {
  readonly history?: readonly {
    readonly step?: MaybeRedactedCodeString;
    readonly messageIndex: number;
  }[];
  readonly finalSummary?: MaybeRedactedCodeString;
  readonly completedSubtitle?: MaybeRedactedCodeString;
};

function communicateState(state: CommunicateStateLike): AgentStateCommunicateTurnStateInterop {
  return createAgentStateCommunicateTurnStateInterop({
    history: (state.history ?? []).map((entry) => createAgentStateCommunicateHistoryEntryInterop({
      step: unwrapCodeString(entry.step) ?? "",
      messageIndex: entry.messageIndex,
    })),
    finalSummary: trimmedString(unwrapCodeString(state.finalSummary))!,
    completedSubtitle: trimmedString(unwrapCodeString(state.completedSubtitle))!,
  });
}

type SubagentTracking = {
  readonly lastUsedTimestampMs: bigint;
  readonly subagentType?: SlateSubagentTypeLike | undefined;
};

function subagentTracking(
  subagentStates: ReadonlyMap<string, SubagentTracking>,
): {
  lastUsedSubagentId: string | undefined;
  lastSubagentByType: Map<string, string>;
} {
  let lastUsedSubagentId: string | undefined;
  let maxTimestamp = BigInt(0);
  const typeMaxTimestamps = new Map<string, { id: string; timestamp: bigint }>();
  for (const [subagentId, state] of subagentStates) {
    const timestamp = state.lastUsedTimestampMs;
    const subagentType = state.subagentType;
    if (timestamp > maxTimestamp) {
      maxTimestamp = timestamp;
      lastUsedSubagentId = subagentId;
    }
    if (subagentType) {
      const typeName = slateSubagentTypeName(subagentType);
      const existing = typeMaxTimestamps.get(typeName);
      if (!existing || timestamp > existing.timestamp) {
        typeMaxTimestamps.set(typeName, { id: subagentId, timestamp });
      }
    }
  }
  const lastSubagentByType = new Map<string, string>();
  for (const [typeName, { id }] of typeMaxTimestamps) {
    lastSubagentByType.set(typeName, id);
  }
  return { lastUsedSubagentId, lastSubagentByType };
}

type SerializeMessage = {
  readonly _privacyMode: PrivacyMode;
  readonly role: string;
  readonly content: unknown;
  readonly providerOptions?: unknown;
  readonly id?: unknown;
  readonly [key: string]: unknown;
};

type TokenDetails = {
  readonly promptContextUsageTree?: Parameters<typeof persistPromptContextUsageSnapshot>[0]["usageTree"];
  readonly [key: string]: unknown;
};

type PromptBuilder = {
  appendMessages(messages: unknown | readonly unknown[]): void;
  getState(): readonly SerializeMessage[];
};
type RestorePromptBuilder = PromptBuilder & { clearMessages(): void };
type AgentTurnSerdes = {
  userMessage: Serde<any>;
  conversationStep: Serde<SlateConversationStep>;
};
type RedactedToolCallInput = Parameters<typeof fromInteropToolCallStep>[0];
type ShellTurnSerdes = {
  shellCommand: Serde<unknown>;
  shellOutput: Serde<unknown>;
};
type StepRef =
  | LazyReference<SlateConversationStep, OperationContext>
  | EagerReference<SlateConversationStep, OperationContext>;

export class ShellConversationTurnHandle<Context extends OperationContext = OperationContext> extends Writeable<Context> {
  private readonly blobStore: BlobStore<Context>;
  private readonly serdes: ShellTurnSerdes;
  private turnStructure: SlateShellConversationTurn;
  private blobId: Uint8Array | undefined;
  private dirty: boolean;
  private readonly shellCommand: LazyReference<unknown, Context>;
  private readonly shellOutput: LazyReference<unknown, Context>;

  constructor(
    blobStore: BlobStore<Context>,
    serdes: ShellTurnSerdes,
    turnStructure: SlateShellConversationTurn,
    blobId: Uint8Array | undefined = undefined,
  ) {
    super();
    this.blobStore = blobStore;
    this.serdes = serdes;
    this.turnStructure = turnStructure;
    this.blobId = blobId;
    this.dirty = false;
    this.shellCommand = new LazyReference(serdes.shellCommand, blobStore, this.turnStructure.shellCommandBlobId);
    this.shellOutput = new LazyReference(serdes.shellOutput, blobStore, this.turnStructure.shellOutputBlobId);
  }

  serialize(): Uint8Array {
    return slateConversationTurnSerde.serialize(this.turnStructure);
  }

  override async writeToBlobStore(ctx: Context): Promise<Uint8Array> {
    if (!this.dirty && this.blobId !== undefined) {
      return this.blobId;
    }
    const newShellCommandBlobId = await this.shellCommand.writeToBlobStore(ctx);
    const newShellOutputBlobId = await this.shellOutput.writeToBlobStore(ctx);
    const newTurnStructure = createSlateShellConversationTurn({
      shellCommandBlobId: newShellCommandBlobId,
      shellOutputBlobId: newShellOutputBlobId,
    });
    const serializedWrapper = slateConversationTurnSerde.serialize(newTurnStructure);
    const newBlobId = await getBlobId(serializedWrapper);
    if (this.blobId !== undefined && isEqual(
      this.blobId as unknown as readonly number[],
      newBlobId as unknown as readonly number[],
    )) {
      this.dirty = false;
      return this.blobId;
    }
    metadataObserverForStore(this.blobStore)?.({
      blobId: newBlobId,
      blobType: slateConversationTurnSerde.getBlobType(),
    });
    await this.blobStore.setBlob(ctx, newBlobId, serializedWrapper);
    this.turnStructure = newTurnStructure;
    this.blobId = newBlobId;
    this.dirty = false;
    return newBlobId;
  }

  recordShellOutput(shellOutput: unknown): void {
    this.shellOutput.set(shellOutput);
    this.dirty = true;
  }
}

export class AgentConversationTurnHandle<Context extends OperationContext = OperationContext> extends Writeable<Context> {
  private readonly blobStore: BlobStore<Context>;
  private readonly serdes: AgentTurnSerdes;
  private readonly privacyMode: PrivacyMode;
  private turnStructure: SlateAgentConversationTurn;
  private readonly rootPromptBuilder: PromptBuilder;
  private blobId: Uint8Array | undefined;
  private dirty: boolean;
  readonly userMessage: LazyReference<any, Context>;
  readonly steps: StepRef[];
  private readonly sendMessageStepIndices: number[];

  constructor(
    blobStore: BlobStore<Context>,
    serdes: AgentTurnSerdes,
    privacyMode: PrivacyMode,
    turnStructure: SlateAgentConversationTurn,
    rootPromptBuilder: PromptBuilder,
    blobId: Uint8Array | undefined = undefined,
  ) {
    super();
    this.blobStore = blobStore;
    this.serdes = serdes;
    this.privacyMode = privacyMode;
    this.turnStructure = turnStructure;
    this.rootPromptBuilder = rootPromptBuilder;
    this.blobId = blobId;
    this.dirty = false;
    this.userMessage = new LazyReference(serdes.userMessage, blobStore, turnStructure.userMessageBlobId);
    this.steps = turnStructure.stepBlobIds.map(blobId2 => new LazyReference(serdes.conversationStep, blobStore, blobId2));
    this.sendMessageStepIndices = turnStructure.sendMessageStepIndices.filter(index => index < this.steps.length);
  }

  getInnerStructure(): SlateAgentConversationTurn {
    return this.turnStructure;
  }

  get dynamicToolCount(): number | undefined {
    return this.turnStructure.dynamicToolCount;
  }

  get encryptedModel(): string | undefined {
    return this.turnStructure.encryptedModel;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  setUserMessage(userMessage: unknown): void {
    this.userMessage.set(userMessage);
    this.dirty = true;
  }

  serialize(): Uint8Array {
    return slateConversationTurnSerde.serialize(this.turnStructure);
  }

  appendPromptMessages(messages: readonly unknown[]): void {
    this.rootPromptBuilder.appendMessages(messages);
  }

  private createToolCallStep(toolCall: RedactedToolCallInput, toolCallId?: string): SlateToolCallStep {
    const step = fromInteropToolCallStep(toolCall, toolCallId);
    if (step.kind !== "tool-call") {
      throw new Error("Expected a tool-call step");
    }
    return step;
  }

  recordToolCall(toolCall: RedactedToolCallInput, toolCallId?: string): void {
    const redactedStep = this.createToolCallStep(toolCall, toolCallId);
    if (redactedStep.tool.case === "sendMessageToolCall") {
      this.sendMessageStepIndices.push(this.steps.length);
    }
    this.steps.push(new EagerReference(this.serdes.conversationStep, this.blobStore, redactedStep));
    this.dirty = true;
  }

  async upsertToolCall(ctx: Context, toolCall: RedactedToolCallInput, toolCallId?: string): Promise<void> {
    const redactedStep = this.createToolCallStep(toolCall, toolCallId);
    for (let index = this.steps.length - 1; index >= 0; index -= 1) {
      const step = await this.steps[index]!.get(ctx);
      if (step.kind === "tool-call" && step.toolCallId === toolCallId) {
        this.steps[index]!.set(redactedStep);
        this.dirty = true;
        return;
      }
    }
    if (redactedStep.tool.case === "sendMessageToolCall") {
      this.sendMessageStepIndices.push(this.steps.length);
    }
    this.steps.push(new EagerReference(this.serdes.conversationStep, this.blobStore, redactedStep));
    this.dirty = true;
  }

  async recordThinking(ctx: Context, text: string, durationMs?: number): Promise<void> {
    if (this.steps.length > 0) {
      const lastStepReference = this.steps.at(-1)!;
      const lastStep = await lastStepReference.get(ctx);
      if (
        lastStep.kind === "thinking-message" &&
        !(lastStep.durationMs > 0)
      ) {
        const newStep = createSlateThinkingMessageStep({
          text: lastStep.text.safeTransform(existingText => existingText + text),
          durationMs: durationMs ?? 0,
        });
        lastStepReference.set(newStep);
      } else {
        this.steps.push(new EagerReference(
          this.serdes.conversationStep,
          this.blobStore,
          createSlateThinkingMessageStep({
            text: createRedactedString(text, DataClassification.CODE, "text", this.privacyMode),
            durationMs: durationMs ?? 0,
          }),
        ));
      }
    } else {
      this.steps.push(new EagerReference(
        this.serdes.conversationStep,
        this.blobStore,
        createSlateThinkingMessageStep({
          text: createRedactedString(text, DataClassification.CODE, "text", this.privacyMode),
          durationMs: durationMs ?? 0,
        }),
      ));
    }
    this.dirty = true;
  }

  async recordText(ctx: Context, text: string): Promise<void> {
    if (this.steps.length > 0) {
      const lastStepReference = this.steps.at(-1)!;
      const lastStep = await lastStepReference.get(ctx);
      if (lastStep.kind === "assistant-message") {
        const newStep = createSlateAssistantMessageStep(
          lastStep.text.safeTransform(existingText => existingText + text),
        );
        lastStepReference.set(newStep);
      } else {
        this.steps.push(new EagerReference(
          this.serdes.conversationStep,
          this.blobStore,
          createSlateAssistantMessageStep(
            createRedactedString(text, DataClassification.CODE, "text", this.privacyMode),
          ),
        ));
      }
    } else {
      this.steps.push(new EagerReference(
        this.serdes.conversationStep,
        this.blobStore,
        createSlateAssistantMessageStep(
          createRedactedString(text, DataClassification.CODE, "text", this.privacyMode),
        ),
      ));
    }
    this.dirty = true;
  }

  override async writeToBlobStore(ctx: Context): Promise<Uint8Array> {
    if (!this.dirty && this.blobId !== undefined) {
      return this.blobId;
    }
    const newUserMessageBlobId = await this.userMessage.writeToBlobStore(ctx);
    const newStepsBlobIds = await Promise.all(this.steps.map(step => step.writeToBlobStore(ctx)));
    const newInnerStructure = createSlateAgentConversationTurn({
      userMessageBlobId: newUserMessageBlobId,
      stepBlobIds: newStepsBlobIds,
      sendMessageStepIndices: this.sendMessageStepIndices,
      ...(this.turnStructure.requestId ? { requestId: this.turnStructure.requestId } : {}),
      ...(this.turnStructure.encryptedModel !== undefined && this.turnStructure.encryptedModel.length > 0
        ? { encryptedModel: this.turnStructure.encryptedModel }
        : {}),
      ...(this.turnStructure.dynamicToolCount !== undefined ? { dynamicToolCount: this.turnStructure.dynamicToolCount } : {}),
    });
    const serializedWrapper = slateConversationTurnSerde.serialize(newInnerStructure);
    const newBlobId = await getBlobId(serializedWrapper);
    if (this.blobId !== undefined && isEqual(
      this.blobId as unknown as readonly number[],
      newBlobId as unknown as readonly number[],
    )) {
      this.dirty = false;
      return this.blobId;
    }
    metadataObserverForStore(this.blobStore)?.({
      blobId: newBlobId,
      blobType: slateConversationTurnSerde.getBlobType(),
    });
    await this.blobStore.setBlob(ctx, newBlobId, serializedWrapper);
    this.turnStructure = newInnerStructure;
    this.blobId = newBlobId;
    this.dirty = false;
    return newBlobId;
  }
}

type RedactedField<T> = {
  unwrap(purpose: PrivacyCapability, options?: object): T;
};

type MessageBlobTarget = {
  text: string;
  textBlobId?: Uint8Array;
  richText?: string;
  richTextBlobId?: Uint8Array;
};

type BranchRef = {
  readonly repoPath: string;
  readonly branchName: string;
};

type ConversationStateBlobs = SlateConversationState;

type RestoreSettings = {
  readonly shouldTrackAgentTypeChange?: boolean;
  readonly loadRootPromptBlobs?: boolean;
  readonly restoreBlobFetchConcurrency?: number;
  readonly serializeSubagentStatesAsBlobRefs?: boolean;
  readonly onRootPromptImagePresence?: (presence: ReturnType<typeof computeCoreMessageImagePresence>) => void;
};

type TurnOptions = {
  readonly isProjectKickoff?: boolean;
  readonly additionalUserTurnSystemReminder?: string;
  readonly dynamicToolCount?: number;
  readonly dynamicToolMetaNames?: {
    readonly discoveryToolName: string;
    readonly invocationToolName: string;
  };
};

type ProjectPrompt = NonNullable<Parameters<typeof formatProjectPrompt>[1]>["promptText"];

type TurnConfig = Parameters<typeof processSelectedContext>[3] & InteropModeProcessingConfig & {
  readonly featureFlags?: NonNullable<Parameters<typeof processSelectedContext>[3]["featureFlags"]> & {
    readonly enableTrackedGitRepoState?: boolean;
    readonly glassMetaParentAgent?: boolean;
    readonly skipPreTurnStateSnapshot?: boolean;
    readonly overlapPreTurnStateSnapshot?: boolean;
    readonly enhancedBranchChangeReminder?: boolean;
    readonly cloudCoordinatorToolsEnabled?: boolean;
    readonly userMessageTimestamps?: boolean;
    readonly enableHookAdditionalContext?: boolean;
    readonly enableAgentStoreConflictNotices?: boolean;
  };
  readonly model?: { readonly mcid?: string };
  readonly encryptedMcidAndParams?: string;
  readonly decryptMcidAndParams?: (encrypted: string) => string | undefined;
  readonly isEagerEditingModel?: boolean;
  readonly projectPromptTextGenerator?: () => ProjectPrompt;
};

type TurnAccessor = Parameters<typeof processSelectedContext>[5];
type TurnRequest = AgentStateRequestContextInterop & ModeProcessingRequestContext;

type CodecSet = ReturnType<typeof createSerdes>;
type TurnUnion = AgentConversationTurnHandle | ShellConversationTurnHandle;
type ValueRef<Context extends OperationContext> = EagerReference<any, Context> | LazyReference<any, Context>;
type UsageDelta = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number;
};
type FileStateReferencesByPath<Context extends OperationContext> = {
  content: FileStateBlobReference<Context>;
  initialContent: FileStateBlobReference<Context>;
};

export class ConversationStateHandle {
  blobStore: BlobStore<OperationContext>;
  conversationStateStructure: ConversationStateBlobs;
  rootPromptBuilder: RestorePromptBuilder;
  formattingOptions: unknown;
  modelId: string | undefined;
  agentTypeChangedFromPersistedState: boolean;
  isRootProjectConversation: boolean;
  plans: Map<string, SlatePlanRegistryEntry>;
  fileStates: Map<string, FileStateReferencesByPath<OperationContext>>;
  readPaths: Set<string>;
  completedAskQuestionToolCallIds: Set<string>;
  communicateUpdateHistory: AgentStateCommunicateHistoryEntryInterop[];
  communicateUpdateStatesByParentToolCallId: Map<string, AgentStateCommunicateTurnStateInterop>;
  backgroundSummarizationPromiseInfo: unknown;
  messagesUndergoingSummarization: unknown;
  backgroundSummarizationHasCompleted: boolean;
  backgroundSummarizationGenerationDurationMs: number | null;
  backgroundSummarizationCancellationToken: unknown;
  tokenDetailsStaleAfterSummarization: boolean;
  summaryArchives: ValueRef<OperationContext>[];
  selfSummaryCount: number;
  selfSummaryInputLimitFailureTokenCount: number;
  trackedGitRepoBranches: BranchRef[];
  subagentStates: Map<string, SlateSubagentPersistedState>;
  subagentRunsByParentToolCallId: Map<string, SlateSubagentRunState>;
  subagentThreads: Map<string, string>;
  lastSubagentByType: Map<string, string>;
  lastUsedSubagentId: string | undefined;
  turnUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
  pendingComputeStructure: Promise<ConversationStateBlobs> | null;
  skippedRootPromptBlobs: boolean;
  originalRootPromptMessagesJson: Uint8Array[];
  rootPromptPrefixInvalidated: boolean;
  userTurnMessageIdsIndexedTurnCount: number;
  userTurnMessageIdsIndex: Set<string> | undefined;
  privacyMode: PrivacyMode;
  serdes: CodecSet;
  serializeSubagentStatesAsBlobRefs: boolean;
  fetchConcurrency: number;
  previousWorkspaceUris: RedactedField<string>[] | undefined;
  /** Slate's mode is the in-memory policy value; the persisted state keeps its legacy wire encoding. */
  slateMode: SlateModeValue | undefined;
  agentType: ReturnType<typeof resolveAgentType>;
  activeBranchName: string | undefined;
  conversationStartedTimestampMs: bigint | undefined;
  conversationStartedTimeZone: string | undefined;
  turns: ValueRef<OperationContext>[];
  todos: ValueRef<OperationContext>[];
  tokenDetails: TokenDetails;
  summary: ValueRef<OperationContext> | undefined;
  plan: ValueRef<OperationContext> | undefined;
  communicateUpdateFinalSummary: string | undefined;
  communicateUpdateCompletedSubtitle: string | undefined;
  goalState: SlateGoalState | undefined;

  createConversationTurnHandleSerde(): Serde<TurnUnion> {
    return {
      deserialize: (blob) => {
        const turnStructure = slateConversationTurnSerde.deserialize(blob);
        switch (turnStructure.kind) {
          case "agent":
            return new AgentConversationTurnHandle(this.blobStore, this.serdes, this.privacyMode, turnStructure, this.rootPromptBuilder);
          case "shell":
            return new ShellConversationTurnHandle(this.blobStore, this.serdes, turnStructure);
        }
      },
      serialize: (value) => value.serialize(),
      getBlobType: () => ({
        ...slateConversationTurnSerde.getBlobType(),
      }),
    };
  }

  getRawPendingMessages(): readonly RedactedField<string>[] | undefined {
    return this.conversationStateStructure.pendingToolCalls;
  }

  assertRootPromptBlobsLoadedForFullPromptRead(): void {
    if (!this.skippedRootPromptBlobs) return;
    throw new Error("Cannot read full root prompt messages when root prompt blobs were not loaded");
  }

  invalidateRootPromptPrefix(): void {
    if (this.skippedRootPromptBlobs) {
      this.rootPromptPrefixInvalidated = true;
    }
  }

  static async fromConversationStateStructure(
    ctx: OperationContext,
    blobStore: BlobStore<OperationContext>,
    conversationStateInterop: RedactedAgentConversationStateInterop,
    rootPromptBuilder: RestorePromptBuilder,
    formattingOptions: unknown,
    modelId: string | undefined,
    runtimeAgentType: ReturnType<typeof resolveAgentType>,
    restoreOptions?: RestoreSettings,
  ): Promise<ConversationStateHandle> {
    const conversationStateStructure = fromInteropConversationState(conversationStateInterop)
    const restoreEnv: DisposableEnvironmentEntry = { stack: [], error: undefined, hasError: false };
    try {
      const span = createSpan(ctx.withName("fromConversationStateStructure"));
      addDisposableResource(restoreEnv, span, false);
      const restoreStartedAt = performance.now();
      let blobFetches = 0;
      const trackAgentTypeChange = restoreOptions?.shouldTrackAgentTypeChange ?? false;
      const loadPromptBlobs = restoreOptions?.loadRootPromptBlobs ?? true;
      const fetchConcurrency = restoreOptions?.restoreBlobFetchConcurrency ?? RESTORE_FETCH_CONCURRENCY;
      const serdes = createSerdes(conversationStateStructure.privacyMode);
      let promptBytes = 0;
      let promptImageBytes = 0;
      let promptImageParts = 0;
      let promptMessages = 0;
      const promptPhaseStart = performance.now();
      if (loadPromptBlobs) {
        const promptSpan = createSpan(span.ctx.withName("loadRootPromptMessages"));
        const quietPromptCtx = withSuppressedChildSpans(promptSpan.ctx);
        const promptLoads = await asyncMapValues(conversationStateStructure.rootPromptMessagesJson, async (blobId) => {
          const blob = await blobStore.getBlob(quietPromptCtx, blobId);
          blobFetches++;
          if (!blob) {
            return { kind: "missing" as const, blobIdHex: toHex(blobId) };
          }
          try {
            const message = serdes.coreMessage.deserialize(blob);
            messageBlobCache.set(message, { blobId, blobData: blob });
            const plainMessage = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
            const imageStats = imagePayloadStats(plainMessage);
            return {
              kind: "loaded" as const,
              entry: {
                message,
                plainMessage,
                blobBytes: blob.byteLength,
                imageBytes: imageStats.imageBytes,
                imagePartCount: imageStats.imagePartCount,
              },
            };
          } catch (error4) {
            return { kind: "failed" as const, error: error4 };
          }
        }, { max: fetchConcurrency });
        const missingPromptBlobs = promptLoads.flatMap((load2) => load2.kind === "missing" ? [load2.blobIdHex] : []);
        if (missingPromptBlobs.length > 0) {
          promptSpan.span.setAttribute("missingBlobCount", missingPromptBlobs.length);
          promptSpan.span.end();
          throw new BlobNotFoundError(missingPromptBlobs);
        }
        const failedLoad = promptLoads.find((load2) => load2.kind === "failed");
        if (failedLoad !== undefined && failedLoad.kind === "failed") {
          promptSpan.span.end();
          throw failedLoad.error;
        }
        const promptEntries = promptLoads.flatMap((load2) => load2.kind === "loaded" ? [load2.entry] : []);
        const promptValues = promptEntries.map(({ message }) => message);
        if (restoreOptions?.onRootPromptImagePresence !== undefined) {
          const plainPromptValues = promptEntries.map(({ plainMessage }) => plainMessage);
          restoreOptions.onRootPromptImagePresence(computeCoreMessageImagePresence(plainPromptValues));
        }
        promptBytes = promptEntries.reduce((total, entry) => total + entry.blobBytes, 0);
        promptImageBytes = promptEntries.reduce((total, entry) => total + entry.imageBytes, 0);
        promptImageParts = promptEntries.reduce((total, entry) => total + entry.imagePartCount, 0);
        promptMessages = promptValues.length;
        for (const { message, plainMessage } of promptEntries) {
          plainToRedacted.set(plainMessage, message);
        }
        rootPromptBuilder.clearMessages();
        rootPromptBuilder.appendMessages(promptValues);
        promptSpan.span.setAttribute("getBlobCount", blobFetches);
        promptSpan.span.setAttribute("rootPromptBytes", promptBytes);
        promptSpan.span.setAttribute("rootPromptImageBytes", promptImageBytes);
        promptSpan.span.setAttribute("rootPromptImagePartCount", promptImageParts);
        promptSpan.span.end();
      } else {
        rootPromptBuilder.clearMessages();
        promptMessages = conversationStateStructure.rootPromptMessagesJson.length;
      }
      const promptPhaseMs = performance.now() - promptPhaseStart;
      const fileSpan = createSpan(span.ctx.withName("loadFileStates"));
      const quietFileCtx = withSuppressedChildSpans(fileSpan.ctx);
      const state = new ConversationStateHandle(blobStore, conversationStateInterop, rootPromptBuilder, formattingOptions, modelId, restoreOptions);
      const subagentPhaseStart = performance.now();
      await state.loadSubagentStateRefs(quietFileCtx);
      const subagentPhaseMs = performance.now() - subagentPhaseStart;
      state.skippedRootPromptBlobs = !loadPromptBlobs;
      state.originalRootPromptMessagesJson = loadPromptBlobs ? [] : [...conversationStateStructure.rootPromptMessagesJson];
      const savedAgentType = state.agentType;
      if (runtimeAgentType !== undefined) {
        state.agentTypeChangedFromPersistedState = trackAgentTypeChange && savedAgentType !== undefined && savedAgentType !== runtimeAgentType;
        state.agentType = runtimeAgentType;
      }
      const fileEntries = Array.from(conversationStateStructure.fileStatesV2.entries());
      const fileLoadStart = performance.now();
      for (const [pathValue, fileState] of fileEntries) {
        state.fileStates.set(pathValue, {
          content: fileState.contentBlobId !== undefined
            ? new LazyReference(utf8Serde, blobStore, fileState.contentBlobId)
            : undefined,
          initialContent: fileState.initialContentBlobId !== undefined
            ? new LazyReference(utf8Serde, blobStore, fileState.initialContentBlobId)
            : undefined,
        });
      }
      fileSpan.span.setAttribute("fileStatePathCount", fileEntries.length);
      fileSpan.span.end();
      const filePhaseMs = performance.now() - fileLoadStart;
      for (const path29 of conversationStateStructure.readPaths) {
        state.recordReadPath(path29);
      }
      for (const toolCallId of conversationStateStructure.completedAskQuestionToolCallIds ?? []) {
        state.completedAskQuestionToolCallIds.add(toolCallId);
      }
      if (conversationStateStructure.plans !== undefined) {
        for (const [planId, redactedEntry] of conversationStateStructure.plans) {
          state.plans.set(
            planId,
            fromInteropPlanRegistryEntry(
              fromRedactedPlanRegistryEntryInterop(
                redactedEntry,
                PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
                undefined,
              ),
            ),
          );
        }
      }
      if (conversationStateStructure.goalState !== undefined) {
        state.goalState = fromInteropGoalState(
          fromRedactedGoalStateInterop(
            conversationStateStructure.goalState,
            PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
            undefined,
          ),
        );
      }
      const restoreMs = performance.now() - restoreStartedAt;
      const crossedLarge = promptBytes >= LARGE_RESTORE_BYTES || promptImageBytes >= LARGE_RESTORE_IMAGE || restoreMs >= SLOW_RESTORE_MS;
      recordRestoreMetrics({
        context: span.ctx,
        restoreDurationMs: restoreMs,
        rootPromptPhaseMs: promptPhaseMs,
        fileStatesPhaseMs: filePhaseMs,
        subagentStateRefsPhaseMs: subagentPhaseMs,
        rootPromptMessageCount: promptMessages,
        turnReferenceCount: conversationStateStructure.turns.length,
        fileStatePathCount: fileEntries.length,
        rootPromptBytes: promptBytes,
        restoreBlobFetchConcurrency: fetchConcurrency,
        crossedLargeThreshold: crossedLarge,
      });
      if (crossedLarge) {
        const memoryUsage = process.memoryUsage();
        stateLog.warn(span.ctx, "Large conversation state restore", {
          restoreMs,
          promptBytes,
          promptImageBytes,
          promptImageParts,
          promptMessages,
          turnReferenceCount: conversationStateStructure.turns.length,
          fileStateCount: fileEntries.length,
          rss: memoryUsage.rss,
          heapUsed: memoryUsage.heapUsed,
          external: memoryUsage.external,
          arrayBuffers: memoryUsage.arrayBuffers,
        });
      }
      return state;
    } catch (e_1) {
      restoreEnv.error = e_1;
      restoreEnv.hasError = true;
      throw e_1;
    } finally {
      disposeResources(restoreEnv);
    }
  }

  constructor(
    blobStore: BlobStore<OperationContext>,
    conversationStateInterop: RedactedAgentConversationStateInterop,
    rootPromptBuilder: RestorePromptBuilder,
    formattingOptions: unknown,
    modelId: string | undefined,
    restoreOptions?: RestoreSettings,
  ) {
    this.blobStore = blobStore;
    this.conversationStateStructure = fromInteropConversationState(conversationStateInterop);
    this.rootPromptBuilder = rootPromptBuilder;
    this.formattingOptions = formattingOptions;
    this.modelId = modelId;
    this.agentTypeChangedFromPersistedState = false;
    this.isRootProjectConversation = false;
    this.plans = new Map();
    this.fileStates = new Map();
    this.readPaths = new Set();
    this.completedAskQuestionToolCallIds = new Set();
    this.communicateUpdateHistory = [];
    this.communicateUpdateStatesByParentToolCallId = new Map();
    this.backgroundSummarizationPromiseInfo = null;
    this.messagesUndergoingSummarization = null;
    this.backgroundSummarizationHasCompleted = false;
    this.backgroundSummarizationGenerationDurationMs = null;
    this.backgroundSummarizationCancellationToken = null;
    this.tokenDetailsStaleAfterSummarization = false;
    this.summaryArchives = [];
    this.selfSummaryCount = 0;
    this.selfSummaryInputLimitFailureTokenCount = 0;
    this.trackedGitRepoBranches = [];
    this.subagentStates = new Map();
    this.subagentRunsByParentToolCallId = new Map();
    this.subagentThreads = new Map();
    this.lastSubagentByType = new Map();
    this.turnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    this.pendingComputeStructure = null;
    this.skippedRootPromptBlobs = false;
    this.originalRootPromptMessagesJson = [];
    this.rootPromptPrefixInvalidated = false;
    this.userTurnMessageIdsIndexedTurnCount = 0;
    this.privacyMode = this.conversationStateStructure.privacyMode;
    this.serdes = createSerdes(this.privacyMode);
    this.serializeSubagentStatesAsBlobRefs = restoreOptions?.serializeSubagentStatesAsBlobRefs === true;
    this.fetchConcurrency = restoreOptions?.restoreBlobFetchConcurrency ?? RESTORE_FETCH_CONCURRENCY;
    this.previousWorkspaceUris = this.conversationStateStructure.previousWorkspaceUris.length > 0 ? [...this.conversationStateStructure.previousWorkspaceUris] : undefined;
    this.trackedGitRepoBranches = (this.conversationStateStructure.trackedGitRepoBranches ?? []).map((repo) => ({
      repoPath: repo.repoPath.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      branchName: repo.branchName,
    }));
    this.slateMode = this.conversationStateStructure.mode;
    this.agentType = resolveAgentType(this.conversationStateStructure.agentType);
    this.activeBranchName = this.conversationStateStructure.activeBranchName;
    this.isRootProjectConversation = this.conversationStateStructure.isRootProjectConversation === true;
    this.conversationStartedTimestampMs = this.conversationStateStructure.conversationStartedTimestampMs;
    this.conversationStartedTimeZone = this.conversationStateStructure.conversationStartedTimeZone;
    const conversationTurnHandleSerde = this.createConversationTurnHandleSerde();
    this.turns = this.conversationStateStructure.turns.map((blobId) => new LazyReference(conversationTurnHandleSerde, this.blobStore, blobId));
    this.todos = this.conversationStateStructure.todos.map((blobId) => new LazyReference(this.serdes.todoItem, this.blobStore, blobId));
    this.tokenDetails = this.conversationStateStructure.tokenDetails ?? createRedactedConversationTokenDetailsInterop(this.conversationStateStructure.privacyMode, {});
    if (this.conversationStateStructure.summary !== undefined) {
      this.summary = new LazyReference(this.serdes.conversationSummary, this.blobStore, this.conversationStateStructure.summary);
    }
    if (this.conversationStateStructure.plan !== undefined) {
      this.plan = new LazyReference(this.serdes.conversationPlan, this.blobStore, this.conversationStateStructure.plan);
    }
    if (this.conversationStateStructure.summaryArchives.length > 0) {
      this.summaryArchives = this.conversationStateStructure.summaryArchives.map((blobId) => new LazyReference(this.serdes.conversationSummaryArchive, this.blobStore, blobId));
    }
    this.selfSummaryCount = this.conversationStateStructure.selfSummaryCount ?? 0;
    if (this.conversationStateStructure.subagentStates !== undefined) {
      for (const [subagentId, redactedState] of this.conversationStateStructure.subagentStates) {
        this.subagentStates.set(
          subagentId,
          fromInteropSubagentPersistedState(
            fromRedactedSubagentPersistedStateInterop(
              redactedState,
              PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
              undefined,
            ),
            this.privacyMode,
          ),
        );
      }
    }
    if (this.conversationStateStructure.subagentRunsByParentToolCallId !== undefined) {
      for (const [parentToolCallId, redactedState] of this.conversationStateStructure.subagentRunsByParentToolCallId) {
        const persistedState = fromRedactedSubagentRunStateInterop(
          redactedState,
          PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
          undefined,
        );
        this.subagentRunsByParentToolCallId.set(parentToolCallId, fromInteropSubagentRunState(persistedState));
      }
    }
    const persistedSubagentThreads = this.conversationStateStructure.subagentThreads;
    if (persistedSubagentThreads instanceof Map) {
      for (const [subagentId, threadId] of persistedSubagentThreads) {
        const normalizedThreadId = trimmedString(threadId);
        if (normalizedThreadId !== undefined) this.subagentThreads.set(subagentId, normalizedThreadId);
      }
    } else if (persistedSubagentThreads !== undefined) {
      for (const [subagentId, threadId] of Object.entries(persistedSubagentThreads)) {
        const normalizedThreadId = trimmedString(threadId);
        if (normalizedThreadId !== undefined) this.subagentThreads.set(subagentId, normalizedThreadId);
      }
    }
    const legacyCommunicateUpdateHistory = (this.conversationStateStructure.communicateUpdateHistory ?? []).map((entry) => createAgentStateCommunicateHistoryEntryInterop({
      step: entry.step.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      messageIndex: entry.messageIndex,
    }));
    this.communicateUpdateFinalSummary = this.conversationStateStructure.communicateUpdateFinalSummary?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    this.communicateUpdateCompletedSubtitle = this.conversationStateStructure.communicateUpdateCompletedSubtitle?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    this.communicateUpdateHistory = legacyCommunicateUpdateHistory;
    const persistedCommunicateUpdateStatesByParentToolCallId = this.conversationStateStructure.communicateUpdateStatesByParentToolCallId;
    if (persistedCommunicateUpdateStatesByParentToolCallId instanceof Map) {
      for (const [parentToolCallId, state] of persistedCommunicateUpdateStatesByParentToolCallId) {
        this.communicateUpdateStatesByParentToolCallId.set(parentToolCallId, createAgentStateCommunicateTurnStateInterop({ ...communicateState(state) }));
      }
    } else if (persistedCommunicateUpdateStatesByParentToolCallId !== undefined) {
      for (const [parentToolCallId, state] of Object.entries(persistedCommunicateUpdateStatesByParentToolCallId)) {
        this.communicateUpdateStatesByParentToolCallId.set(parentToolCallId, createAgentStateCommunicateTurnStateInterop({ ...communicateState(state) }));
      }
    }
    this.computeSubagentTrackingFromTimestamps();
  }

  async createAgentTurn(
    parentContext: OperationContext,
    incomingRecord: UserMessageInterop,
    hostContext: TurnRequest,
    turnSettings: TurnConfig,
    resourceAccessor: TurnAccessor | undefined,
    restoreOptions?: TurnOptions,
  ): Promise<AgentConversationTurnHandle> {
    const turnEnv: DisposableEnvironmentEntry = { stack: [], error: undefined, hasError: false };
    try {
      const span = createSpan(parentContext.withName("createAgentTurn"));
      addDisposableResource(turnEnv, span, false);
      const ctx = span.ctx;
      let userMessage = fromInteropUserMessage(incomingRecord);
      if (userMessage.isSimulatedMsg !== true) {
        this.resetSelfSummaryCount();
      }
      const projectSubagentDetails = userMessage.projectDetails?.subagent;
      const projectSideChatDetails = userMessage.projectDetails?.sideChat;
      const rootProjectMessage = userMessage.projectDetails !== undefined && projectSubagentDetails === undefined && projectSideChatDetails === undefined;
      if (rootProjectMessage) {
        this.isRootProjectConversation = true;
      }
      this.getOrInitializeConversationStartedDate(hostContext.env?.timeZone);
      const sendMessageEnabled = canRootConversationSendToProject(this);
      const isProject = rootProjectMessage;
      const isProjectKickoff = isProject && (restoreOptions?.isProjectKickoff ?? this.turns.length === 0);
      const projectLabel = isProjectKickoff ? normalizeProjectName(unwrapCodeString(userMessage.projectDetails?.name)) : undefined;
      const childProjectLabel = projectSubagentDetails !== undefined || projectSideChatDetails !== undefined
        ? normalizeProjectName(unwrapCodeString(userMessage.projectDetails?.name))
        : undefined;
      const skipSnapshot = turnSettings.featureFlags?.skipPreTurnStateSnapshot === true;
      const overlapSnapshot = !skipSnapshot && turnSettings.featureFlags?.overlapPreTurnStateSnapshot === true;
      const snapshotStartedAt = performance.now();
      let snapshotFinishedAt = snapshotStartedAt;
      const snapshotBlobPromise = skipSnapshot
        ? Promise.resolve(undefined)
        : (async (): Promise<Uint8Array> => {
          const snapshotValue = await this.computeNewStructure(ctx);
          const snapshotBytes = serializeRedactedConversationStateInterop(snapshotValue);
          const snapshotBlobId = await getBlobId(snapshotBytes);
          snapshotFinishedAt = performance.now();
          stateSnapshotHistogram.histogram(ctx, snapshotFinishedAt - snapshotStartedAt, {
            overlap: overlapSnapshot ? "true" : "false",
          });
          metadataObserverForStore(this.blobStore)?.({
            blobId: snapshotBlobId,
            blobType: { kind: "proto", typeName: "agent.v1.RedactedConversationStateStructure" },
          });
          void this.blobStore.setBlob(ctx, snapshotBlobId, snapshotBytes);
          return snapshotBlobId;
        })();
      const preparationStartedAt = performance.now();
      if (overlapSnapshot) {
        void snapshotBlobPromise.catch(() => undefined);
      }
      let snapshotBlobId: Uint8Array | undefined;
      if (!overlapSnapshot) {
        snapshotBlobId = await snapshotBlobPromise;
      }
      userMessage = cloneSlateUserMessage(userMessage);
      if (snapshotBlobId !== undefined) {
        userMessage.conversationStateBlobId = new Uint8Array(snapshotBlobId);
      }
      if (!overlapSnapshot && userMessage.projectDetails !== undefined) {
        const keptName = projectLabel ?? childProjectLabel;
        if (keptName !== undefined) {
          userMessage.projectDetails.name = keptName;
        } else {
          delete userMessage.projectDetails.name;
        }
      }
      await this.hydrateUserMessageBlobText(ctx, userMessage);
      const turnMode = resolveCurrentTurnMode(this.slateMode, userMessage.mode);
      const { userContent: contentParts, selectedImages, selectedVideos, selectedDocuments, imageFilePaths } = await processSelectedContext(
        ctx,
        (userMessage.selectedContext as never) ?? emptyAgentSelectedContextInterop(),
        this.blobStore,
        turnSettings,
        hostContext,
        resourceAccessor,
        toInteropAgentMode(turnMode),
        this.modelId,
        userMessage.text,
        toInteropSimulatedMessageReason(userMessage.simulatedMsgReason),
        this.privacyMode,
      );
      if (overlapSnapshot) {
        const joinStartedAt = performance.now();
        snapshotBlobId = await snapshotBlobPromise;
        snapshotJoinHistogram.histogram(ctx, performance.now() - joinStartedAt);
        overlapSavedHistogram.histogram(ctx, Math.max(0, Math.min(snapshotFinishedAt, joinStartedAt) - preparationStartedAt));
        if (snapshotBlobId !== undefined) {
          userMessage.conversationStateBlobId = new Uint8Array(snapshotBlobId);
        }
        if (userMessage.projectDetails !== undefined) {
          const keptName = projectLabel ?? childProjectLabel;
          if (keptName !== undefined) {
            userMessage.projectDetails.name = keptName;
          } else {
            delete userMessage.projectDetails.name;
          }
        }
      }
      if (imageFilePaths.length > 0 && turnSettings.enableImageFiles) {
        const imageFilesText = `<image_files>
The following images were provided by the user and saved to the workspace for future use:
${imageFilePaths.map((path29, i) => `${i + 1}. ${path29}`).join("\n")}

These images can be copied for use in other locations.
</image_files>`;
        contentParts.push({ type: "text", text: imageFilesText });
      }
      let priorMode: SlateModeValue | undefined;
      if (this.turns.length > 0) {
        priorMode = this.slateMode;
      }
      const priorAgentType = this.hasAgentTypeChangedFromPersistedState() === true
        ? resolveAgentType(this.conversationStateStructure.agentType)
        : this.agentType;
      const workspaceValues = workspaceUrisFrom(parentContext, hostContext);
      const workspaceReminder = processWorkspaceChangeReminder(
        parentContext,
        workspaceValues.map((uri) => uri.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)),
        this.previousWorkspaceUris?.map((uri) => uri.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)),
        this.agentType,
        priorAgentType,
      );
      if (workspaceReminder) {
        const needsNewline = contentParts.length > 0;
        contentParts.push({ type: "text", text: needsNewline ? `\n\n${workspaceReminder}` : workspaceReminder });
      }
      this.previousWorkspaceUris = workspaceValues.length > 0 ? [...workspaceValues] : undefined;
      const gitBranchesNow = trackedGitBranches(hostContext.gitRepos);
      if (turnSettings.featureFlags?.enableTrackedGitRepoState === true) {
        const gitNotice = gitReminder(
          this.trackedGitRepoBranches,
          hostContext.gitRepos,
          turnSettings.featureFlags.enhancedBranchChangeReminder === true,
        );
        if (gitNotice) {
          const needsNewline = contentParts.length > 0;
          contentParts.push({ type: "text", text: needsNewline ? `\n\n${gitNotice}` : gitNotice });
        }
      }
      this.trackedGitRepoBranches = gitBranchesNow;
      const reminderMode = resolveCurrentTurnMode(this.slateMode, userMessage.mode);
      const modeReminder = processModeSystemReminderWithInteropConfig(reminderMode, turnSettings, hostContext, priorMode);
      const suppressMultitaskNotice = this.turns.length === 0 && turnSettings.userInfoDisplayOptions?.disable !== true && reminderMode === SlateMode.MULTITASK;
      const subagentStoreDir = unwrapCodeString(projectSubagentDetails?.storeDir);
      const subagentConversationId = getConversationId(ctx);
      const firstThreadMessage = restoreOptions?.isProjectKickoff ?? this.turns.length === 0;
      const subagentPrompt = projectSubagentDetails !== undefined && subagentConversationId !== undefined && firstThreadMessage
        ? (() => {
          const projectPromptText = turnSettings.projectPromptTextGenerator?.();
          return formatProjectThreadPrompt({
            ...(childProjectLabel !== undefined ? { projectLabel: childProjectLabel } : {}),
            storeDir: subagentStoreDir!,
            subagentId: subagentConversationId,
            ...(projectPromptText !== undefined ? { promptText: projectPromptText } : {}),
          });
        })()
        : subagentStoreDir !== undefined && subagentConversationId !== undefined
          ? formatProjectSubagentPrompt({ storeDir: subagentStoreDir, subagentId: subagentConversationId })
          : undefined;
      const sideChatStoreDir = unwrapCodeString(projectSideChatDetails?.storeDir);
      const sideChatPrompt = sideChatStoreDir !== undefined
        ? (() => {
          const projectPromptText = turnSettings.projectPromptTextGenerator?.();
          return formatProjectSideChatPrompt({
            ...(childProjectLabel !== undefined ? { projectLabel: childProjectLabel } : {}),
            storeDir: sideChatStoreDir,
            ...(projectPromptText !== undefined ? { promptText: projectPromptText } : {}),
          });
        })()
        : undefined;
      const childPrompt = subagentPrompt ?? sideChatPrompt;
      const rootProjectPrompt = isProject
        ? (() => {
          const projectPromptText = turnSettings.projectPromptTextGenerator?.();
          return `<system_reminder>\n${formatProjectPrompt(isProjectKickoff ? "initial" : "reminder", {
            ...(projectLabel !== undefined ? { projectLabel } : {}),
            ...(projectPromptText !== undefined ? { promptText: projectPromptText } : {}),
            sendMessageEnabled,
            coordinatorToolsEnabled: turnSettings.featureFlags?.cloudCoordinatorToolsEnabled === true,
          })}\n</system_reminder>`;
        })()
        : childPrompt !== undefined
          ? `<system_reminder>\n${childPrompt}\n</system_reminder>`
          : "";
      const turnReminders = joinUserTurnSystemReminders(
        restoreOptions?.additionalUserTurnSystemReminder ?? "",
        processAntiAskQuestionSystemReminder(turnSettings),
        suppressMultitaskNotice ? "" : modeReminder,
        rootProjectPrompt,
      );
      if (turnReminders) {
        const needsNewline = contentParts.length > 0;
        contentParts.push({ type: "text", text: needsNewline ? `\n\n${turnReminders}` : turnReminders });
      }
      const subagentNotice = userMessage.subagentSystemReminder !== undefined && userMessage.subagentSystemReminder !== ""
        ? `<system_reminder>\n${userMessage.subagentSystemReminder}\n</system_reminder>`
        : "";
      if (subagentNotice) {
        const needsNewline = contentParts.length > 0;
        contentParts.push({ type: "text", text: needsNewline ? `\n\n${subagentNotice}` : subagentNotice });
      }
      const priorTurn = await getPreviousAgentConversationTurn(ctx, this.turns);
      const priorModel = priorTurn !== undefined ? decryptModelMcid(priorTurn, turnSettings.decryptMcidAndParams) : undefined;
      const newModel = turnSettings.model?.mcid;
      const skipReminders = userMessage.simulatedMsgReason === SlateSimulatedMessageReason.BACKGROUND_TASK_COMPLETION;
      if (!skipReminders && priorModel !== undefined && priorModel.length > 0 && newModel !== undefined && newModel.length > 0 && turnSettings.encryptedMcidAndParams !== undefined && turnSettings.encryptedMcidAndParams.length > 0 && priorModel !== newModel) {
        const needsNewline = contentParts.length > 0;
        contentParts.push({ type: "text", text: needsNewline ? `\n\n${MODEL_SWITCH_NOTICE}` : MODEL_SWITCH_NOTICE });
      }
      const dynamicToolCount = restoreOptions?.dynamicToolCount;
      const dynamicToolNames = restoreOptions?.dynamicToolMetaNames;
      if (!skipReminders && dynamicToolCount !== undefined && dynamicToolCount > 0 && dynamicToolNames !== undefined) {
        const priorDynamicToolCount = await getPreviousRecordedDynamicToolCount(ctx, this.turns);
        if (priorDynamicToolCount === 0) {
          const reminder = dynamicToolsReminder(dynamicToolNames);
          const needsNewline = contentParts.length > 0;
          contentParts.push({ type: "text", text: needsNewline ? `\n\n${reminder}` : reminder });
        }
      }
      const pluginNotice = pluginReminder(hostContext.recentlyAddedPlugin);
      if (pluginNotice) {
        const needsNewline = contentParts.length > 0;
        contentParts.push({ type: "text", text: needsNewline ? `\n\n${pluginNotice}` : pluginNotice });
      }
      const allHookContexts = turnSettings.featureFlags?.enableHookAdditionalContext === true;
      const conflictNotices = turnSettings.featureFlags?.enableAgentStoreConflictNotices === true;
      if (allHookContexts || conflictNotices) {
        const receivedHookContexts = userMessage.hookContexts
        const hookContexts = allHookContexts
          ? receivedHookContexts
          : receivedHookContexts.filter((context) => context.event === "agentStoreConflict");
        for (const hookContext of hookContexts) {
          const hookNotice = renderHookContextReminder(hookContext.text);
          if (hookNotice) {
            const needsNewline = contentParts.length > 0;
            contentParts.push({ type: "text", text: needsNewline ? `\n\n${hookNotice}` : hookNotice });
          }
        }
      }
      const eagerNote = turnSettings.isEagerEditingModel === true
        ? `<system_reminder>\nIMPORTANT: It is bad to be over-eager with making edits vs just answering the question when that is not what the user wants. Think carefully before deciding to edit.\n</system_reminder>\n`
        : "";
      const timePrefix = turnSettings.featureFlags?.userMessageTimestamps === true ? buildTimestampPrefix(hostContext.env?.timeZone) : "";
      const referenceResolution = promptReferenceId(turnSettings.featureFlags?.glassMetaParentAgent === true, userMessage.promptReferenceId, userMessage.messageId, contentParts);
      if (referenceResolution.shouldIncludePromptReferenceIdTag && referenceResolution.promptReferenceId !== undefined) {
        contentParts.unshift({ type: "text", text: renderUserMessageIdTag(referenceResolution.promptReferenceId) });
      }
      const messageIdTag = sendMessageEnabled && exposeIncomingMessageId({
        isSimulatedMsg: userMessage.isSimulatedMsg === true,
        simulatedMsgReason: userMessage.simulatedMsgReason ?? SlateSimulatedMessageReason.UNSPECIFIED,
        text: userMessage.text,
      }) ? renderIncomingMessageIdTag(userMessage.messageId) : undefined;
      if (messageIdTag !== undefined) {
        contentParts.unshift({ type: "text", text: messageIdTag });
      }
      const notificationOnly = isNotificationOnlyUserMessage({ role: "user", content: userMessage.text });
      contentParts.push({
        type: "text",
        text: notificationOnly ? `${timePrefix}${userMessage.text}` : `${timePrefix}<user_query>\n${eagerNote}${userMessage.text}\n</user_query>`,
      });
      const referenceTag = !referenceResolution.hasStructuredPromptReferenceId && referenceResolution.promptReferenceId !== undefined
        ? referenceResolution.promptReferenceId
        : userMessage.promptReferenceId;
      const threadId = messageThreadId({
        ...(userMessage.threadId !== undefined ? { threadId: userMessage.threadId } : {}),
        ...(referenceTag !== undefined ? { promptReferenceId: referenceTag } : {}),
        messageId: userMessage.messageId,
      });
      const savedDocuments = this.privacyMode === PrivacyModes.NO_STORAGE ? [] : selectedDocuments;
      const savedVideos = this.privacyMode === PrivacyModes.NO_STORAGE ? [] : selectedVideos;
      userMessage = {
        ...userMessage,
        ...(referenceTag !== undefined ? { promptReferenceId: referenceTag } : {}),
        selectedContext: attachAgentSelectedContextMediaInterop({
          selectedContext: userMessage.selectedContext as never,
          selectedDocuments: savedDocuments,
          selectedImages,
          selectedVideos: savedVideos,
        }),
      };
      if (threadId !== undefined) {
        userMessage.threadId = threadId;
      }
      const requestIdentifier = getRequestId(ctx);
      const message = {
        role: "user",
        content: contentParts,
        ...(requestIdentifier !== undefined ? { providerOptions: { cursor: { requestId: requestIdentifier } } } : {}),
      };
      const redactedPrompt = toRedactedCoreMessage(message, this.privacyMode);
      plainToRedacted.set(message, redactedPrompt);
      if (userMessage.simulatedMsgReason !== SlateSimulatedMessageReason.BACKGROUND_TASK_COMPLETION) {
        this.rootPromptBuilder.appendMessages(redactedPrompt);
      }
      const redactedUser = toRedactedUserMessageInterop(toInteropUserMessage(userMessage), this.privacyMode);
      const userBlobStartedAt = performance.now();
      const userBytes = this.serdes.userMessage.serialize(redactedUser);
      const userBlobId = await getBlobId(userBytes);
      metadataObserverForStore(this.blobStore)?.({
        blobId: userBlobId,
        blobType: { kind: "proto", typeName: "agent.v1.UserMessage" },
      });
      await this.blobStore.setBlob(ctx, userBlobId, userBytes);
      userMessageBlobHistogram.histogram(ctx, performance.now() - userBlobStartedAt);
      const turnStructure = createSlateAgentConversationTurn({
        userMessageBlobId: userBlobId,
        stepBlobIds: [],
        sendMessageStepIndices: [],
        requestId: requestIdentifier!,
        encryptedModel: turnSettings.encryptedMcidAndParams!,
        ...(dynamicToolCount !== undefined ? { dynamicToolCount: dynamicToolCount } : {}),
      });
      const turn = new AgentConversationTurnHandle(this.blobStore, this.serdes, this.privacyMode, turnStructure, this.rootPromptBuilder);
      this.turns.push(new EagerReference({
        deserialize: (blob) => {
          const turnStructure = slateConversationTurnSerde.deserialize(blob);
          if (turnStructure.kind !== "agent") {
            throw new Error("Expected agent turn");
          }
          return new AgentConversationTurnHandle(this.blobStore, this.serdes, this.privacyMode, turnStructure, this.rootPromptBuilder);
        },
        serialize: (value) => value.serialize(),
      }, this.blobStore, turn));
      if (this.userTurnMessageIdsIndex !== undefined) {
        if (userMessage.messageId.length > 0) {
          this.userTurnMessageIdsIndex.add(userMessage.messageId);
        }
        this.userTurnMessageIdsIndexedTurnCount = this.turns.length;
      }
      return turn;
    } catch (error) {
      turnEnv.error = error;
      turnEnv.hasError = true;
    } finally {
      disposeResources(turnEnv);
    }
    throw new Error("Unreachable createAgentTurn completion");
  }

  computeSubagentTrackingFromTimestamps(): void {
    const result = subagentTracking(this.subagentStates);
    this.lastUsedSubagentId = result.lastUsedSubagentId;
    this.lastSubagentByType = result.lastSubagentByType;
  }

  async loadSubagentStateRefs(ctx: OperationContext): Promise<void> {
    const subagentStateRefs = this.conversationStateStructure.subagentStateRefs;
    if (subagentStateRefs === undefined || subagentStateRefs.size === 0) return;
    const loadedEntries = await asyncMapValues(Array.from(subagentStateRefs.entries()), async ([subagentId, blobId]) => {
      const blob = await this.blobStore.getBlob(ctx, blobId);
      if (!blob) {
        if (!this.subagentStates.has(subagentId)) return { kind: "missing" as const, blobIdHex: toHex(blobId) };
        stateLog.warn(ctx, "Subagent state ref blob not found; falling back to inline entry", { subagentId });
        return { kind: "fallback" as const };
      }
      try {
        const redactedState = this.serdes.subagentPersistedState.deserialize(blob);
        const state = fromInteropSubagentPersistedState(
          fromRedactedSubagentPersistedStateInterop(
            redactedState,
            PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
            undefined,
          ),
          this.privacyMode,
        );
        return { kind: "loaded" as const, subagentId, state, blobId, blobData: blob };
      } catch (error4) {
        return { kind: "failed" as const, error: error4 };
      }
    }, { max: this.fetchConcurrency });
    const missingBlobIdHexes = loadedEntries.flatMap((entry) => entry.kind === "missing" ? [entry.blobIdHex] : []);
    if (missingBlobIdHexes.length > 0) throw new BlobNotFoundError(missingBlobIdHexes);
    const failedLoad = loadedEntries.find((entry) => entry.kind === "failed");
    if (failedLoad !== undefined && failedLoad.kind === "failed") throw failedLoad.error;
    for (const entry of loadedEntries) {
      if (entry.kind === "loaded") {
        subagentBlobCache.set(entry.state, { blobId: entry.blobId, blobData: entry.blobData });
        this.subagentStates.set(entry.subagentId, entry.state);
      }
    }
    this.computeSubagentTrackingFromTimestamps();
  }

  usesLargeContextTreatment(): boolean {
    return isLargeContextModel(this.modelId);
  }

  getOrInitializeConversationStartedDate(timeZone?: string): string {
    if (this.conversationStartedTimestampMs !== undefined) {
      if (this.conversationStartedTimeZone === undefined) {
        throw new Error("conversationStartedTimestampMs was set without conversationStartedTimeZone");
      }
      return dateStringForTimestamp(this.conversationStartedTimestampMs, this.conversationStartedTimeZone);
    }
    if (this.conversationStartedTimeZone !== undefined) {
      throw new Error("conversationStartedTimeZone was set without conversationStartedTimestampMs");
    }
    const conversationStartedTimestampMs = BigInt(Date.now());
    const conversationStartedTimeZone = startTimeZone(timeZone);
    const conversationStartedDate = dateStringForTimestamp(conversationStartedTimestampMs, conversationStartedTimeZone);
    this.conversationStartedTimestampMs = conversationStartedTimestampMs;
    this.conversationStartedTimeZone = conversationStartedTimeZone;
    return conversationStartedDate;
  }

  setTodos(todos: readonly unknown[]): void {
    this.todos.length = 0;
    this.todos.push(...todos.map((todo) => new EagerReference(this.serdes.todoItem, this.blobStore, todo)));
  }

  setSummary(summary: unknown): void {
    this.summary = new EagerReference(this.serdes.conversationSummary, this.blobStore, summary);
  }

  pushSummaryArchive(summaryArchive: unknown): void {
    this.summaryArchives.push(new EagerReference(this.serdes.conversationSummaryArchive, this.blobStore, summaryArchive));
  }

  incrementSelfSummaryCount(): void {
    this.selfSummaryCount++;
    this.clearSelfSummaryInputLimitFailureTokenCount();
  }

  resetSelfSummaryCount(): void {
    this.selfSummaryCount = 0;
  }

  setSelfSummaryInputLimitFailureTokenCount(tokens: number): void {
    this.selfSummaryInputLimitFailureTokenCount = tokens;
  }

  clearSelfSummaryInputLimitFailureTokenCount(): void {
    this.selfSummaryInputLimitFailureTokenCount = 0;
  }

  shouldSuppressSelfSummaryAfterInputLimitFailure(usedTokens: number): boolean {
    return this.selfSummaryInputLimitFailureTokenCount !== 0 && usedTokens >= this.selfSummaryInputLimitFailureTokenCount;
  }

  setPlan(plan: SlateConversationPlanState | undefined): void {
    this.plan = plan !== undefined
      ? new EagerReference(this.serdes.conversationPlan, this.blobStore, plan)
      : undefined;
  }

  async getPlan(ctx: OperationContext): Promise<SlateConversationPlanState | undefined> {
    if (this.plan === undefined) return undefined;
    return await this.plan.get(ctx);
  }

  setPlanFromPersistedValue(value: unknown | undefined): void {
    this.setPlan(value === undefined ? undefined : slateConversationPlanFromValue(value));
  }

  upsertPlanEntry(entry: SlatePlanRegistryEntry): void {
    this.plans.set(entry.id, entry);
  }

  setGoalState(goalState: SlateGoalState): void {
    this.goalState = goalState;
  }

  recordFileState(path29: string, content: string | undefined, prevContent: string | undefined, skipReprioritization?: boolean): void {
    noteFileState(this.fileStates, this.blobStore, path29, content, prevContent, skipReprioritization);
  }

  async getFileState(ctx: OperationContext, path29: string): Promise<string | undefined> {
    const contentRef = this.fileStates.get(path29)?.content;
    if (contentRef === undefined) return undefined;
    return contentRef.get(ctx);
  }

  async hydrateUserMessageBlobText(ctx: OperationContext, incomingRecord: MessageBlobTarget): Promise<void> {
    const [textBytes, richTextBytes] = await Promise.all([
      incomingRecord.text.length === 0 && incomingRecord.textBlobId !== undefined && incomingRecord.textBlobId.length > 0
        ? this.blobStore.getBlob(ctx, incomingRecord.textBlobId)
        : Promise.resolve(undefined),
      (incomingRecord.richText === undefined || incomingRecord.richText.length === 0) && incomingRecord.richTextBlobId !== undefined && incomingRecord.richTextBlobId.length > 0
        ? this.blobStore.getBlob(ctx, incomingRecord.richTextBlobId)
        : Promise.resolve(undefined),
    ]);
    if (textBytes !== undefined) {
      incomingRecord.text = utf8Decoder.decode(textBytes);
    } else if (incomingRecord.text.length === 0 && incomingRecord.textBlobId !== undefined && incomingRecord.textBlobId.length > 0) {
      stateLog.warn(ctx, "Failed to hydrate user message text blob", {
        textBlobIdLength: incomingRecord.textBlobId.length,
      });
    }
    if (richTextBytes !== undefined) {
      incomingRecord.richText = utf8Decoder.decode(richTextBytes);
    } else if ((incomingRecord.richText === undefined || incomingRecord.richText.length === 0) && incomingRecord.richTextBlobId !== undefined && incomingRecord.richTextBlobId.length > 0) {
      stateLog.warn(ctx, "Failed to hydrate user message rich text blob", {
        richTextBlobIdLength: incomingRecord.richTextBlobId.length,
      });
    }
  }

  async getLastUserPromptText(ctx: OperationContext): Promise<string | undefined> {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = await this.turns[i]!.get(ctx);
      if (turn instanceof AgentConversationTurnHandle) {
        const incomingRecord = await turn.userMessage.get(ctx);
        if (incomingRecord.isSimulatedMsg !== true) {
          return incomingRecord.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        }
      }
    }
    return undefined;
  }

  async syncUserTurnMessageIdsIndex(ctx: OperationContext): Promise<Set<string>> {
    if (this.userTurnMessageIdsIndex === undefined) {
      this.userTurnMessageIdsIndex = new Set();
      this.userTurnMessageIdsIndexedTurnCount = 0;
    }
    if (this.userTurnMessageIdsIndexedTurnCount > this.turns.length) {
      this.userTurnMessageIdsIndex.clear();
      this.userTurnMessageIdsIndexedTurnCount = 0;
    }
    for (let i = this.userTurnMessageIdsIndexedTurnCount; i < this.turns.length; i += 1) {
      const turn = await this.turns[i]!.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const incomingRecord = await turn.userMessage.get(ctx);
      const messageId = incomingRecord.messageId;
      if (messageId.length > 0) {
        this.userTurnMessageIdsIndex.add(messageId);
      }
    }
    this.userTurnMessageIdsIndexedTurnCount = this.turns.length;
    return this.userTurnMessageIdsIndex;
  }

  async getUserTurnMessageIdsIndex(ctx: OperationContext): Promise<Set<string>> {
    return this.syncUserTurnMessageIdsIndex(ctx);
  }

  async getUserPromptTextsByReferenceId(ctx: OperationContext): Promise<Map<string, string>> {
    const promptsByReference = new Map<string, string>();
    for (const turnReference of this.turns) {
      const turn = await turnReference.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const incomingRecord = await turn.userMessage.get(ctx);
      if (incomingRecord.isSimulatedMsg === true) continue;
      const promptReferenceId = incomingRecord.promptReferenceId;
      if (promptReferenceId === undefined || promptReferenceId.length === 0 || promptsByReference.has(promptReferenceId)) continue;
      promptsByReference.set(promptReferenceId, incomingRecord.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED));
    }
    return promptsByReference;
  }

  async resolvePromptReferenceUserMessageMatches(
    ctx: OperationContext,
    referenceIds: readonly string[],
  ): Promise<{
    promptReferenceId: string;
    messageId: string;
    threadId: string;
    turnIndex: number;
  }[]> {
    const wantedReferenceIds = new Set(referenceIds.filter((id) => id.length > 0));
    if (wantedReferenceIds.size === 0) return [];
    const seenReferenceIds = new Set<string>();
    const matches: {
      promptReferenceId: string;
      messageId: string;
      threadId: string;
      turnIndex: number;
    }[] = [];
    for (let i = 0; i < this.turns.length; i += 1) {
      const turn = await this.turns[i]!.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const incomingRecord = await turn.userMessage.get(ctx);
      if (incomingRecord.isSimulatedMsg === true) continue;
      const promptReferenceId = incomingRecord.promptReferenceId;
      if (
        promptReferenceId === undefined ||
        promptReferenceId.length === 0 ||
        !wantedReferenceIds.has(promptReferenceId) ||
        seenReferenceIds.has(promptReferenceId)
      ) continue;
      matches.push({
        promptReferenceId,
        messageId: incomingRecord.messageId,
        threadId: messageThreadId(incomingRecord) ?? promptReferenceId,
        turnIndex: i,
      });
      seenReferenceIds.add(promptReferenceId);
      if (seenReferenceIds.size >= wantedReferenceIds.size) break;
    }
    return matches;
  }

  async reassignThreadIds(
    ctx: OperationContext,
    sourceThreads: ReadonlySet<string>,
    targetThread: string,
  ): Promise<void> {
    if (sourceThreads.size === 0 || targetThread.length === 0) return;
    for (const turnReference of this.turns) {
      const turn = await turnReference.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const incomingRecord = await turn.userMessage.get(ctx);
      const currentThread = explicitThreadId(incomingRecord);
      if (currentThread !== undefined && sourceThreads.has(currentThread) && currentThread !== targetThread) {
        turn.setUserMessage(attachThreadId(incomingRecord, targetThread));
      }
    }
    for (const [subagentId, threadId] of this.subagentThreads) {
      if (sourceThreads.has(threadId) && threadId !== targetThread) {
        this.subagentThreads.set(subagentId, targetThread);
      }
    }
  }

  async assignPromptReferenceMatchesToThread(
    ctx: OperationContext,
    matches: readonly { turnIndex: number }[],
    threadId: string,
  ): Promise<void> {
    for (const promptMatch of matches) {
      const turnReference = this.turns[promptMatch.turnIndex];
      if (turnReference === undefined) continue;
      const turn = await turnReference.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const incomingRecord = await turn.userMessage.get(ctx);
      if (explicitThreadId(incomingRecord) === threadId) continue;
      turn.setUserMessage(attachThreadId(incomingRecord, threadId));
    }
  }

  async getEarliestTurnIndexByThreadId(
    ctx: OperationContext,
    threadCandidates: ReadonlySet<string>,
  ): Promise<Map<string, number>> {
    const earliestTurnByThread = new Map<string, number>();
    if (threadCandidates.size === 0) return earliestTurnByThread;
    for (let i = 0; i < this.turns.length; i += 1) {
      const turn = await this.turns[i]!.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const incomingRecord = await turn.userMessage.get(ctx);
      const threadId = messageThreadId(incomingRecord);
      if (threadId === undefined || !threadCandidates.has(threadId) || earliestTurnByThread.has(threadId)) continue;
      earliestTurnByThread.set(threadId, i);
      if (earliestTurnByThread.size >= threadCandidates.size) break;
    }
    return earliestTurnByThread;
  }

  async resolveCanonicalThreadIdForPromptReferenceMatches(
    ctx: OperationContext,
    matches: readonly { readonly threadId: string; readonly turnIndex: number }[],
    extraThreadIds: readonly string[] = [],
  ): Promise<string | undefined> {
    const threadOrder: string[] = [];
    const addThreadId = (candidate: string | undefined): void => {
      const threadId = trimmedString(candidate);
      if (threadId === undefined || threadOrder.includes(threadId)) return;
      threadOrder.push(threadId);
    };
    for (const threadId of extraThreadIds) addThreadId(threadId);
    for (const match of matches) addThreadId(match.threadId);
    if (threadOrder.length === 0) return undefined;
    const earliestTurnByThread = await this.getEarliestTurnIndexByThreadId(ctx, new Set(threadOrder));
    let canonicalThread = threadOrder[0]!;
    let canonicalTurn = earliestTurnByThread.get(canonicalThread) ?? Infinity;
    for (const threadId of threadOrder.slice(1)) {
      const turnIndex = earliestTurnByThread.get(threadId) ?? Infinity;
      if (turnIndex < canonicalTurn || (turnIndex === canonicalTurn && threadId < canonicalThread)) {
        canonicalThread = threadId;
        canonicalTurn = turnIndex;
      }
    }
    return canonicalThread;
  }

  async canonicalizePromptReferenceMatchThreads(args: {
    readonly ctx: OperationContext;
    readonly matches: readonly { readonly threadId: string; readonly turnIndex: number }[];
    readonly canonicalThread: string | undefined;
    readonly extraThreadIds?: readonly string[];
  }): Promise<void> {
    const { ctx, matches, canonicalThread, extraThreadIds = [] } = args;
    const normalizedCanonical = trimmedString(canonicalThread);
    if (normalizedCanonical === undefined) return;
    const sourceThreads = new Set<string>();
    for (const threadId of extraThreadIds) {
      const normalizedThreadId = trimmedString(threadId);
      if (normalizedThreadId !== undefined && normalizedThreadId !== normalizedCanonical) {
        sourceThreads.add(normalizedThreadId);
      }
    }
    for (const match of matches) {
      if (match.threadId !== normalizedCanonical) sourceThreads.add(match.threadId);
    }
    await this.reassignThreadIds(ctx, sourceThreads, normalizedCanonical);
    await this.assignPromptReferenceMatchesToThread(ctx, matches, normalizedCanonical);
  }

  async clearTurns(): Promise<void> {
    this.turns.length = 0;
    this.userTurnMessageIdsIndex?.clear();
    this.userTurnMessageIdsIndex = undefined;
    this.userTurnMessageIdsIndexedTurnCount = 0;
  }

  appendCommunicateUpdateHistoryEntry(entry: {
    readonly step: string;
    readonly messageIndex: number;
    readonly parentToolCallId?: string;
    readonly finalSummary?: string;
    readonly completedSubtitle?: string;
  }): void {
    const loggedEntry = createAgentStateCommunicateHistoryEntryInterop({
      step: entry.step,
      messageIndex: entry.messageIndex,
    });
    const parentToolCallId = trimmedString(entry.parentToolCallId);
    if (parentToolCallId !== undefined) {
      const knownState = this.communicateUpdateStatesByParentToolCallId.get(parentToolCallId);
      const followingHistory = [...knownState?.history ?? [], loggedEntry];
      this.communicateUpdateStatesByParentToolCallId.set(parentToolCallId, createAgentStateCommunicateTurnStateInterop({
        history: followingHistory,
        finalSummary: (entry.finalSummary ?? knownState?.finalSummary)!,
        completedSubtitle: (entry.completedSubtitle ?? knownState?.completedSubtitle)!,
      }));
      return;
    }
    this.communicateUpdateHistory.push(loggedEntry);
    if (entry.finalSummary !== undefined) this.communicateUpdateFinalSummary = entry.finalSummary;
    if (entry.completedSubtitle !== undefined) this.communicateUpdateCompletedSubtitle = entry.completedSubtitle;
  }

  getNextMessageIndex(): number {
    const loadedMessages = this.rootPromptBuilder.getState().length;
    if (this.skippedRootPromptBlobs) return this.originalRootPromptMessagesJson.length + loadedMessages;
    if (loadedMessages > 0) return loadedMessages;
    return this.conversationStateStructure.rootPromptMessagesJson.length;
  }

  generateModeChangeContent(
    config: InteropModeProcessingConfig,
    hostContext: ModeProcessingRequestContext,
    priorMode?: SlateModeValue,
  ): string {
    const currentMode = this.slateMode;
    if (currentMode === undefined) return "";
    return processModeSystemReminderWithInteropConfig(currentMode, config, hostContext, priorMode);
  }

  serialize(): Uint8Array {
    return serializeRedactedConversationStateInterop(
      toInteropConversationState(this.conversationStateStructure),
    );
  }

  async computeNewStructure(parentContext: OperationContext): Promise<ConversationStateBlobs> {
    const previousPending = this.pendingComputeStructure;
    const computation = (async (): Promise<ConversationStateBlobs> => {
      if (previousPending) {
        await previousPending.catch(() => undefined);
      }
      return this.doComputeNewStructure(parentContext);
    })();
    this.pendingComputeStructure = computation;
    return computation;
  }

  private async doComputeNewStructure(parentContext: OperationContext): Promise<ConversationStateBlobs> {
    const env_2: DisposableEnvironmentEntry = { stack: [], error: undefined, hasError: false };
    try {
      const span = createSpan(parentContext.withName("computeNewStructure"));
      addDisposableResource(env_2, span, false);
      const ctx = span.ctx;
      const quietContext = withSuppressedChildSpans(ctx);
      const serializeStartedAt = performance.now();
      let blobWriteCount = 0;
      const serializeRootPromptMessages = async (messages: readonly SerializeMessage[]): Promise<Uint8Array[]> => {
        const blobIds = await Promise.all(messages.map(async (message) => {
          const cached = messageBlobCache.get(message);
          if (cached !== undefined) {
            if (!isBlobDurable(this.blobStore, cached.blobId)) {
              await this.blobStore.setBlob(quietContext, cached.blobId, cached.blobData);
            }
            return cached.blobId;
          }
          let serializedMessage: Uint8Array;
          {
            const startEpochMs = Date.now();
            const start = performance.now();
            serializedMessage = this.serdes.coreMessage.serialize(message);
            const durationMs = performance.now() - start;
            if (durationMs > SLOW_SERIALIZE_MS) {
              recordCompletedSpanIfParented(ctx.withName("serializeMessage.slow"), {
                startTime: startEpochMs,
                attributes: {
                  serializedMessageLength: serializedMessage.length,
                  durationMs,
                  slowThresholdMs: SLOW_SERIALIZE_MS,
                },
              }, startEpochMs + durationMs);
            }
            if (durationMs > 1e4) {
              stateLog.warn(ctx, "Serializing message took more than 10 seconds", {
                serializedMessageLength: serializedMessage.length,
                serializationDuration: durationMs,
              });
            }
          }
          const blobId = await getBlobId(serializedMessage);
          blobWriteCount += 1;
          metadataObserverForStore(this.blobStore)?.({ blobId, blobType: { kind: "json" } });
          await this.blobStore.setBlob(quietContext, blobId, serializedMessage);
          messageBlobCache.set(message, { blobId, blobData: serializedMessage });
          return blobId;
        }));
        return blobIds;
      };
      const promptValues = this.rootPromptBuilder.getState();
      span.span.setAttribute("rootPromptBlobMode", this.skippedRootPromptBlobs ? "skipped" : "loaded");
      const newRootPromptMessagesJsonPromise = (async (): Promise<Uint8Array[]> => {
        if (!this.skippedRootPromptBlobs) {
          rootPromptModeCounter.increment(ctx, 1, { mode: "full" });
          return serializeRootPromptMessages(promptValues);
        }
        if (this.rootPromptPrefixInvalidated) {
          rootPromptModeCounter.increment(ctx, 1, { mode: "invalidated" });
          throw new Error("Cannot compute root prompt pass-through after root prompt prefix was invalidated");
        }
        rootPromptModeCounter.increment(ctx, 1, { mode: "passthrough" });
        const appendedRootPromptMessagesJson = await serializeRootPromptMessages(promptValues);
        return [...this.originalRootPromptMessagesJson, ...appendedRootPromptMessagesJson];
      })();
      const newTurnsPromise = Promise.all(this.turns.map((ref) => {
        blobWriteCount += 1;
        return ref.writeToBlobStore(quietContext);
      }));
      const newTodosPromise = Promise.all(this.todos.map((ref) => {
        blobWriteCount += 1;
        return ref.writeToBlobStore(quietContext);
      }));
      let newSummaryPromise: Promise<Uint8Array> | undefined;
      if (this.summary !== undefined) {
        blobWriteCount += 1;
        newSummaryPromise = this.summary.writeToBlobStore(quietContext);
      }
      let newSummaryArchivesPromise: Promise<Uint8Array[]> | undefined;
      if (this.summaryArchives.length > 0) {
        newSummaryArchivesPromise = Promise.all(this.summaryArchives.map((ref) => {
          blobWriteCount += 1;
          return ref.writeToBlobStore(quietContext);
        }));
      }
      let planBlobPromise: Promise<Uint8Array> | undefined;
      if (this.plan !== undefined) {
        blobWriteCount += 1;
        planBlobPromise = this.plan.writeToBlobStore(quietContext);
      }
      const fileStateEntriesPromise = Promise.all(Array.from(this.fileStates.entries()).map(async ([path29, knownState]) => {
        let contentBlobIdPromise: Promise<Uint8Array | undefined> = Promise.resolve(undefined);
        if (knownState.content !== undefined) {
          blobWriteCount += 1;
          contentBlobIdPromise = knownState.content.writeToBlobStore(quietContext);
        }
        let initialContentBlobIdPromise: Promise<Uint8Array | undefined> = Promise.resolve(undefined);
        if (knownState.initialContent !== undefined) {
          blobWriteCount += 1;
          initialContentBlobIdPromise = knownState.initialContent.writeToBlobStore(quietContext);
        }
        const [contentBlob, initialBlob] = await Promise.all([contentBlobIdPromise, initialContentBlobIdPromise]);
        const stateEntry = {
          ...(contentBlob === undefined ? {} : { contentBlobId: contentBlob }),
          ...(initialBlob === undefined ? {} : { initialContentBlobId: initialBlob }),
        };
        return [path29, stateEntry] as const;
      }));
      const subagentStatesRecord: Record<string, ReturnType<typeof toInteropSubagentPersistedState>> = {};
      const subagentRefsRecord: Record<string, Uint8Array> = {};
      let subagentRefsPromise: Promise<void> | undefined;
      if (this.serializeSubagentStatesAsBlobRefs) {
        subagentRefsPromise = Promise.all(Array.from(this.subagentStates.entries()).map(async ([subagentId, state]) => {
          const cached = subagentBlobCache.get(state);
          if (cached !== undefined) {
            if (!isBlobDurable(this.blobStore, cached.blobId)) {
              await this.blobStore.setBlob(quietContext, cached.blobId, cached.blobData);
            }
            subagentRefsRecord[subagentId] = cached.blobId;
            return;
          }
          const serialized = this.serdes.subagentPersistedState.serialize(
            toRedactedSubagentPersistedStateInterop(
              toInteropSubagentPersistedState(state),
              this.privacyMode,
            ),
          );
          const blobId = await getBlobId(serialized);
          blobWriteCount += 1;
          metadataObserverForStore(this.blobStore)?.({
            blobId,
            blobType: { kind: "proto", typeName: "agent.v1.SubagentPersistedState" },
          });
          await this.blobStore.setBlob(quietContext, blobId, serialized);
          subagentBlobCache.set(state, { blobId, blobData: serialized });
          subagentRefsRecord[subagentId] = blobId;
        })).then(() => undefined);
      } else {
        for (const [subagentId, state] of this.subagentStates) {
          subagentStatesRecord[subagentId] = toInteropSubagentPersistedState(state);
        }
      }
      const subagentRunsRecord: Record<string, ReturnType<typeof toInteropSubagentRunState>> = {};
      for (const [parentToolCallId, state] of this.subagentRunsByParentToolCallId) {
        subagentRunsRecord[parentToolCallId] = toInteropSubagentRunState(state);
      }
      const subagentThreadsRecord: Record<string, string> = {};
      for (const [subagentId, threadId] of this.subagentThreads) {
        subagentThreadsRecord[subagentId] = threadId;
      }
      const communicateStatesRecord: Record<string, AgentStateCommunicateTurnStateInterop> = {};
      for (const [parentToolCallId, state] of this.communicateUpdateStatesByParentToolCallId) {
        communicateStatesRecord[parentToolCallId] = createAgentStateCommunicateTurnStateInterop({ ...communicateState(state) });
      }
      const plansRecord: Record<string, { id: string; path: string }> = {};
      for (const [planId, entry] of this.plans) {
        plansRecord[planId] = { id: entry.id, path: entry.path };
      }
      await subagentRefsPromise;
      const rootPromptMessagesJson = await newRootPromptMessagesJsonPromise;
      const usageTree = this.tokenDetails.promptContextUsageTree;
      const promptContextUsageSnapshotBlobId = await persistPromptContextUsageSnapshot({
        ctx: quietContext,
        blobStore: this.blobStore,
        privacyMode: this.privacyMode,
        usageTree,
        rootPromptMessagesJson,
      });
      const tokenDetails = fromRedactedConversationTokenDetailsInterop(this.tokenDetails, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
      tokenDetails.promptContextUsageSnapshotBlobId = promptContextUsageSnapshotBlobId!;
      const stateInit = {
        rootPromptMessagesJson,
        turns: await newTurnsPromise,
        todos: await newTodosPromise,
        tokenDetails,
        summary: (await newSummaryPromise)!,
        plan: (await planBlobPromise)!,
        summaryArchives: (await newSummaryArchivesPromise)!,
        previousWorkspaceUris: this.previousWorkspaceUris?.map((uri) => uri.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)) ?? [],
        trackedGitRepoBranches: this.trackedGitRepoBranches.map((repo) => ({
          repoPath: repo.repoPath,
          branchName: repo.branchName,
        })),
        mode: this.slateMode === undefined ? undefined : toInteropAgentMode(this.slateMode),
        agentType: this.agentType!,
        activeBranchName: this.activeBranchName!,
        isRootProjectConversation: (this.isRootProjectConversation || undefined)!,
        conversationStartedTimestampMs: this.conversationStartedTimestampMs!,
        conversationStartedTimeZone: this.conversationStartedTimeZone!,
        fileStatesV2: Object.fromEntries(await fileStateEntriesPromise),
        subagentStates: subagentStatesRecord,
        subagentStateRefs: subagentRefsRecord,
        subagentRunsByParentToolCallId: subagentRunsRecord,
        subagentThreads: subagentThreadsRecord,
        selfSummaryCount: this.selfSummaryCount,
        readPaths: Array.from(this.readPaths),
        completedAskQuestionToolCallIds: Array.from(this.completedAskQuestionToolCallIds),
        plans: plansRecord,
        goalState: this.goalState === undefined ? undefined : toInteropGoalState(this.goalState),
        communicateUpdateHistory: this.communicateUpdateHistory.map((entry) => createAgentStateCommunicateHistoryEntryInterop({
          step: entry.step,
          messageIndex: entry.messageIndex,
        })),
        communicateUpdateFinalSummary: this.communicateUpdateFinalSummary!,
        communicateUpdateCompletedSubtitle: this.communicateUpdateCompletedSubtitle!,
        communicateUpdateStatesByParentToolCallId: communicateStatesRecord,
      };
      const { redactedState: nextRedactedState, stats: nextStateStats } =
        encodeSlateConversationStateSnapshotInterop(stateInit, this.conversationStateStructure.privacyMode);
      const serializeMs = performance.now() - serializeStartedAt;
      span.span.setAttribute("setBlobCount", blobWriteCount);
      span.span.setAttribute("serializeDurationMs", serializeMs);
      if (blobWriteCount >= 50 || serializeMs >= SLOW_RESTORE_MS) {
        stateLog.debug(span.ctx, "Large conversation state serialize", {
          serializeMs,
          blobWriteCount,
          promptMessages: nextStateStats.rootPromptMessageCount,
          turnCount: nextStateStats.turnCount,
          todoCount: nextStateStats.todoCount,
          fileStateCount: nextStateStats.fileStateCount,
          hasSummary: nextStateStats.hasSummary,
          summaryArchiveCount: nextStateStats.summaryArchiveCount,
        });
      }
      this.conversationStateStructure = fromInteropConversationState(nextRedactedState);
      return nextRedactedState;
    } catch (e_2) {
      env_2.error = e_2;
      env_2.hasError = true;
    } finally {
      disposeResources(env_2);
    }
    throw new Error("Unreachable computeNewStructure completion");
  }

  async createShellTurn(
    ctx: OperationContext,
    shellCommand: Parameters<CodecSet["shellCommand"]["serialize"]>[0],
  ): Promise<ShellConversationTurnHandle> {
    const shellCommandBlob = this.serdes.shellCommand.serialize(shellCommand);
    const shellCommandBlobId = await getBlobId(shellCommandBlob);
    metadataObserverForStore(this.blobStore)?.({
      blobId: shellCommandBlobId,
      blobType: { kind: "proto", typeName: "agent.v1.ShellCommand" },
    });
    await this.blobStore.setBlob(ctx, shellCommandBlobId, shellCommandBlob);
    const emptyOutput = createEmptyRedactedShellOutputInterop(this.privacyMode);
    const shellOutputBlob = this.serdes.shellOutput.serialize(emptyOutput);
    const shellOutputBlobId = await getBlobId(shellOutputBlob);
    metadataObserverForStore(this.blobStore)?.({
      blobId: shellOutputBlobId,
      blobType: { kind: "proto", typeName: "agent.v1.ShellOutput" },
    });
    await this.blobStore.setBlob(ctx, shellOutputBlobId, shellOutputBlob);
    const shellTurnInner = createSlateShellConversationTurn({
      shellCommandBlobId,
      shellOutputBlobId,
    });
    const turn = new ShellConversationTurnHandle(this.blobStore, this.serdes, shellTurnInner);
    this.turns.push(new EagerReference({
      deserialize: (blob) => {
        const turnStructure = slateConversationTurnSerde.deserialize(blob);
        if (turnStructure.kind !== "shell") {
          throw new Error("Expected shell turn");
        }
        return new ShellConversationTurnHandle(this.blobStore, this.serdes, turnStructure);
      },
      serialize: (value) => value.serialize(),
    }, this.blobStore, turn));
    return turn;
  }

  getBlobStore(): BlobStore<OperationContext> {
    return this.blobStore;
  }

  getPrivacyMode(): PrivacyMode {
    return this.privacyMode;
  }

  addTurnUsage(usage: UsageDelta): void {
    this.turnUsage.inputTokens += usage.inputTokens;
    this.turnUsage.outputTokens += usage.outputTokens;
    this.turnUsage.cacheReadTokens += usage.cacheReadTokens;
    this.turnUsage.cacheWriteTokens += usage.cacheWriteTokens;
    this.turnUsage.reasoningTokens = (this.turnUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  }

  getTurnUsageAndReset(): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  } {
    const usage = { ...this.turnUsage };
    this.turnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    return usage;
  }

  setTokenDetails(tokenDetails: TokenDetails): void {
    this.tokenDetails = tokenDetails;
    this.tokenDetailsStaleAfterSummarization = false;
  }

  getSubagentThreadId(subagentId: string): string | undefined {
    const threadId = this.subagentThreads.get(subagentId);
    if (threadId === undefined || threadId.length === 0) {
      return undefined;
    }
    return threadId;
  }

  setSubagentThreadId(subagentId: string, threadId: string | undefined): void {
    if (subagentId.length === 0) {
      return;
    }
    if (threadId === undefined || threadId.length === 0) {
      this.subagentThreads.delete(subagentId);
      return;
    }
    this.subagentThreads.set(subagentId, threadId);
  }

  persistSubagentState(
    _ctx: OperationContext,
    subagentId: string,
    subagentType: SlateSubagentTypeLike,
    state: Partial<SlateSubagentPersistedState>,
  ): void {
    const now = BigInt(Date.now());
    const knownState = this.subagentStates.get(subagentId);
    const createdTimestamp = knownState?.createdTimestampMs ?? now;
    const persistedModelId = state.modelId ?? knownState?.modelId;
    const updatedState = createSlateSubagentPersistedState({
      ...knownState,
      ...state,
      createdTimestampMs: createdTimestamp,
      lastUsedTimestampMs: now,
      subagentType,
      modelId: persistedModelId!,
    });
    this.subagentStates.set(subagentId, updatedState);
    const typeName = slateSubagentTypeName(subagentType);
    this.lastSubagentByType.set(typeName, subagentId);
    this.lastUsedSubagentId = subagentId;
  }

  recordSubagentRunCompletion(completion: SlateBackgroundTaskCompletion): void {
    if (completion.kind !== "subagent" || completion.reason === "task-progress") {
      return;
    }
    const parentToolCallId = trimmedString(completion.toolCallId);
    if (parentToolCallId === undefined) {
      return;
    }
    const subagentId = trimmedString(completion.subagentId) ?? trimmedString(completion.taskId);
    const existingRun = this.subagentRunsByParentToolCallId.get(parentToolCallId);
    const persistedSubagentState = subagentId !== undefined
      ? this.subagentStates.get(this.resolveSubagentId(subagentId) ?? subagentId)
      : undefined;
    const persistedEnvironment = persistedSubagentState?.environment === undefined ||
        persistedSubagentState.environment === "unspecified"
      ? undefined
      : persistedSubagentState.environment;
    this.subagentRunsByParentToolCallId.set(parentToolCallId, updateSlateSubagentRun({
      completion,
      parentToolCallId,
      ...(subagentId === undefined ? {} : { subagentId }),
      ...(persistedEnvironment === undefined ? {} : { environment: persistedEnvironment }),
      ...(persistedSubagentState?.cloudSubagent?.transcriptPath === undefined
        ? {}
        : { transcriptPath: persistedSubagentState.cloudSubagent.transcriptPath }),
      ...(existingRun === undefined ? {} : { existingRun }),
      completedTimestampMs: BigInt(Date.now()),
    }));
  }

  resolveSubagentId(subagentIdOrBcId: string): string | undefined {
    if (this.subagentStates.has(subagentIdOrBcId)) {
      return subagentIdOrBcId;
    }
    for (const [subagentId, state] of this.subagentStates) {
      if (state.cloudSubagent?.bcId === subagentIdOrBcId) {
        return subagentId;
      }
    }
    return undefined;
  }

  restoreSubagentState(_ctx: OperationContext, subagentId: string): SlateSubagentPersistedState | undefined {
    const resolved = this.resolveSubagentId(subagentId);
    return resolved !== undefined ? this.subagentStates.get(resolved) : undefined;
  }

  getSubagentIdToResume(
    typeName: string,
    mode: "DEFAULT" | "LAST_AGENT" | "LAST_AGENT_SAME_TYPE",
  ): string | undefined {
    switch (mode) {
      case "DEFAULT":
        return undefined;
      case "LAST_AGENT":
        return this.lastUsedSubagentId;
      case "LAST_AGENT_SAME_TYPE":
        return this.lastSubagentByType.get(typeName);
      default: {
        const exhaustiveCheck: never = mode;
        throw new Error(`Unknown resume mode: ${exhaustiveCheck}`);
      }
    }
  }

  recordReadPath(path29: string): void {
    this.readPaths.add(path29);
  }

  hasReadPath(path29: string): boolean {
    return this.readPaths.has(path29);
  }

  hasCompletedAskQuestion(originalToolCallId: string): boolean {
    return this.completedAskQuestionToolCallIds.has(originalToolCallId);
  }

  markAskQuestionCompleted(originalToolCallId: string): void {
    this.completedAskQuestionToolCallIds.add(originalToolCallId);
  }

  retainCompletedAskQuestionReceipts(liveOriginalIds: ReadonlySet<string>): void {
    for (const id of this.completedAskQuestionToolCallIds) {
      if (!liveOriginalIds.has(id)) this.completedAskQuestionToolCallIds.delete(id);
    }
  }

  /**
   * Product callers read and write Slate's mode vocabulary. The compatibility encoding to a numeric
   * persisted mode happens only inside `setMode`.
   */
  get mode(): SlateModeValue | undefined {
    return this.slateMode;
  }

  setMode(mode: SlateModeValue): void {
    if (this.slateMode === mode) return;
    this.slateMode = mode;
    this.conversationStateStructure.mode = mode;
    delete this.conversationStateStructure.unknownModeCode;
  }

  hasAgentTypeChangedFromPersistedState(): boolean {
    return this.agentTypeChangedFromPersistedState;
  }

  setActiveBranchName(activeBranchName: string | undefined): void {
    this.activeBranchName = activeBranchName;
  }

  setBackgroundSummarizationState(
    promiseInfo: unknown,
    messagesUndergoingSummarization: unknown,
    cancellationToken: unknown,
  ): void {
    this.backgroundSummarizationPromiseInfo = promiseInfo;
    this.messagesUndergoingSummarization = messagesUndergoingSummarization;
    this.backgroundSummarizationHasCompleted = false;
    this.backgroundSummarizationCancellationToken = cancellationToken;
  }

  setBackgroundSummarizationHasCompleted(generationDurationMs: number): void {
    this.backgroundSummarizationHasCompleted = true;
    this.backgroundSummarizationGenerationDurationMs = generationDurationMs;
  }

  clearBackgroundSummarizationState(): void {
    this.backgroundSummarizationPromiseInfo = null;
    this.messagesUndergoingSummarization = null;
    this.backgroundSummarizationHasCompleted = false;
    this.backgroundSummarizationGenerationDurationMs = null;
    this.backgroundSummarizationCancellationToken = null;
  }
}

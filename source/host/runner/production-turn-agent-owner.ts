/**
 * The last host-owned step before an Agent exists: one run, one context, one Agent.
 *
 * A turn needs a handful of things that only make sense together — the run context (cancellation, privacy mode, tool
 * session, summarization session), one resource accessor over the box's local view, and the Agent built from both. This
 * file assembles exactly that once per run and hands the caller the pieces plus a disposer; the stream lifecycle after
 * construction is the caller's.
 *
 * Two rules keep it honest:
 *
 * - **an option the caller left out stays left out** — the run context takes optional settings, and passing `undefined`
 *   for one of them is not the same as not passing it (`exactOptionalPropertyTypes`), so every optional value goes
 *   through `present()`;
 * - **nothing half-built is left behind** — if any step after the run context fails (resource accessors, the toolset
 *   host, the summarization session), the context is disposed before the error travels on, because a disk-pressure
 *   claim is taken inside it.
 */
import type { Context } from "../../packages/context/context.ts";
import type { BlobStore } from "../../packages/agent-kv/blob-store.ts";
import { cloneInteropConversationState, type InteropConversationState } from "../../adapters/interop/agent/turn-agent-run-projection-adapter.ts";
import {
  buildAgentForRun,
  createTurnAgentRunInputProjection,
  createTurnLocalResourceProjection,
  type BuiltTurnAgentForRun,
  type TurnAgentBuildForRunInput,
  type TurnAgentMcpTurnProvider,
  type TurnAgentResourceAccessor,
  type TurnAgentScope,
  type TurnAgentStaticConfigInputs,
  type TurnLocalResourceProjectionInput,
} from "./turn-agent-composition.ts";
import type { TurnToolsetHost, TurnToolsetTurnInput } from "./tools/turn-toolset.ts";
import {
  createProductionTurnToolsetHost,
  type LazyTurnToolsetHostBinding,
  type TurnToolsetHostBinding,
} from "../runner-production-bridge.ts";
import type { SummarizationPromptSession } from "../../packages/agent-summarization/summarization-handler.ts";
import type { DiskPressureReminderEpisodes } from "../boxes/forever-box/disk-pressure.ts";
import type { AgentProfilePromptSnapshot } from "./slate-agent-profile-prompt.ts";
import type { PromptSnapshotStore } from "./system-prompt-assembly.ts";
import type { ForwardedUpdate } from "./agent-adapters.ts";
import type { MessageLike } from "./send-message-reminder-middleware.ts";
import type { InteropTurnPromptOptions, SlateTurnActionAssembly } from "../../adapters/interop/agent/prompt-action-adapter.ts";
import { createTurnAgentRunContext, type TurnAgentInferenceOwner, type TurnAgentRunContext } from "./turn-run-shell.ts";
import { presentOptions } from "./optional-options.ts";

export interface ProductionTurnAgentOwnerInput {
  readonly context: Context;
  readonly conversationId: string;
  readonly requestId: string;
  readonly inference: TurnAgentInferenceOwner;
  readonly onRequestId: (requestId: string) => void;
  readonly isSubagentRunner: boolean;
  readonly isSilenceAllowed: boolean;
  readonly canUseSelfSummary: () => boolean;
  readonly cancelThisRun: TurnAgentScope["cancelThisRun"];
  readonly createResourceAccessor: (context: Context) => Promise<TurnAgentResourceAccessor>;
  readonly createRemoteBoxResourceAccessor: (context: Context) => Promise<TurnAgentResourceAccessor>;
  readonly createTurnLocalResourceProjectionInput: (baseAccessor: TurnAgentResourceAccessor) => Omit<TurnLocalResourceProjectionInput, "baseAccessor">;
  readonly blobStore: BlobStore<unknown>;
  /** Optional when the inference owner exposes its own session factory. */
  readonly summarizationSession?: SummarizationPromptSession;
  readonly toolHost?: TurnToolsetHost;
  readonly toolsetHostInput?: TurnToolsetHostBinding | LazyTurnToolsetHostBinding;
  readonly turn: TurnToolsetTurnInput;
  readonly staticConfig: Omit<TurnAgentStaticConfigInputs, "toolsGenerator">;
  readonly emitUpdate: (update: ForwardedUpdate) => void;
  readonly interactionObservers: ConstructorParameters<typeof import("./agent-adapters.ts").ForwardingInteractionListener>[1];
  readonly diskPressureReminder?: DiskPressureReminderEpisodes;
  readonly diskPressureClaimId?: string;
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
  readonly requestSource?: string;
  readonly modelId?: string;
  readonly hidden?: boolean;
  readonly lineage?: unknown;
  readonly profilePromptSnapshot?: AgentProfilePromptSnapshot;
  readonly profilePromptSnapshotStore?: PromptSnapshotStore;
  readonly onProfileUpdateAppended?: (identity: { readonly name: string; readonly description: string }) => void;
  readonly emittedConnectorCards: Set<string>;
  readonly diskPressureReminderEpisodeId?: string | null;
  readonly onLatestPromptMessages?: (getter: () => readonly MessageLike[]) => void;
}

export interface ProductionTurnAgentOwner {
  readonly built: BuiltTurnAgentForRun;
  readonly runContext: TurnAgentRunContext<Context>;
  readonly buildInput: TurnAgentBuildForRunInput;
  dispose(): void;
}

/** What the stream projection needs from the caller of one run. */
export interface ProductionTurnAgentRunInput {
  readonly runCtx: Context;
  readonly trimmedPrompt: string;
  readonly promptOptions: InteropTurnPromptOptions;
  readonly assembleSlateTurnAction: (input: {
    readonly runCtx: Context;
    readonly trimmedPrompt: string;
    readonly options: InteropTurnPromptOptions;
    readonly profileUpdateForTurn?: { readonly text: string };
    readonly compactionEpoch: () => number;
  }) => Promise<SlateTurnActionAssembly>;
  readonly profileUpdateForTurn?: { readonly text: string };
  readonly compactionEpoch: () => number;
  readonly getConversationState: () => InteropConversationState;
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: (error: unknown) => void;
}

/**
 * The action this run will stream, projected into the redacted state/tool inputs the stream start wants. The assembly
 * happens first, so a prompt that cannot be assembled fails before any projection is built.
 */
export async function createProductionTurnAgentRunInput(input: ProductionTurnAgentRunInput) {
  const assembly = await input.assembleSlateTurnAction({
    runCtx: input.runCtx,
    trimmedPrompt: input.trimmedPrompt,
    options: input.promptOptions,
    ...presentOptions({ profileUpdateForTurn: input.profileUpdateForTurn }),
    compactionEpoch: input.compactionEpoch,
  });
  return createTurnAgentRunInputProjection({
    runCtx: input.runCtx,
    createAction: async () => assembly.action,
    ...presentOptions({ mcp: input.mcp, onMcpDiscoveryFailed: input.onMcpDiscoveryFailed }),
    getConversationState: input.getConversationState,
  });
}

/** One run's context and Agent, with everything construction needed kept for the caller to inspect or reuse. */
export async function createProductionTurnAgentOwner(input: ProductionTurnAgentOwnerInput): Promise<ProductionTurnAgentOwner> {
  const runContext = await createTurnAgentRunContext({
    context: input.context,
    conversationId: input.conversationId,
    requestId: input.requestId,
    inference: input.inference,
    onRequestId: input.onRequestId,
    isSubagentRunner: input.isSubagentRunner,
    isSilenceAllowed: input.isSilenceAllowed,
    canUseSelfSummary: input.canUseSelfSummary,
    cancelThisRun: input.cancelThisRun,
    emittedConnectorCards: input.emittedConnectorCards,
    ...presentOptions({
      modelId: input.modelId,
      requestSource: input.requestSource,
      hidden: input.hidden,
      lineage: input.lineage,
      diskPressureReminder: input.diskPressureReminder,
      diskPressureClaimId: input.diskPressureClaimId,
      ackToken: input.ackToken,
      pauseThisRun: input.pauseThisRun,
      isRunAwaitingUserSelection: input.isRunAwaitingUserSelection,
      endThisRunAwaitingUser: input.endThisRunAwaitingUser,
      profilePromptSnapshot: input.profilePromptSnapshot,
      profilePromptSnapshotStore: input.profilePromptSnapshotStore,
      onProfileUpdateAppended: input.onProfileUpdateAppended,
      diskPressureReminderEpisodeId: input.diskPressureReminderEpisodeId,
      onLatestPromptMessages: input.onLatestPromptMessages,
    }),
  });
  try {
    const baseAccessor = await input.createResourceAccessor(input.context);
    const remoteBoxAccessor = await input.createRemoteBoxResourceAccessor(input.context);
    // The box's own files and the platform's agree on one shape: a projection over the base accessor is what the
    // Agent is handed, so a tool never has to know which of the two it is reading from.
    const resourceAccessor = createTurnLocalResourceProjection({
      ...input.createTurnLocalResourceProjectionInput(baseAccessor),
      baseAccessor,
    }).resourceAccessor;
    const summarizationSession = input.summarizationSession ?? runContext.summarizationSession;
    if (summarizationSession === undefined) throw new TypeError("the production Agent has no summarization session to summarize with");
    const toolHost = input.toolHost ?? (input.toolsetHostInput === undefined ? undefined : createProductionTurnToolsetHost(input.toolsetHostInput));
    if (toolHost === undefined) throw new TypeError("the production Agent has no toolset host to build its tools with");
    const buildInput: TurnAgentBuildForRunInput = {
      staticConfig: input.staticConfig,
      toolSession: runContext.toolSession,
      emitUpdate: input.emitUpdate,
      interactionObservers: input.interactionObservers,
      privacyMode: runContext.privacyMode,
      resourceAccessor,
      blobStore: input.blobStore,
      summarizationSession,
      toolHost,
      turn: { ...input.turn, remoteBoxResourceAccessor: remoteBoxAccessor, toolSession: runContext.toolSession },
      turnScope: runContext.scope,
    };
    return { built: buildAgentForRun(buildInput), runContext, buildInput, dispose: () => runContext.dispose() };
  } catch (error) {
    // Nothing half-built is left behind: the run context holds a disk-pressure claim until it is disposed.
    runContext.dispose();
    throw error;
  }
}

/** The generated state handed to a host caller is a copy, so the caller's edits cannot reach the turn's own state. */
export function cloneTurnState(state: InteropConversationState): InteropConversationState {
  return cloneInteropConversationState(state);
}

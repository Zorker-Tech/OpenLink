/**
 * One turn, from the prompt the user sent to the state it settled on.
 *
 * This file owns the shell around an Agent turn, and the shell is mostly about **who is allowed to stop it and how**:
 *
 * - **one run at a time** — starting a run installs it as the active run, and everything that ends a run (a settled
 *   turn, an interrupt, a pause for the user, a host upgrade) goes through that one object, so a late callback from an
 *   older turn cannot cancel the current one;
 * - **an interrupt before dispatch can be refused** — a run that has not dispatched yet is only interrupted by a
 *   request that supersedes it, and a recovery-shaped run (the user's own message re-sent unchanged) is only
 *   superseded by something that carries recovery, so a resend does not cancel itself;
 * - **pausing is not aborting** — a pause for user selection ends the run on purpose and is reported as such, while an
 *   abort caused by anything else is what gets re-thrown to the caller;
 * - **checkpoints belong to this generation** — a checkpoint is only persisted while the run's generation is still the
 *   current one, so a turn that was superseded cannot write over the turn that replaced it.
 *
 * The run context this file also builds is the other half: sessions, privacy, the disk-pressure claim and the
 * middleware chain a tool message travels through, all created once per turn and disposed together.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Context } from "../../packages/context/context.ts";
import type { PrivacyMode } from "../../packages/redaction/privacy-mode.ts";
import { SLATE_SUMMARIZATION_MODEL_ID } from "../../shared/agents/slate-agent-model.ts";
import type { DiskPressureReminderEpisodes } from "../boxes/forever-box/disk-pressure.ts";
import {
  createDiskPressureReminderMiddleware,
  createSendMessageReminderMiddleware,
  type MessageLike,
  type PromptExecutor,
} from "./send-message-reminder-middleware.ts";
import { createStartOfTurnAckReminderMiddleware } from "./start-of-turn-ack-reminder-middleware.ts";
import { SimplePromptToolExecutor } from "../../packages/agent/tool-stream-executor.ts";
import {
  createShellWatchGeneratedStateProjection,
  createShellWatchReadAccessor,
  type ConfirmedUserTurnWatermark,
  type ShellTerminalWatchHost,
  type ShellWatchGeneratedStateOwner,
  type ShellWatchResourceAccessor,
} from "./shell-terminal-watch.ts";
import type { TurnAgentScope, TurnAgentSessions } from "./turn-agent-composition.ts";
import type { PromptSnapshotStore } from "./system-prompt-assembly.ts";
import type { SummarizationPromptSession } from "../../packages/agent-summarization/summarization-handler.ts";
import { createProviderPromptSession } from "../extensions/inference/provider-session.ts";
import { getSlateRootDir } from "../host-paths.ts";
import { SlateSettingsStore } from "../../shared/node/settings/slate-settings-store.ts";
import type { SlateInferenceProvider } from "../../shared/inference-router.ts";
import type { AgentProfilePromptSnapshot } from "./slate-agent-profile-prompt.ts";
import { ConversationAction, ResumeAction } from "../../packages/proto/generated/agent/v1/agent_pb.ts";
import { createTurnSettle, type TurnCheckpoint, type TurnSession, type TurnSettleHost, type TurnSettleResult } from "./turn-settle.ts";
import type { TurnStreamLifecycleInput, TurnStreamPath, TurnStreamStartInput } from "./turn-agent-stream.ts";
import { presentOptions } from "./optional-options.ts";

/** The prompt session this turn runs on: which model it is, and the executor a tool message goes through. */
export interface TurnAgentPromptSession {
  getModelId(): string;
  getExecutor(state?: unknown): PromptExecutor;
}

/** Where a turn's sessions come from: the platform's own backend, or a routed provider. */
export interface TurnAgentInferenceOwner {
  resolvePrivacyMode(): Promise<PrivacyMode> | PrivacyMode;
  createSession(onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>): TurnAgentPromptSession;
  createSummarizationSession?(onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>): SummarizationPromptSession;
}

/** The box the terminal watch reads through, and what the watch remembers between turns. */
export interface TurnAgentShellWatchInput<ContextValue> {
  readonly box: {
    ensureReady(context: ContextValue, conversationId: string): Promise<{ readonly terminalsFolder: string; readonly remoteAccessor: ShellWatchResourceAccessor<ContextValue> }>;
  };
  readonly generatedState: ShellWatchGeneratedStateOwner<ContextValue>;
  readonly getConfirmedUserTurnWatermarkCache: () => ConfirmedUserTurnWatermark | undefined;
  readonly setConfirmedUserTurnWatermarkCache: (cache: ConfirmedUserTurnWatermark) => void;
  readonly now?: () => number;
}

export interface TurnAgentRunContextInput<ContextValue> {
  readonly context: ContextValue;
  readonly conversationId: string;
  readonly requestId: string;
  readonly inference: TurnAgentInferenceOwner;
  readonly onRequestId: (requestId: string) => void;
  readonly modelId?: string;
  readonly requestSource?: string;
  readonly isSubagentRunner: boolean;
  readonly isSilenceAllowed: boolean;
  readonly isComputerUseSubagent?: boolean;
  readonly isBrowserUseSubagent?: boolean;
  readonly hidden?: boolean;
  readonly lineage?: unknown;
  readonly canUseSelfSummary: () => boolean;
  readonly diskPressureReminder?: DiskPressureReminderEpisodes;
  readonly diskPressureClaimId?: string;
  readonly cancelThisRun: (reason: TurnCancellation) => void;
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
  readonly quietOrigin?: unknown;
  readonly directionEpoch?: number;
  readonly profilePromptSnapshot?: AgentProfilePromptSnapshot;
  /** The released profile/system-prompt owner; prompt assembly stays there. */
  readonly systemPromptAssembly?: Pick<ReturnType<typeof import("./system-prompt-assembly.ts").createSystemPromptAssembly>, "prepareAgentProfilePromptSnapshot" | "getAgentProfileUpdateForTurn">;
  readonly profilePromptSnapshotStore?: PromptSnapshotStore;
  readonly onProfileUpdateAppended?: (identity: { readonly name: string; readonly description: string }) => void;
  readonly emittedConnectorCards: Set<string>;
  readonly diskPressureReminderEpisodeId?: string | null;
  readonly shellWatch?: TurnAgentShellWatchInput<ContextValue>;
  readonly onLatestPromptMessages?: (getter: () => readonly MessageLike[]) => void;
}

export interface TurnAgentRunContext<ContextValue> {
  readonly privacyMode: PrivacyMode;
  readonly sessions: TurnAgentSessions;
  readonly scope: TurnAgentScope;
  readonly toolSession: { getExecutor(...args: readonly unknown[]): SimplePromptToolExecutor };
  readonly summarizationSession?: SummarizationPromptSession;
  readonly shellWatchHost?: ShellTerminalWatchHost<ContextValue>;
  readonly diskPressureReminderEpisodeId: string | null;
  readonly profilePromptSnapshot?: unknown;
  readonly profileUpdateForTurn?: { readonly text: string; readonly identity: { readonly name: string; readonly description: string } };
  commitDiskPressureReminder(): void;
  dispose(): void;
}

/** Which session this turn runs on: our own backend when the platform is selected, the routed provider otherwise. */
function inferenceProviderForThisTurn(): SlateInferenceProvider {
  return new SlateSettingsStore(join(getSlateRootDir(), "settings.json")).getInferenceProvider();
}

/** The claim that says this turn is the one cleaning up while the box is under pressure, if one was asked for. */
function claimedDiskPressureEpisode(input: TurnAgentRunContextInput<unknown>): string | null {
  if (input.diskPressureReminder == null || input.diskPressureClaimId == null) return input.diskPressureReminderEpisodeId ?? null;
  return input.diskPressureReminder.claim({ agentId: input.conversationId, claimId: input.diskPressureClaimId });
}

/** What a session is told about this turn: its model, what kind of subagent it is, and whether it may label prompts. */
function sessionOptionsFor(input: TurnAgentRunContextInput<unknown>) {
  return {
    ...presentOptions({
      modelId: input.modelId,
      isComputerUseSubagent: input.isComputerUseSubagent,
      isBrowserUseSubagent: input.isBrowserUseSubagent,
      requestSource: input.requestSource,
      lineage: input.lineage,
    }),
    skipLabeling: input.isSubagentRunner || input.hidden === true,
  };
}

/** What a summarization session is told: the summarization model, and that it is one. */
function summarizationOptionsFor(input: TurnAgentRunContextInput<unknown>) {
  return {
    modelId: SLATE_SUMMARIZATION_MODEL_ID,
    isSummarizationSession: true,
    ...presentOptions({ lineage: input.lineage }),
  };
}

/**
 * The middleware a tool message passes through, in the order it passes: the disk-pressure reminder first (it is about
 * the box), then the send-message reminder, then the ack reminder — and none of the reminders a subagent or a silent
 * turn has no use for.
 */
function executorWithReminders(input: TurnAgentRunContextInput<unknown>, episodeId: string | null, baseExecutor: () => PromptExecutor): PromptExecutor {
  const withDiskPressure = episodeId == null ? baseExecutor() : createDiskPressureReminderMiddleware(episodeId)(baseExecutor());
  if (input.isSubagentRunner || input.isSilenceAllowed) return withDiskPressure;
  const withSendMessage = createSendMessageReminderMiddleware()(withDiskPressure);
  return createStartOfTurnAckReminderMiddleware()(withSendMessage);
}

/** What a tool may do this turn: which privacy it runs under, how it is cancelled, and what it may append. */
function scopeFor(
  input: TurnAgentRunContextInput<unknown>,
  privacyMode: PrivacyMode,
  episodeId: string | null,
  profilePromptSnapshot: AgentProfilePromptSnapshot | undefined,
  profileUpdateForTurn: TurnAgentRunContext<unknown>["profileUpdateForTurn"],
): TurnAgentScope {
  return {
    isSilenceAllowed: input.isSilenceAllowed,
    privacyMode,
    ...presentOptions({
      quietOrigin: input.quietOrigin,
      directionEpoch: input.directionEpoch,
      ackToken: input.ackToken,
      pauseThisRun: input.pauseThisRun,
      isRunAwaitingUserSelection: input.isRunAwaitingUserSelection,
      endThisRunAwaitingUser: input.endThisRunAwaitingUser,
      profilePromptSnapshot,
      onProfileUpdateAppended: input.onProfileUpdateAppended,
      profileUpdateForTurn,
    }),
    cancelThisRun: input.cancelThisRun,
    diskPressureReminderEpisodeId: episodeId,
    emittedConnectorCards: input.emittedConnectorCards,
  };
}

/** The terminal watch as the shell sees it: the box, the watermark that says what the user has already seen. */
function shellWatchHostFor<ContextValue>(input: TurnAgentRunContextInput<ContextValue>): ShellTerminalWatchHost<ContextValue> | undefined {
  const watch = input.shellWatch;
  if (watch === undefined) return undefined;
  return {
    ctx: input.context,
    ...createShellWatchGeneratedStateProjection(watch.generatedState),
    getConversationId: () => input.conversationId,
    async ensureBoxReady(context, conversationId) {
      const connection = await watch.box.ensureReady(context, conversationId);
      return { terminalsFolder: connection.terminalsFolder, remoteAccessor: createShellWatchReadAccessor(connection.remoteAccessor) };
    },
    getConfirmedUserTurnWatermarkCache: watch.getConfirmedUserTurnWatermarkCache,
    setConfirmedUserTurnWatermarkCache: watch.setConfirmedUserTurnWatermarkCache,
    ...presentOptions({ now: watch.now }),
  };
}

/**
 * Everything one turn needs before an Agent can be built: its sessions, its privacy, the resources it may touch, and
 * the claim it holds until the turn is finished. Disposal is idempotent and releases an uncommitted claim.
 */
export async function createTurnAgentRunContext<ContextValue>(input: TurnAgentRunContextInput<ContextValue>): Promise<TurnAgentRunContext<ContextValue>> {
  const privacyMode = await input.inference.resolvePrivacyMode();
  const diskPressureReminderEpisodeId = claimedDiskPressureEpisode(input);
  const options = sessionOptionsFor(input);
  const provider = inferenceProviderForThisTurn();
  const ownsBackend = provider === "slate";
  const agent = ownsBackend ? input.inference.createSession(input.onRequestId, options) : (createProviderPromptSession(provider) as unknown as TurnAgentPromptSession);
  const summarizationSession = ownsBackend
    ? input.inference.createSummarizationSession?.(input.onRequestId, summarizationOptionsFor(input))
    : (createProviderPromptSession(provider) as unknown as SummarizationPromptSession);
  // A summarization session is not optional for a turn that has to compact: the platform's own session is used when the
  // caller did not offer one.
  const summarization = summarizationSession ?? input.inference.createSession(input.onRequestId, summarizationOptionsFor(input));
  const profilePromptSnapshot = input.profilePromptSnapshot ?? input.systemPromptAssembly?.prepareAgentProfilePromptSnapshot(input.profilePromptSnapshotStore);
  const profileUpdateForTurn = input.systemPromptAssembly?.getAgentProfileUpdateForTurn(profilePromptSnapshot) ?? undefined;
  const toolSession = {
    getExecutor: () => {
      const executor = new SimplePromptToolExecutor(executorWithReminders(input, diskPressureReminderEpisodeId, () => agent.getExecutor()));
      input.onLatestPromptMessages?.(() => executor.getMessages());
      return executor;
    },
  };
  const shellWatchHost = shellWatchHostFor(input);
  let claimed = false;
  let disposed = false;
  return {
    privacyMode,
    sessions: { agent, summarization, canUseSelfSummary: input.canUseSelfSummary },
    scope: scopeFor(input, privacyMode, diskPressureReminderEpisodeId, profilePromptSnapshot, profileUpdateForTurn),
    toolSession,
    ...presentOptions({ summarizationSession, shellWatchHost }),
    diskPressureReminderEpisodeId,
    ...presentOptions({ profilePromptSnapshot, profileUpdateForTurn }),
    commitDiskPressureReminder() {
      if (disposed || claimed || diskPressureReminderEpisodeId == null) return;
      claimed =
        input.diskPressureReminder?.commit({ agentId: input.conversationId, claimId: input.diskPressureClaimId ?? input.requestId }) ?? false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (claimed || diskPressureReminderEpisodeId == null) return;
      input.diskPressureReminder?.release({ agentId: input.conversationId, claimId: input.diskPressureClaimId ?? input.requestId });
    },
  };
}

export class SlateEmptyPromptError extends Error {
  constructor() {
    super("Prompt cannot be empty.");
  }
}

export class SlateTurnInterruptedBeforeDispatchError extends Error {
  constructor() {
    super("Turn interrupted before dispatch");
    this.name = "SlateTurnInterruptedBeforeDispatchError";
  }
}

export const RESUME_TURN_ACTION = new ConversationAction({ action: { case: "resumeAction", value: new ResumeAction() } });

export interface TurnRunOptions {
  readonly requestSource?: string;
  readonly automationWake?: { readonly id: string };
  readonly selectedImages?: readonly unknown[];
  readonly attachedFilePaths?: readonly string[];
  readonly selectedVideos?: readonly unknown[];
  readonly inferenceRequestId?: string;
  readonly ackToken?: string;
  readonly messageId?: string;
  readonly recentUserMessages?: readonly { readonly id: string; readonly text: string }[];
  readonly replyContext?: unknown;
  readonly hidden?: boolean;
  readonly isSilenceAllowed?: boolean;
  readonly autoReviewEpoch?: "continue" | "new";
  readonly lineage?: { readonly parentRequestId: string; readonly rootParentRequestId: string; readonly parentAgentToolCallId?: string };
}

export interface TurnCancellation {
  readonly intentional: boolean;
  readonly reason: string;
}

export interface TurnRunContext {
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly generation: number;
  readonly privacyMode?: unknown;
  readonly inferenceSession?: TurnSession;
  readonly boxConnection?: unknown;
  readonly mcpTools?: readonly unknown[];
}

export interface PreparedTurn {
  readonly action: unknown;
  readonly baseState: TurnCheckpoint;
  readonly transcriptPersistenceEnabled: boolean;
  readonly session: TurnSession;
}

export interface TurnStreamCallbacks {
  collectText(delta: string): void;
  collectSendMessage(): void;
  collectReaction(): void;
  collectAgentMessage(message: string): void;
  persistCheckpoint(checkpoint: TurnCheckpoint): Promise<void>;
  pauseForUser(reason: string): void;
  noteDispatched(): void;
}

export interface TurnRunShellHost {
  /** The prepared Agent stream path this shell hands the runner; the shell itself never builds one. */
  readonly turnStreamPath?: TurnStreamPath;
  readonly isSubagentRunner: boolean;
  readonly subagentType?: string;
  readonly inheritedRequestSource?: string;
  readonly inheritedAutomationId?: string;
  readonly subagents: { readonly sessions: ReadonlyMap<string, { interrupt(reason: string): void }> };
  getConversationId(): string;
  runGeneration(): number;
  setActiveTurnRequestSource(source: string | undefined): void;
  setActiveTurnAutomationId?(automationId: string | undefined): void;
  beginAutoReviewUserMessageEpoch(): void;
  setActiveRunInterrupted(value: boolean): void;
  setAwaitingUserSelection(value: boolean): void;
  isAwaitingUserSelection(): boolean;
  emitRunLifecycle(event: { type: "started" | "ended"; requestId: string }): void;
  emitUpdate?(event: { type: string; requestId?: string }): void;
  conversationSizeGuard?(): Promise<void>;
  beginLocalToolPermissionTurn?(conversationId: string): void;
  resolvePrivacyMode?(): Promise<unknown>;
  createInferenceSession?(context: TurnRunContext): Promise<TurnSession>;
  ensureBoxReady?(context: TurnRunContext): Promise<unknown>;
  discoverMcpTools?(context: TurnRunContext): Promise<readonly unknown[]>;
  refreshMcpAccountConfig?(): void;
  resolveMcpCustomInstructions?(): Promise<unknown>;
  setMcpDiscoveryUnavailableForTurn?(value: boolean): void;
  setMcpConnectedServerNamesForTurn?(names: readonly string[]): void;
  setMcpCustomInstructionsForTurn?(instructions: unknown): void;
  noteMcpToolDiscoveryFailed?(error: unknown): void;
  traceSendPhase?<T>(context: TurnRunContext, name: string, operation: () => Promise<T>): Promise<T>;
  setTurnTraceAttributes?(attributes: Readonly<Record<string, string>>): void;
  resolveAutomationId?(wakeId: string): string;
  prepareTurn(prompt: string, options: TurnRunOptions, context: TurnRunContext): Promise<PreparedTurn>;
  runPreparedTurn(prepared: PreparedTurn, context: TurnRunContext, callbacks: TurnStreamCallbacks): Promise<TurnCheckpoint>;
  createSettleHost(): TurnSettleHost;
  profilePromptSnapshots(): unknown;
  memoryStore?(): Parameters<typeof createTurnSettle>[1]["memoryStore"];
  episodeProgress?(): Parameters<typeof createTurnSettle>[1]["episodeProgress"];
  isMemorableExchange?: (prompt: string) => boolean;
  getLatestPromptMessages?(): readonly unknown[];
  ownsFinalState?(generation: number): boolean;
  onRunUnwind?(): void;
}

interface ActiveTurnRun {
  readonly controller: AbortController;
  readonly generation: number;
  readonly requestId: string;
  dispatched: boolean;
  recoveryShaped: boolean;
  awaitingUserSelection: boolean;
  quiescedForUpgrade: boolean;
}

export function createTurnRunShell(host: TurnRunShellHost) {
  let quiescingForUpgrade = false;
  let activeRun: ActiveTurnRun | null = null;

  const cancelRun = (run: ActiveTurnRun, cancellation: TurnCancellation): void => {
    if (!run.controller.signal.aborted) run.controller.abort(cancellation);
  };

  /**
   * An interrupt always stops the active run. A *superseding* request is narrower: before the run has dispatched it is
   * refused unless the run is the user's own message re-sent unchanged and the request carries recovery, so a resend
   * never cancels itself.
   */
  function interrupt(reason: string, supersede?: { readonly carriesRecovery: boolean }): boolean {
    const run = activeRun;
    if (run == null) return false;
    if (!run.dispatched && supersede != null && (!supersede.carriesRecovery || !run.recoveryShaped)) return false;
    host.setActiveRunInterrupted(true);
    cancelRun(run, { intentional: true, reason });
    return true;
  }

  function requestQuiesceForUpgrade(): void {
    quiescingForUpgrade = true;
  }

  function isQuiescingForUpgrade(): boolean {
    return quiescingForUpgrade;
  }

  function cancelQuiesceForUpgrade(): void {
    quiescingForUpgrade = false;
  }

  /** A pause ends the run on purpose: it is recorded as awaiting the user, not as an abort. */
  function endTurnAwaitingUser(reason: string, owner: ActiveTurnRun | null = activeRun): void {
    if (owner == null) return;
    owner.awaitingUserSelection = true;
    if (owner === activeRun) {
      host.setAwaitingUserSelection(true);
      cancelRun(owner, { intentional: true, reason });
      return;
    }
    cancelRun(owner, { intentional: true, reason: "awaiting user selection (escaped run)" });
  }

  function interruptAll(reason: string): boolean {
    const interrupted = interrupt(reason);
    for (const subagent of host.subagents.sessions.values()) subagent.interrupt(reason);
    return interrupted;
  }

  /** The run's own state, so a callback from a superseded turn can be recognized as one. */
  function activeRunFor(options: TurnRunOptions, prompt: string): ActiveTurnRun {
    const controller = new AbortController();
    const rawTranscriptText = options.messageId == null ? undefined : options.recentUserMessages?.find((message) => message.id === options.messageId)?.text;
    return {
      controller,
      generation: host.runGeneration(),
      requestId: options.inferenceRequestId ?? randomUUID(),
      dispatched: false,
      recoveryShaped:
        options.messageId != null &&
        (options.selectedImages ?? []).length === 0 &&
        (options.attachedFilePaths ?? []).length === 0 &&
        (options.selectedVideos ?? []).length === 0 &&
        options.replyContext == null &&
        rawTranscriptText != null &&
        rawTranscriptText === prompt,
      awaitingUserSelection: false,
      quiescedForUpgrade: false,
    };
  }

  /** The trace attributes this turn carries: the automation it woke for, and the kind of subagent it is. */
  function traceAttributesFor(options: TurnRunOptions): Readonly<Record<string, string>> {
    return {
      ...(options.automationWake == null ? {} : { "slate.automation_id": options.automationWake.id }),
      ...(!host.isSubagentRunner || host.subagentType == null ? {} : { "slate.subagent_type": host.subagentType }),
    };
  }

  /** The prompt a turn is about, with the attachments that make an empty prompt meaningful. */
  function assertPromptHasSomethingToSend(prompt: string, options: TurnRunOptions): void {
    const empty = prompt.length === 0;
    if (!empty) return;
    if ((options.selectedImages ?? []).length > 0) return;
    if ((options.attachedFilePaths ?? []).length > 0) return;
    if ((options.selectedVideos ?? []).length > 0) return;
    throw new SlateEmptyPromptError();
  }

  async function run(prompt: string, options: TurnRunOptions = {}): Promise<TurnSettleResult> {
    const requestSource = options.requestSource ?? host.inheritedRequestSource;
    host.setActiveTurnRequestSource(requestSource);
    host.setActiveTurnAutomationId?.(
      options.automationWake == null ? host.inheritedAutomationId : (host.resolveAutomationId?.(options.automationWake.id) ?? options.automationWake.id),
    );
    if (!host.isSubagentRunner && options.autoReviewEpoch !== "continue") host.beginAutoReviewUserMessageEpoch();

    const trimmedPrompt = prompt.trim();
    assertPromptHasSomethingToSend(trimmedPrompt, options);

    const runState = activeRunFor(options, trimmedPrompt);
    activeRun = runState;
    host.setActiveRunInterrupted(false);
    host.setAwaitingUserSelection(false);

    let lifecycleEnded = false;
    const endLifecycle = (): void => {
      if (lifecycleEnded) return;
      lifecycleEnded = true;
      host.emitRunLifecycle({ type: "ended", requestId: runState.requestId });
    };
    host.emitRunLifecycle({ type: "started", requestId: runState.requestId });
    const traceAttributes = traceAttributesFor(options);
    if (Object.keys(traceAttributes).length > 0) host.setTurnTraceAttributes?.(traceAttributes);

    const settle = createTurnSettle(host.createSettleHost(), {
      conversationId: host.getConversationId(),
      profilePromptSnapshots: host.profilePromptSnapshots(),
      ...presentOptions({
        memoryStore: host.memoryStore?.(),
        episodeProgress: host.episodeProgress?.(),
        isMemorableExchange: host.isMemorableExchange,
      }),
    });

    let prepared: PreparedTurn | undefined;
    let finalState: TurnCheckpoint | undefined;
    let aborted = false;
    const turnStartedAtMs = Date.now();
    let context: TurnRunContext = { signal: runState.controller.signal, requestId: runState.requestId, generation: runState.generation };

    try {
      if (!host.isSubagentRunner) {
        await host.conversationSizeGuard?.();
        if (options.autoReviewEpoch !== "continue") host.beginLocalToolPermissionTurn?.(host.getConversationId());
      }
      if (host.resolvePrivacyMode != null) context = { ...context, privacyMode: await host.resolvePrivacyMode() };
      if (runState.controller.signal.aborted) throw new SlateTurnInterruptedBeforeDispatchError();

      if (host.createInferenceSession != null) {
        const create = () => host.createInferenceSession!(context);
        context = { ...context, inferenceSession: host.traceSendPhase == null ? await create() : await host.traceSendPhase(context, "inference.createSession", create) };
      }

      host.setMcpDiscoveryUnavailableForTurn?.(false);
      if (host.discoverMcpTools != null) {
        try {
          const mcpTools = await host.discoverMcpTools(context);
          context = { ...context, mcpTools };
          host.setMcpConnectedServerNamesForTurn?.(
            mcpTools.flatMap((tool) =>
              typeof tool === "object" && tool != null && "providerIdentifier" in tool && typeof tool.providerIdentifier === "string" ? [tool.providerIdentifier] : [],
            ),
          );
        } catch (error) {
          // Discovery that failed is not a turn that failed: the turn runs without those tools and says so.
          host.noteMcpToolDiscoveryFailed?.(error);
        }
        host.refreshMcpAccountConfig?.();
      }
      if (host.resolveMcpCustomInstructions != null) host.setMcpCustomInstructionsForTurn?.(await host.resolveMcpCustomInstructions());

      prepared = await host.prepareTurn(trimmedPrompt, options, context);
      settle.noteBaseState(prepared.baseState, prepared.transcriptPersistenceEnabled);
      if (runState.controller.signal.aborted) throw new SlateTurnInterruptedBeforeDispatchError();

      if (host.ensureBoxReady != null) {
        const ensure = () => host.ensureBoxReady!(context);
        context = { ...context, boxConnection: host.traceSendPhase == null ? await ensure() : await host.traceSendPhase(context, "box.ensureReady", ensure) };
      }

      const callbacks: TurnStreamCallbacks = {
        ...settle.collectors,
        async persistCheckpoint(checkpoint): Promise<void> {
          // A checkpoint belongs to the generation that made it: a superseded turn must not write over its successor.
          if (host.runGeneration() !== runState.generation) return;
          settle.prepareCheckpointForPersistence(checkpoint);
          await settle.persistStepCheckpoint(context, checkpoint);
          if (runState.awaitingUserSelection) {
            cancelRun(runState, { intentional: true, reason: "awaiting user selection" });
          } else if (quiescingForUpgrade) {
            runState.quiescedForUpgrade = true;
            cancelRun(runState, { intentional: true, reason: "quiescing for forced host upgrade" });
          }
        },
        pauseForUser(reason): void {
          endTurnAwaitingUser(reason, runState);
        },
        noteDispatched(): void {
          runState.dispatched = true;
        },
      };

      finalState = await host.runPreparedTurn(prepared, context, callbacks);
      runState.dispatched = true;
      aborted = runState.controller.signal.aborted && !runState.awaitingUserSelection && !runState.quiescedForUpgrade;
      endLifecycle();
      if (!aborted && !runState.quiescedForUpgrade) {
        await settle.settleCompletedTurn({
          finalState,
          turnStartedAtMs,
          hidden: options.hidden === true,
          trimmedPrompt,
          session: prepared.session,
          baseContext: context,
          requestId: runState.requestId,
        });
      }
    } catch (error) {
      endLifecycle();
      // A pause and a host upgrade both abort on purpose; anything else that aborted is still the caller's to see.
      if (!runState.controller.signal.aborted) throw error;
      aborted = !runState.awaitingUserSelection && !runState.quiescedForUpgrade;
    } finally {
      const ownsRunner = activeRun === runState;
      if (ownsRunner) {
        activeRun = null;
        host.setActiveRunInterrupted(false);
        host.setActiveTurnAutomationId?.(undefined);
        host.onRunUnwind?.();
      }
      if (ownsRunner && finalState != null && host.runGeneration() === runState.generation && (host.ownsFinalState?.(runState.generation) ?? true)) {
        await settle.persistFinalState(context, finalState);
      }
      endLifecycle();
    }

    return settle.buildResult({
      aborted,
      ...(runState.quiescedForUpgrade ? { quiescedForUpgrade: true } : {}),
      ...(runState.awaitingUserSelection || host.isAwaitingUserSelection() ? { awaitingUserSelection: true } : {}),
    });
  }

  /** The prepared stream path, when the host built one: the shell hands it out rather than building its own. */
  function requireStreamPath(): TurnStreamPath {
    if (host.turnStreamPath === undefined) throw new Error("this shell was built without a turn stream path");
    return host.turnStreamPath;
  }

  return {
    run,
    turnStreamPath: host.turnStreamPath,
    runTurnStream: async (input: TurnStreamStartInput) => requireStreamPath().startStream(input),
    runTurnStreamLifecycle: (input: TurnStreamLifecycleInput, context: Context) => requireStreamPath().createLifecycle(input).run(context),
    interrupt,
    interruptAll,
    requestQuiesceForUpgrade,
    isQuiescingForUpgrade,
    cancelQuiesceForUpgrade,
    endTurnAwaitingUser,
    hasActiveRun: (): boolean => activeRun != null,
    activeRequestId: (): string | undefined => activeRun?.requestId,
  };
}

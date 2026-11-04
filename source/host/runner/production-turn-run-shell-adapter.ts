/**
 * Joins the Agent owner to the turn shell.
 *
 * The shell already owns the lifecycle (retry, accepted-checkpoint capture, generation gates, quiesce, final settle,
 * cleanup). What it does not own is how a turn is *prepared* and how its stream is *started* — that is this file, and it
 * is deliberately built from the real owner inputs rather than from an adapter bag the caller preassembles, so there is
 * one way a turn is put together:
 *
 * - **preparation** links the run's abort signal to a cancellable context, creates the Agent owner, projects this turn's
 *   action/MCP/state input from it, and keeps the owner alive until the shell unwinds;
 * - **the update relay** forwards every emitted update to the host, and *also* feeds the settled stream callbacks — but
 *   only while the prepared turn being emitted for is still the active one, so a superseded turn's updates cannot land
 *   in its successor's transcript;
 * - **the stream** is started from the projection the preparation kept, and the disk-pressure claim is committed only
 *   once the stream ended, because a claim is about a turn that actually ran;
 * - **unwinding** disposes the owner and the linked context, and drops the relay's callbacks, in that order.
 */
import type { Context } from "../../packages/context/context.ts";
import { cloneInteropRunnerConversationState, type InteropRunnerConversationState } from "../../adapters/interop/agent/runner-conversation-state-adapter.ts";
import {
  createProductionTurnAgentOwner,
  createProductionTurnAgentRunInput,
  type ProductionTurnAgentOwner,
  type ProductionTurnAgentOwnerInput,
  type ProductionTurnAgentRunInput,
} from "./production-turn-agent-owner.ts";
import { createTurnAgentStreamStart, type TurnAgentMcpTurnProvider } from "./turn-agent-composition.ts";
import { createTurnRunShell, type PreparedTurn, type TurnRunContext, type TurnRunOptions, type TurnRunShellHost, type TurnStreamCallbacks } from "./turn-run-shell.ts";
import type { TurnCheckpoint, TurnSession, TurnSettleHost } from "./turn-settle.ts";
import type { InteropTurnPromptOptions as GeneratedTurnPromptOptions } from "../../adapters/interop/agent/prompt-action-adapter.ts";
import type { ForwardedUpdate } from "./agent-adapters.ts";
import { presentOptions } from "./optional-options.ts";
import { ProductionTurnRunLease } from "./production-turn-run-lease.ts";

export interface ProductionTurnRunShellPreparedTurn extends PreparedTurn {
  readonly baseState: InteropRunnerConversationState;
  readonly productionInput: Awaited<ReturnType<typeof createProductionTurnAgentRunInput>>;
  readonly runContext: Context;
}

/** A context that is cancelled with the run: the run's signal decides, and disposing stops listening to it. */
function linkTurnRunContext(base: Context, signal: AbortSignal): { readonly context: Context; readonly dispose: () => void } {
  const [context, cancel] = base.withCancel();
  const abort = () => cancel(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return { context, dispose: () => signal.removeEventListener("abort", abort) };
}

/** The host inputs around the shell lifecycle: who creates the owner, what the prompt options are, and the live identities. */
export interface ProductionTurnRunShellAdapterInput {
  readonly createOwner: (input: {
    readonly requestId: string;
    readonly runOptions: TurnRunOptions;
    readonly context: Context;
    readonly cancelThisRun: ProductionTurnAgentOwner["runContext"]["scope"]["cancelThisRun"];
    readonly emitUpdate: (update: ForwardedUpdate) => void;
  }) => Promise<ProductionTurnAgentOwner>;
  readonly createRunInput: (input: {
    readonly owner: ProductionTurnAgentOwner;
    readonly runContext: Context;
    readonly prompt: string;
    readonly options: GeneratedTurnPromptOptions;
  }) => Promise<Awaited<ReturnType<typeof createProductionTurnAgentRunInput>>>;
  readonly promptOptions: (prompt: string, options: TurnRunOptions) => GeneratedTurnPromptOptions;
  readonly createSession: (owner: ProductionTurnAgentOwner) => TurnSession;
  readonly context: () => Context;
  readonly createSettleHost: () => TurnSettleHost;
  readonly profilePromptSnapshots: () => unknown;
  readonly isSubagentRunner: boolean;
  readonly subagentType?: string;
  readonly inheritedRequestSource?: string;
  readonly inheritedAutomationId?: string;
  readonly subagents: TurnRunShellHost["subagents"];
  readonly getConversationId: () => string;
  readonly runGeneration: () => number;
  readonly setActiveTurnRequestSource: (source: string | undefined) => void;
  readonly setActiveTurnAutomationId?: (automationId: string | undefined) => void;
  readonly beginAutoReviewUserMessageEpoch: () => void;
  readonly setActiveRunInterrupted: (value: boolean) => void;
  readonly setAwaitingUserSelection: (value: boolean) => void;
  readonly isAwaitingUserSelection: () => boolean;
  readonly emitRunLifecycle: TurnRunShellHost["emitRunLifecycle"];
  readonly emitUpdate: (update: ForwardedUpdate) => void;
  readonly lastReactionApplied?: () => boolean;
  readonly cancelThisRun: ProductionTurnAgentOwner["runContext"]["scope"]["cancelThisRun"];
  readonly onRunUnwind?: () => void;
}

/** The same inputs, expressed as the concrete owner inputs a host actually has, instead of the assembled adapter. */
export interface ProductionTurnRunShellHostInput extends Omit<ProductionTurnRunShellAdapterInput, "createOwner" | "createRunInput" | "promptOptions"> {
  readonly createAgentOwnerInput: (input: {
    readonly requestId: string;
    readonly runOptions: TurnRunOptions;
    readonly context: Context;
    readonly cancelThisRun: ProductionTurnAgentOwnerInput["cancelThisRun"];
    readonly emitUpdate: ProductionTurnAgentOwnerInput["emitUpdate"];
  }) => ProductionTurnAgentOwnerInput;
  readonly promptOptions: (prompt: string, options: TurnRunOptions) => GeneratedTurnPromptOptions;
  readonly assembleGeneratedTurnAction: ProductionTurnAgentRunInput["assembleGeneratedTurnAction"];
  readonly compactionEpoch: ProductionTurnAgentRunInput["compactionEpoch"];
  readonly getConversationState: ProductionTurnAgentRunInput["getConversationState"];
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: ProductionTurnAgentRunInput["onMcpDiscoveryFailed"];
}

/** Builds the two adapters the shell needs — one turn's owner, and one run's projection — from the real inputs. */
export function createProductionTurnRunShellHostInput(input: ProductionTurnRunShellHostInput): ProductionTurnRunShellAdapterInput {
  const { createAgentOwnerInput, assembleGeneratedTurnAction, compactionEpoch, getConversationState, mcp, onMcpDiscoveryFailed, promptOptions, ...lifecycle } = input;
  return {
    ...lifecycle,
    promptOptions,
    createOwner: async ({ requestId, runOptions, context, cancelThisRun, emitUpdate }) =>
      createProductionTurnAgentOwner({
        ...createAgentOwnerInput({ requestId, runOptions, context, cancelThisRun, emitUpdate }),
        context,
        requestId,
        cancelThisRun,
        emitUpdate,
      }),
    createRunInput: async ({ owner, runContext, prompt, options }) =>
      createProductionTurnAgentRunInput({
        runCtx: runContext,
        trimmedPrompt: prompt.trim(),
        promptOptions: options,
        assembleGeneratedTurnAction,
        compactionEpoch,
        getConversationState,
        ...presentOptions({
          profileUpdateForTurn: owner.runContext.profileUpdateForTurn,
          mcp,
          onMcpDiscoveryFailed,
        }),
      }),
  };
}

/**
 * A stream update goes to the host either way; it reaches the settled callbacks only while the turn it belongs to is
 * still the active one.
 */
function collectInto(callbacks: TurnStreamCallbacks, update: ForwardedUpdate, lastReactionApplied?: () => boolean): void {
  if (update.type === "text-delta" && typeof update.text === "string") {
    callbacks.collectText(update.text);
    return;
  }
  if (update.type === "send-message") {
    callbacks.collectSendMessage();
    const message = update.message;
    if (typeof message === "object" && message != null && Reflect.get(message, "type") === "text" && typeof Reflect.get(message, "content") === "string") {
      callbacks.collectAgentMessage(Reflect.get(message, "content"));
    }
    return;
  }
  // A reaction only counts once the platform applied it, so a rejected reaction is not collected as one.
  if (update.type === "react-to-message" && lastReactionApplied?.() === true) callbacks.collectReaction();
}

/** The Agent owner bound to the turn shell: preparation, the stream, and the unwind that releases both. */
export function createProductionTurnRunShellAdapter(input: ProductionTurnRunShellAdapterInput) {
  const leases = new ProductionTurnRunLease<ProductionTurnRunShellPreparedTurn, ProductionTurnAgentOwner>();
  const host: TurnRunShellHost = {
    isSubagentRunner: input.isSubagentRunner,
    subagents: input.subagents,
    getConversationId: input.getConversationId,
    runGeneration: input.runGeneration,
    setActiveTurnRequestSource: input.setActiveTurnRequestSource,
    beginAutoReviewUserMessageEpoch: input.beginAutoReviewUserMessageEpoch,
    setActiveRunInterrupted: input.setActiveRunInterrupted,
    setAwaitingUserSelection: input.setAwaitingUserSelection,
    isAwaitingUserSelection: input.isAwaitingUserSelection,
    emitRunLifecycle: input.emitRunLifecycle,
    createSettleHost: input.createSettleHost,
    profilePromptSnapshots: input.profilePromptSnapshots,
    ...presentOptions({
      subagentType: input.subagentType,
      inheritedRequestSource: input.inheritedRequestSource,
      inheritedAutomationId: input.inheritedAutomationId,
      setActiveTurnAutomationId: input.setActiveTurnAutomationId,
      onRunUnwind: input.onRunUnwind,
    }),
    async prepareTurn(prompt: string, options: TurnRunOptions, context: TurnRunContext): Promise<PreparedTurn> {
      const linked = linkTurnRunContext(input.context(), context.signal);
      let ownerForCleanup: ProductionTurnAgentOwner | undefined;
      let preparedForUpdates: ProductionTurnRunShellPreparedTurn | undefined;
      const emitUpdate = (update: ForwardedUpdate): void => {
        const callbacks = leases.activeCallbacksFor(preparedForUpdates);
        if (callbacks !== undefined) collectInto(callbacks, update, input.lastReactionApplied);
        input.emitUpdate(update);
      };
      try {
        const owner = await input.createOwner({ requestId: context.requestId, runOptions: options, context: linked.context, cancelThisRun: input.cancelThisRun, emitUpdate });
        ownerForCleanup = owner;
        const productionInput = await input.createRunInput({ owner, runContext: linked.context, prompt, options: input.promptOptions(prompt, options) });
        const baseState = cloneInteropRunnerConversationState(productionInput.baseState);
        if (baseState === undefined) throw new TypeError("the production Agent did not provide a cloneable base state");
        const result: ProductionTurnRunShellPreparedTurn = {
          action: productionInput.action,
          // The turn's base state is handed out as a copy: the stream mutates the one it runs on.
          baseState,
          transcriptPersistenceEnabled: true,
          session: input.createSession(owner),
          productionInput,
          runContext: linked.context,
        };
        leases.attach(result, owner, linked.dispose);
        preparedForUpdates = result;
        return result;
      } catch (error) {
        linked.dispose();
        try {
          ownerForCleanup?.dispose();
        } catch {
          // Cleanup cannot replace the preparation error the caller needs to diagnose.
        }
        throw error;
      }
    },
    async runPreparedTurn(preparedTurn: PreparedTurn, _context: TurnRunContext, callbacks: TurnStreamCallbacks): Promise<TurnCheckpoint> {
      const lease = leases.forPrepared(preparedTurn);
      if (lease === undefined) throw new TypeError("this prepared turn is not bound to a production owner");
      if (!leases.acceptCallbacks(preparedTurn, callbacks)) throw new TypeError("this prepared turn is no longer active");
      const owned = lease.prepared;
      const finalState = await createTurnAgentStreamStart({
        agent: lease.owner.built,
        baseState: owned.baseState,
        action: owned.productionInput.action,
        privacyMode: lease.owner.runContext.privacyMode,
        mcpTools: owned.productionInput.mcpTools,
      }).startStream(owned.runContext, undefined, async (_checkpointContext, checkpoint) => {
        await callbacks.persistCheckpoint(checkpoint);
      });
      // The turn ran, so the claim it made on the box's cleanup is committed here rather than before the stream.
      lease.owner.runContext.commitDiskPressureReminder();
      return finalState;
    },
    onRunUnwind: () => {
      // The stream context follows the shell's controller, so the outer run must stop listening to it before disposal.
      const lease = leases.releaseActive();
      lease?.disposeRunContext();
      lease?.owner.dispose();
      input.onRunUnwind?.();
    },
  };
  return createTurnRunShell(host);
}

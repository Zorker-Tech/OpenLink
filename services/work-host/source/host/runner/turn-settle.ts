/**
 * Settling a turn.
 *
 * What a turn ended with — its usage, its last message and what it left running — is written once when it settles, and a
 * turn that was already settled is not settled again.
 */
import { turnEndedOnSilentToolCalls } from "./turn-shape.ts";
import {
  settleCompletedTurnMemory,
  type MemoryEpisodeProgress,
  type SlateTurnMemoryStore,
} from "./turn-memory.ts";
import type { AgentProfilePromptSnapshot } from "./slate-agent-profile-prompt.ts";

/** The message a failure to append after a checkpoint is reported with. */
function appendFailureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `conversation checkpoint persisted but transcript append failed: ${detail}`;
}

export class TranscriptAppendAfterCheckpointError extends Error {
  readonly isTranscriptAppendAfterCheckpointError = true;

  constructor(cause: unknown) {
    super(appendFailureMessage(cause), { cause });
    this.name = "TranscriptAppendAfterCheckpointError";
  }
}

export interface TokenDetails {
  readonly usedTokens?: number;
  readonly maxTokens?: number;
}

export interface TurnCheckpoint {
  readonly summaryArchives: readonly unknown[];
  tokenDetails?: TokenDetails | undefined;
  turnTimings: SlateTurnTiming[];
}

/** A Slate-owned record of when a turn ended and how long it ran. */
export interface SlateTurnTiming {
  readonly timestampMs: bigint;
  readonly durationMs: bigint;
}

export interface ProfileIdentity {
  readonly name: string;
  readonly description: string;
}

export type ProfilePromptSnapshot = AgentProfilePromptSnapshot;

/** The mirror that keeps a transcript durable: prepare, abort, commit or skip one checkpoint at a time. */
interface TranscriptCheckpointMirror {
  prepareCheckpoint(
    runContext: unknown,
    transcript: string,
    state: TurnCheckpoint,
    blobs: unknown,
    isFinal: boolean,
    isForced: boolean,
  ): Promise<void>;
  abortCheckpoint(runContext: unknown, transcript: string): Promise<void>;
  commitCheckpoint(
    runContext: unknown,
    transcript: string,
    rootBlob?: string,
  ): Promise<void>;
  skipCheckpoint(
    runContext: unknown,
    transcript: string,
    state: TurnCheckpoint,
    blobs: unknown,
  ): Promise<void>;
}

export interface TurnSettleHost {
  readonly isSubagentRunner: boolean;
  readonly transcriptMirror?: TranscriptCheckpointMirror;
  getTranscriptId(): string;
  getBlobStore(): unknown;
  agentStore(): {
    handleCheckpoint(runContext: unknown, state: TurnCheckpoint): Promise<void>;
    getMetadata(metadataName: string): string | undefined;
  } | null;
  setLocalState(state: TurnCheckpoint): void;
  ownsRunner(): boolean;
  isRunSuperseded(): boolean;
  latestPromptMessages(): readonly unknown[];
  persistAnnouncedAgentProfile(
    allSnapshots: unknown,
    announced: ProfilePromptSnapshot,
    profile: ProfileIdentity,
  ): void;
  recordPostTurnLabeling?(input: {
    conversationId: string;
    requestId: string;
    modelName: string;
    messages: readonly unknown[];
  }): void;
  reportDiagnostic?(input: {
    kind: "labeling_failed";
    stage: "post_turn_record";
    errorClass: string;
  }): void;
  /** Materializes the record in the external wire format at the production boundary. */
  createTurnTiming?(timing: SlateTurnTiming): SlateTurnTiming;
}

export interface TurnSettleScope {
  readonly conversationId: string;
  readonly profilePromptSnapshots: unknown;
  readonly memoryStore?: SlateTurnMemoryStore;
  readonly episodeProgress?: MemoryEpisodeProgress | null;
  readonly isMemorableExchange?: (prompt: string) => boolean;
}

export interface TurnSession {
  getModelId(): string;
  getExecutor(): ReturnType<import("./turn-memory.ts").TurnMemorySession["getExecutor"]>;
}

export interface CompletedTurnArgs {
  readonly finalState: TurnCheckpoint;
  readonly turnStartedAtMs: number;
  readonly hidden: boolean;
  readonly trimmedPrompt: string;
  readonly session: TurnSession;
  readonly baseContext: unknown;
  readonly requestId?: string;
}

export interface TurnResultFlags {
  readonly aborted: boolean;
  readonly quiescedForUpgrade?: boolean;
  readonly awaitingUserSelection?: boolean;
  readonly streamOutputProduced?: boolean;
}

export interface TurnSettleResult extends TurnResultFlags {
  readonly text: string;
  readonly sentMessageCount: number;
  readonly reacted: boolean;
  readonly endedOnSilentToolCalls?: boolean;
}

// ---------------------------------------------------------------------------------------------
// what a checkpoint still has to remember

/** The token counts a checkpoint may carry, once it has been written with them. */
interface TokenDetailStateFresh {
  readonly kind: "fresh";
}

interface TokenDetailStateStale {
  readonly kind: "stale";
  readonly usedTokens?: number;
  readonly maxTokens?: number;
}

type TokenDetailState = TokenDetailStateFresh | TokenDetailStateStale;

/** The token counts a checkpoint arrived with, kept only when they were actually reported. */
function staleTokenDetails(tokenDetails: TokenDetails | undefined): TokenDetailStateStale {
  return {
    kind: "stale",
    ...(tokenDetails?.usedTokens == null ? {} : { usedTokens: tokenDetails.usedTokens }),
    ...(tokenDetails?.maxTokens == null ? {} : { maxTokens: tokenDetails.maxTokens }),
  };
}

/** Whether a checkpoint carries token counts that no longer match what was already written. */
function tokenDetailsDiffer(tokenDetails: TokenDetails | undefined, written: TokenDetailStateStale): boolean {
  return tokenDetails?.usedTokens !== written.usedTokens || tokenDetails?.maxTokens !== written.maxTokens;
}

// ---------------------------------------------------------------------------------------------
// the settler

export function createTurnSettle(
  runner: TurnSettleHost,
  settleScope: TurnSettleScope,
) {
  const textParts: string[] = [];
  let sentMessageCount = 0;
  let reacted = false;
  let endedOnSilentToolCalls = false;
  const agentMessages: string[] = [];

  /** Everything the turn said, in the order it was said. */
  const text = (): string => textParts.join("");

  const collectors = {
    collectText(piece: string): void {
      textParts.push(piece);
    },
    collectSendMessage(): void {
      sentMessageCount += 1;
    },
    collectReaction(): void {
      reacted = true;
    },
    collectAgentMessage(message: string): void {
      agentMessages.push(message);
    },
  };

  let profilePromptSnapshot: ProfilePromptSnapshot | undefined;
  let pendingProfileAnnouncement: ProfileIdentity | undefined;

  function setProfileSnapshot(snapshot: ProfilePromptSnapshot): void {
    profilePromptSnapshot = snapshot;
  }

  function noteProfileUpdateAppended(identity: ProfileIdentity): void {
    pendingProfileAnnouncement = identity;
  }

  /** Announces the profile of a turn that updated it, once that turn is actually durable. */
  function persistPendingProfileAnnouncement(): void {
    if (profilePromptSnapshot == null || pendingProfileAnnouncement == null) return;
    runner.persistAnnouncedAgentProfile(
      settleScope.profilePromptSnapshots,
      profilePromptSnapshot,
      pendingProfileAnnouncement,
    );
    pendingProfileAnnouncement = undefined;
  }

  let knownArchiveCount = 0;
  let persistenceEnabled = true;
  let writtenTokenDetails: TokenDetailState = { kind: "fresh" };

  function noteBaseState(
    baseState: TurnCheckpoint,
    enableTranscriptPersistence = true,
  ): void {
    knownArchiveCount = baseState.summaryArchives.length;
    persistenceEnabled = enableTranscriptPersistence;
  }

  /** Takes the token counts off a checkpoint that arrived with more archives than were already written. */
  function prepareCheckpointForPersistence(state: TurnCheckpoint): void {
    const tokenDetails = state.tokenDetails;
    if (state.summaryArchives.length > knownArchiveCount) {
      knownArchiveCount = state.summaryArchives.length;
      writtenTokenDetails = staleTokenDetails(tokenDetails);
    } else if (writtenTokenDetails.kind === "stale" && tokenDetailsDiffer(tokenDetails, writtenTokenDetails)) {
      writtenTokenDetails = { kind: "fresh" };
    }
    if (writtenTokenDetails.kind === "stale") {
      state.tokenDetails = undefined;
    }
  }

  /** Writes one checkpoint to wherever it is kept, with the mirror in step when it is enabled. */
  async function persistCheckpoint(
    runContext: unknown,
    state: TurnCheckpoint,
    finalizeCheckpoint: boolean,
  ): Promise<void> {
    const mirror = runner.transcriptMirror;
    const preparedMirror = persistenceEnabled ? mirror : undefined;

    if (preparedMirror != null) {
      await preparedMirror.prepareCheckpoint(
        runContext,
        runner.getTranscriptId(),
        state,
        runner.getBlobStore(),
        finalizeCheckpoint,
        finalizeCheckpoint || runner.isSubagentRunner,
      );
    }

    const store = runner.agentStore();
    try {
      if (store != null) {
        await store.handleCheckpoint(runContext, state);
      } else {
        runner.setLocalState(state);
      }
    } catch (error) {
      if (preparedMirror != null) {
        await Promise.allSettled([
          preparedMirror.abortCheckpoint(runContext, runner.getTranscriptId()),
        ]);
      }
      throw error;
    }

    if (preparedMirror != null) {
      try {
        const rootBlobId = store?.getMetadata("latestRootBlobId");
        await preparedMirror.commitCheckpoint(
          runContext,
          runner.getTranscriptId(),
          ...(rootBlobId == null ? [] : [rootBlobId]),
        );
      } catch (error) {
        throw new TranscriptAppendAfterCheckpointError(error);
      }
    } else {
      await mirror?.skipCheckpoint(
        runContext,
        runner.getTranscriptId(),
        state,
        runner.getBlobStore(),
      );
    }
  }

  async function persistStepCheckpoint(
    runContext: unknown,
    state: TurnCheckpoint,
  ): Promise<void> {
    await persistCheckpoint(runContext, state, false);
    if (runner.ownsRunner()) persistPendingProfileAnnouncement();
  }

  /** Records when the turn ended, in its own timing list. */
  function appendTurnTiming(state: TurnCheckpoint, turnStartedAtMs: number, turnEndedAtMs: number): void {
    const timing: SlateTurnTiming = {
      timestampMs: BigInt(turnEndedAtMs),
      durationMs: BigInt(Math.max(0, turnEndedAtMs - turnStartedAtMs)),
    };
    state.turnTimings.push(runner.createTurnTiming?.(timing) ?? timing);
  }

  /** Notes whether the turn ended because its last tool calls had nothing to say. */
  function noteSilentToolCallEnding(turnArgs: CompletedTurnArgs): void {
    if (runner.isSubagentRunner || turnArgs.hidden) return;
    endedOnSilentToolCalls = turnEndedOnSilentToolCalls(runner.latestPromptMessages());
  }

  /** Tells the post-turn labeler about a visible turn that has a request to name it. */
  function recordPostTurnLabeling(turnArgs: CompletedTurnArgs): void {
    if (runner.isSubagentRunner || turnArgs.hidden || runner.recordPostTurnLabeling == null) return;
    const visibleMessages = runner.latestPromptMessages();
    if (visibleMessages.length === 0 || turnArgs.requestId == null || turnArgs.requestId === "") return;
    try {
      runner.recordPostTurnLabeling({
        conversationId: settleScope.conversationId,
        requestId: turnArgs.requestId,
        modelName: turnArgs.session.getModelId(),
        messages: visibleMessages,
      });
    } catch (error) {
      runner.reportDiagnostic?.({
        kind: "labeling_failed",
        stage: "post_turn_record",
        errorClass: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /** Whether this turn is one the memory store should be told about. */
  function worthRemembering(turnArgs: CompletedTurnArgs): boolean {
    return !runner.isRunSuperseded()
      && settleScope.memoryStore != null
      && !turnArgs.hidden
      && turnArgs.trimmedPrompt.length > 0
      && (
        settleScope.memoryStore.recordMemoryEvidence != null
        || settleScope.isMemorableExchange?.(turnArgs.trimmedPrompt) === true
      );
  }

  /** What the turn said back, as memory records it: every agent message and the answer, with blanks dropped. */
  function agentSideOfExchange(): string {
    return [...agentMessages, text()]
      .filter((part) => part.trim().length > 0)
      .join("\n");
  }

  async function settleCompletedTurn(turnArgs: CompletedTurnArgs): Promise<void> {
    const turnEndedAtMs = Date.now();
    appendTurnTiming(turnArgs.finalState, turnArgs.turnStartedAtMs, turnEndedAtMs);
    noteSilentToolCallEnding(turnArgs);
    recordPostTurnLabeling(turnArgs);

    if (worthRemembering(turnArgs) && settleScope.memoryStore != null) {
      await settleCompletedTurnMemory(
        settleScope.memoryStore,
        settleScope.episodeProgress,
        turnArgs.session,
        turnArgs.baseContext,
        turnArgs.turnStartedAtMs,
        { user: turnArgs.trimmedPrompt, agent: agentSideOfExchange() },
      );
    }
  }

  async function persistFinalState(
    runContext: unknown,
    finalState: TurnCheckpoint,
  ): Promise<void> {
    prepareCheckpointForPersistence(finalState);
    await persistCheckpoint(runContext, finalState, true);
    persistPendingProfileAnnouncement();
  }

  /** A flag a result carries only when it is true, so a false flag is absent rather than false. */
  function presentFlag<Key extends string>(key: Key, present: boolean): Partial<Record<Key, true>> {
    return present ? { [key]: true } as Partial<Record<Key, true>> : {};
  }

  function buildResult(flags: TurnResultFlags): TurnSettleResult {
    return {
      text: text(),
      sentMessageCount,
      reacted,
      aborted: flags.aborted,
      ...presentFlag("quiescedForUpgrade", flags.quiescedForUpgrade === true),
      ...presentFlag("awaitingUserSelection", flags.awaitingUserSelection === true),
      ...presentFlag("endedOnSilentToolCalls", endedOnSilentToolCalls),
      ...presentFlag("streamOutputProduced", flags.streamOutputProduced === true),
    };
  }

  return {
    collectors,
    setProfileSnapshot,
    noteProfileUpdateAppended,
    noteBaseState,
    prepareCheckpointForPersistence,
    persistStepCheckpoint,
    settleCompletedTurn,
    persistFinalState,
    buildResult,
  };
}

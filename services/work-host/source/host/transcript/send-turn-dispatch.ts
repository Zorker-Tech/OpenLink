/** Sending a turn into a conversation, and what to do when that fails.

 * The message is stamped, threaded and handed on; a send that could not be accepted is recovered — the queue it belongs
 * to, the acknowledgement that is owed, and the error the user sees — rather than left half done. */
import { buildComposedOfflineNote } from "./send-message-shaping.ts";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.ts";
import type { LiveTranscriptSession } from "./session-runtime.ts";

export interface RecoverySend {
  readonly epoch: number;
  readonly messageId: string;
  readonly recentUserMessages: readonly {
    id: string;
    text: string;
    richText?: unknown;
  }[];
}

export interface SendAckGuard {
  disarm(): void;
}

export interface DispatchUserTurnArgs {
  readonly tm: TranscriptManagerLike;
  readonly session: LiveTranscriptSession;
  readonly trimmedPrompt: string;
  readonly richText?: unknown;
  readonly composedAtMs?: number;
  readonly enterEpochMs?: number;
  readonly clientNonce?: string;
  readonly awaitTurn: boolean;
  readonly isFork: boolean;
  readonly userMessageId?: string;
  readonly replyContext?: unknown;
  readonly selectedImages: readonly unknown[];
  readonly selectedVideos?: readonly unknown[];
  readonly fileAttachmentPaths: readonly string[];
  readonly attachedFileSizes: ReadonlyMap<string, number>;
  readonly traceCtx?: unknown;
  readonly acceptedAtMs: number;
  readonly wasInFlight: boolean;
  readonly readAddressedTranscript: () => readonly TranscriptEntry[];
  readonly latestRecoverySends: Map<string, RecoverySend>;
  readonly recoveryBreakEpochs: Map<string, number>;
  readonly nextTurnEpoch: (session: LiveTranscriptSession) => number;
  readonly markSendAccepted: (clientNonce?: string) => void;
  readonly ackGuard: SendAckGuard;
}


function addressedRecoveryMessages(readAddressedTranscript: () => readonly TranscriptEntry[]): RecoverySend["recentUserMessages"] {
  return readAddressedTranscript()
    .filter(
      (entry) =>
        entry.kind === "message" &&
        entry.role === "user" &&
        entry.fromAgent == null &&
        entry.channel == null,
    )
    .map((entry) => ({
      id: entry.id,
      text: typeof entry.content === "string" ? entry.content : "",
      ...(entry.richText == null ? {} : { richText: entry.richText }),
    }))
}

function composeRunPrompt(tm: TranscriptManagerLike, session: LiveTranscriptSession, prompt: string, richText: unknown, composedAtMs: number | undefined): string {
  const expandedPrompt = tm.workflowCommands.withMentionedAgentsContext(
    session,
    prompt,
    tm.workflowCommands.expandWorkflowReferences(session, prompt, richText),
  )
  const offlineNote = composedAtMs == null ? "" : buildComposedOfflineNote(composedAtMs)
  return offlineNote.length > 0 ? `${offlineNote}
${expandedPrompt}` : expandedPrompt
}

function supersedeActiveRuns(
  tm: TranscriptManagerLike,
  session: LiveTranscriptSession,
  agentRunner: ReturnType<TranscriptManagerLike["runnerRegistry"]["getRunner"]>,
  carriesRecovery: boolean,
  acceptedAtMs: number,
  wasInFlight: boolean,
): boolean {
  tm.runLifecycle.beginSessionRun(session)
  const hadActiveGroupMemberRun = tm.runnerRegistry.activeGroupMemberRunners
    .get(session.id)
    ?.interrupt("superseded by a direct user message") ?? false
  if (hadActiveGroupMemberRun) tm.groupChat.dmPreemptedGroupMemberIds.add(session.id)
  const hadActiveOneToOneRun = agentRunner.interrupt("superseded by a new user message", { carriesRecovery })
  if (hadActiveOneToOneRun) tm.backgroundWakes.dmPreemptedWakeAgentIds.add(session.id)
  const hadActiveRun = hadActiveOneToOneRun || hadActiveGroupMemberRun
  tm.telemetry.reportTurnInterrupt({ conversationId: session.id, reason: "superseded", hadActiveRun, wasInFlight })
  tm.ackObligations.confirmAckObligationAfterInterrupt(session, acceptedAtMs, hadActiveRun)
  return hadActiveRun
}

function buildTurnRunOptions(input: {
  richText: unknown
  selectedImages: readonly unknown[]
  selectedVideos: readonly unknown[] | undefined
  fileAttachmentPaths: readonly string[]
  attachedFileSizes: ReadonlyMap<string, number>
  messageId: string | undefined
  recentUserMessages: RecoverySend["recentUserMessages"] | undefined
  replyContext: unknown
  isFork: boolean
  traceCtx: unknown
  enterEpochMs: number | undefined
  queueStartEpochMs: number
  queueStartPerfMs: number
  clientNonce: string | undefined
  ackToken: string | undefined
}): Record<string, unknown> {
  return {
    richText: input.richText,
    selectedImages: input.selectedImages,
    selectedVideos: input.selectedVideos,
    attachedFilePaths: input.fileAttachmentPaths,
    attachedFileSizes: input.attachedFileSizes,
    messageId: input.messageId,
    recentUserMessages: input.recentUserMessages,
    replyContext: input.replyContext,
    isFork: input.isFork,
    traceCtx: input.traceCtx,
    enterEpochMs: input.enterEpochMs,
    queueStartEpochMs: input.queueStartEpochMs,
    queueStartPerfMs: input.queueStartPerfMs,
    clientNonce: input.clientNonce,
    ackToken: input.ackToken,
  }
}

function reportDetachedTurnFailure(failure: unknown): void {
  console.error("[slate] detached turn failed after send acceptance:", failure)
}

export async function dispatchUserTurn(
  args: DispatchUserTurnArgs,
): Promise<void> {
  const {
    tm: transcriptManager,
    session: liveSession,
    trimmedPrompt: cleanPrompt,
    richText: richContent,
    composedAtMs: composedAt,
    enterEpochMs: enterAt,
    clientNonce: nonceValue,
    awaitTurn: shouldAwait,
    isFork: forking,
    userMessageId: userEntryId,
    replyContext: replyInfo,
    selectedImages: imageInputs,
    selectedVideos: videoInputs,
    fileAttachmentPaths: attachmentPaths,
    attachedFileSizes: attachmentSizes,
    traceCtx: traceContext,
    acceptedAtMs: acceptedAt,
    wasInFlight: wasRunning,
    readAddressedTranscript: readAddressed,
    latestRecoverySends: recoverySends,
    recoveryBreakEpochs: recoveryBreaks,
    nextTurnEpoch: nextEpoch,
    markSendAccepted: markAccepted,
    ackGuard: ackGuardHandle,
  } = args;
  const agentRunner = transcriptManager.runnerRegistry.getRunner(liveSession);
  const recentUserMessages = userEntryId == null ? undefined : addressedRecoveryMessages(readAddressed);
  const promptForRun = composeRunPrompt(transcriptManager, liveSession, cleanPrompt, richContent, composedAt);
  const epoch = nextEpoch(liveSession);
  const carriesRecovery = userEntryId != null && !forking;
  if (carriesRecovery && recentUserMessages != null) {
    recoverySends.set(liveSession.id, {
      epoch,
      messageId: userEntryId,
      recentUserMessages,
    });
  } else {
    recoveryBreaks.set(liveSession.id, epoch);
  }

  const hadActiveRun = supersedeActiveRuns(transcriptManager, liveSession, agentRunner, carriesRecovery, acceptedAt, wasRunning);
  const ackToken = transcriptManager.ackObligations.mintAckRunToken(liveSession.id);
  const queueStartEpochMs = Date.now();
  const queueStartPerfMs = performance.now();
  const turnDone = transcriptManager.runLifecycle.enqueueExclusiveRun(
    liveSession.id,
    () =>
      transcriptManager.turnRuntime.runTurn(
        liveSession,
        agentRunner,
        promptForRun,
        buildTurnRunOptions({ richText: richContent, selectedImages: imageInputs, selectedVideos: videoInputs, fileAttachmentPaths: attachmentPaths, attachedFileSizes: attachmentSizes, messageId: userEntryId, recentUserMessages, replyContext: replyInfo, isFork: forking, traceCtx: traceContext, enterEpochMs: enterAt, queueStartEpochMs, queueStartPerfMs, clientNonce: nonceValue, ackToken }),
        epoch,
      ),
    {
      lane: "user",
      source: "turn",
      acceptedAtMs: acceptedAt,
      ...(ackToken == null ? {} : { ackToken }),
    },
  ) as Promise<void>;
  ackGuardHandle.disarm();
  markAccepted(nonceValue);
  if (shouldAwait) await turnDone;
  else void turnDone.catch(reportDetachedTurnFailure);
}

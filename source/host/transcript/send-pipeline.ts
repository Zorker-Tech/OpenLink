/** Sending what the user typed, once and only once.

 * A send is admitted against the ledger so a retried nonceValue does not go out twice, the entries it stands for — its
 * attachments and its incomingMessage — are appended to the timeline and to the session, and the turn is then either fanned out
 * to a room or dispatched to the agent, carrying the acknowledgement obligation and the send trace along with it. */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  RUNNER_UNATTACHED_MESSAGE,
  type TranscriptEntry,
  type TranscriptManagerLike,
} from "./transcript-hub.ts";
import { HOST_ACCOUNT_SLOT } from "../../shared/send-acceptance.ts";
import { filePathFromFileUrl } from "../../shared/node/paths.ts";
import { loadSelectedImageInputs } from "../selected-image-inputs.ts";
import { beginSendTrace, traceSendPhase } from "../send-trace-host.ts";
import { BoxRequestEntries } from "./box-request-entries.ts";
import {
  materializeInlineImages,
  type InlineImage,
} from "./inline-image-materialization.ts";
import {
  buildSelectedVideos,
  createSendMessageEntry,
  createUserAttachmentEntry,
  createUserMessage,
  splitAttachmentPathsByChannel,
  statAttachedFileSizes,
  type SendMessage,
} from "./send-message-shaping.ts";
import {
  resolveSendReplyThreading,
  applyAutoReplyThread,
  validateAiReplyTarget,
} from "./send-thread-stamping.ts";
import { nextEntryId } from "./transcript-entry-ids.ts";
import { getTranscript, removeEntry } from "./transcript-store.ts";
import { sendInputDigest } from "./prompt-acceptance-ledger.ts";
import {
  dispatchUserTurn,
  type RecoverySend,
  type SendAckGuard,
} from "./send-turn-dispatch.ts";
import type { LiveTranscriptSession } from "./session-runtime.ts";
import {
  appendAddressedEcho,
  applySendRosterSideEffects,
  emitAcceptedSendEchoes,
  type SendAcceptanceTraceContext,
} from "./send-acceptance.ts";
import { dispatchMirrorOrGroupSend } from "./send-group-fanout.ts";

export interface SendPromptOptions {
  readonly agentId?: string;
  readonly clientNonce?: string;
  readonly traceparent?: string;
  readonly richText?: string;
  readonly replyToId?: string;
  readonly isFork?: boolean;
  readonly attachmentPaths?: readonly string[];
  readonly attachmentNames?: readonly string[];
  readonly appendUserMessage?: boolean;
  readonly awaitTurn?: boolean;
  readonly directAddressedAcceptance?: boolean;
  readonly composedAtMs?: number;
  readonly enterEpochMs?: number;
}

export interface EchoEntry {
  readonly entry: TranscriptEntry;
  readonly isOnActiveTranscript: boolean;
}

function invariant(condition: unknown, incomingMessage: string): asserts condition {
  if (!condition) throw new Error(incomingMessage);
}

export class SendPipeline {
  readonly sendAttachmentBatchIds = new Map<string, string>();
  readonly turnEpochs = new Map<string, number>();
  readonly latestRecoverySends = new Map<string, RecoverySend>();
  readonly recoveryBreakEpochs = new Map<string, number>();
  readonly inFlightSends = new Map<string, Promise<void>>();
  readonly boxRequests: BoxRequestEntries;

  constructor(readonly tm: TranscriptManagerLike) {
    this.boxRequests = new BoxRequestEntries(tm);
  }

  promptAcceptanceStatus(input: {
    accountSlot: string;
    clientNonce: string;
  }): unknown {
    return this.tm.acceptanceLedger.lookup(input);
  }

  materializeInlineImages(
    session: { dbPath: string },
    images: readonly InlineImage[],
  ) {
    return materializeInlineImages(session, images);
  }

  async sendPrompt(prompt: string, settings: SendPromptOptions): Promise<void> {
    const nonceValue = settings.clientNonce?.length ? settings.clientNonce : undefined;
    if (nonceValue == null) return this.sendPromptOnce(prompt, settings);
    const inFlight = this.inFlightSends.get(nonceValue);
    if (inFlight != null) {
      console.log(
        "[slate] duplicate send (nonce still in flight) — coalescing onto the running attempt",
      );
      return inFlight;
    }
    const inputDigest = sendInputDigest({
      ...(settings.agentId == null ? {} : { agentId: settings.agentId }),
      prompt,
      ...(settings.richText == null ? {} : { richText: settings.richText }),
      ...(settings.replyToId == null ? {} : { replyToId: settings.replyToId }),
      ...(settings.isFork == null ? {} : { isFork: settings.isFork }),
      ...(settings.attachmentPaths == null
        ? {}
        : { attachmentPaths: settings.attachmentPaths }),
      ...(settings.attachmentNames == null
        ? {}
        : { attachmentNames: settings.attachmentNames }),
    });
    const ledgerAdmission = this.tm.acceptanceLedger.admitSend({
      accountSlot: HOST_ACCOUNT_SLOT,
      clientNonce: nonceValue,
      inputDigest: inputDigest,
    });
    if (ledgerAdmission.kind === "duplicate") {
      console.log(
        "[slate] duplicate send (nonce already accepted) — idempotent no-op",
      );
      return;
    }
    const pending = this.sendPromptOnce(prompt, settings, { inputDigest });
    this.inFlightSends.set(nonceValue, pending);
    try {
      await pending;
    } catch (error) {
      this.tm.acceptanceLedger.clearUnlessAccepted({
        accountSlot: HOST_ACCOUNT_SLOT,
        clientNonce: nonceValue,
      });
      throw error;
    } finally {
      this.inFlightSends.delete(nonceValue);
    }
  }

  async sendPromptOnce(
    prompt: string,
    settings: SendPromptOptions,
    acceptance?: { inputDigest: string },
  ): Promise<void> {
    const cleanPrompt = prompt.trim();
    const attachmentPaths = Array.isArray(settings.attachmentPaths)
      ? settings.attachmentPaths.filter(
          (filePath): filePath is string => typeof filePath === "string",
        )
      : [];
    if (cleanPrompt.length === 0 && attachmentPaths.length === 0) return;
    invariant(this.tm.execution.canExecute, RUNNER_UNATTACHED_MESSAGE);
    const awaitTurn = settings.awaitTurn ?? true;
    const trace = beginSendTrace(settings.traceparent);
    const hostReceiptEpochMs = Date.now();
    const hostReceiptPerfMs = performance.now();
    let pinnedConversation: LiveTranscriptSession | undefined;
    let ackGuard: (SendAckGuard & { [Symbol.dispose]?(): void }) | undefined;
    try {
      if (settings.directAddressedAcceptance !== true)
        await this.tm.sessions.ensureActionTarget(settings.agentId);
      const resolvedSession =
        settings.agentId == null
          ? await traceSendPhase(
              trace,
              "ensureSession",
              async () =>
                this.tm.sessions.ensureSession() as Promise<LiveTranscriptSession>,
            )
          : undefined;
      const targetAgent = settings.agentId ?? resolvedSession?.id;
      invariant(targetAgent != null, "A send target could not be resolved.");
      const wasRunning = this.tm.runLifecycle
        .runningAgentIds()
        .has(targetAgent);
      const session = (await this.tm.groupChat.pinMemberSessionForGroupTurn(
        targetAgent,
      )) as LiveTranscriptSession;
      pinnedConversation = session;
      const isOnScreen = () =>
        this.tm.sessions.activeSession?.id === session.id &&
        this.tm.sessions.inMemoryTranscriptAgentId === session.id;
      const readTranscript = () =>
        isOnScreen()
          ? getTranscript()
          : (session.db.getTranscriptEntries() as TranscriptEntry[]);
      const appendEcho = (
        build: (entries: readonly TranscriptEntry[]) => TranscriptEntry,
        appendOptions: { onPersistOutcome(isDurable: boolean): void },
      ) =>
        appendAddressedEcho(this.tm, session, isOnScreen, build, appendOptions);
      try {
        trace?.span.setAttribute("slate.conversation_id", session.id);
        trace?.span.setAttribute(
          "slate.attachment_count",
          attachmentPaths.length,
        );
        trace?.span.setAttribute(
          "slate.span_scope",
          awaitTurn
            ? "host-receipt-to-turn-end"
            : "host-receipt-to-durable-acceptance",
        );
        if (settings.clientNonce != null && settings.clientNonce.length > 0) {
          trace?.span.setAttribute(
            "slate.client_nonce",
            settings.clientNonce,
          );
        }
        if (settings.isFork === true) {
          trace?.span.setAttribute("slate.is_fork", true);
        }
      } catch {}
      if (!this.tm.groupChat.isGroupSession(session))
        this.tm.telemetry.reportUserMessageReceived({
          conversationId: session.id,
          wasInFlight: wasRunning,
        });
      session.db.setIntroductionPending(false);
      const rosterDirty = applySendRosterSideEffects(
        this.tm,
        session,
        cleanPrompt,
        readTranscript,
      );
      const threadingInfo = resolveSendReplyThreading(
        { turnRuntime: this.tm.turnRuntime },
        settings.replyToId,
        settings.isFork === true,
        readTranscript,
      );
      const attachmentNames = settings.attachmentNames ?? [];
      const batchKey =
        attachmentPaths.length > 0 ? crypto.randomUUID() : undefined;
      const durableAppendStartEpochMs = Date.now();
      const durableAppendStartPerfMs = performance.now();
      let durable = true;
      const observePersistOutcome = (isDurable: boolean) => {
        if (!isDurable) durable = false;
      };
      const echoes: EchoEntry[] = [];
      let messageEntryId: string | undefined;
      const fileSizes = await statAttachedFileSizes(attachmentPaths);
      try {
        for (const [position, filePath] of attachmentPaths.entries()) {
          const name = attachmentNames[position];
          const bytes = fileSizes.get(filePath);
          const attachmentEntry = await createUserAttachmentEntry(
            this.tm.attachments,
            "pending-user-attachment-id",
            filePath,
            {
              ...(threadingInfo.replyToId == null
                ? {}
                : { replyTo: threadingInfo.replyToId }),
              ...(batchKey == null ? {} : { batchId: batchKey }),
              ...(typeof name !== "string" ? {} : { fileName: name }),
              ...(threadingInfo.isFork ? { branched: true } : {}),
              ...(settings.clientNonce == null
                ? {}
                : { clientNonce: settings.clientNonce }),
              ...(bytes == null ? {} : { byteSize: bytes }),
            },
          );
          echoes.push(
            appendEcho(
              (entries) => ({
                ...attachmentEntry,
                id: nextEntryId(entries, "user-attachment"),
              }),
              { onPersistOutcome: observePersistOutcome },
            ),
          );
        }
        if ((settings.appendUserMessage ?? true) && cleanPrompt.length > 0) {
          const entry = appendEcho(
            (entries) =>
              createUserMessage(
                nextEntryId(entries, "user-message"),
                cleanPrompt,
                {
                  ...(settings.richText == null
                    ? {}
                    : { richText: settings.richText }),
                  ...(threadingInfo.replyToId == null
                    ? {}
                    : { replyTo: threadingInfo.replyToId }),
                  ...(settings.clientNonce == null
                    ? {}
                    : { clientNonce: settings.clientNonce }),
                  ...(batchKey == null ? {} : { batchId: batchKey }),
                  ...(threadingInfo.isFork ? { branched: true } : {}),
                  ...(settings.composedAtMs == null
                    ? {}
                    : { composedAtMs: settings.composedAtMs }),
                },
              ),
            { onPersistOutcome: observePersistOutcome },
          );
          messageEntryId = entry.entry.id;
          echoes.push(entry);
        }
      } catch (error) {
        for (const { entry } of echoes) {
          session.db.deleteTranscriptEntry(entry.id);
          if (this.tm.sessions.inMemoryTranscriptAgentId === session.id)
            removeEntry(entry.id);
        }
        throw error;
      }
      if (!durable) {
        console.warn(
          "[slate] send accepted NON-durably (persist dropped on a locked db); the echo still shipped so the send proceeds, but a host crash before the next successful write would lose the entry",
        );
      }
      if (settings.clientNonce != null && acceptance != null)
        this.tm.acceptanceLedger.recordPending({
          accountSlot: HOST_ACCOUNT_SLOT,
          clientNonce: settings.clientNonce,
          inputDigest: acceptance.inputDigest,
          agentId: session.id,
          echoEntryId: messageEntryId ?? echoes[0]?.entry.id ?? null,
        });
      const acceptedAtMs = Date.now();
      const ackOwed =
        !this.tm.groupChat.isRemoteRoomSession(session) &&
        !this.tm.groupChat.isGroupSession(session);
      if (ackOwed)
        this.tm.ackObligations.recordAckObligationSend(session, acceptedAtMs);
      const ackGuardHandle = this.tm.ackObligations.armSendGuard(
        session,
        acceptedAtMs,
        ackOwed,
      ) as SendAckGuard & { [Symbol.dispose]?(): void };
      ackGuard = ackGuardHandle;
      const traceContextValue = trace?.context;
      const acceptTraceContext =
        traceContextValue != null &&
        typeof traceContextValue === "object" &&
        "withName" in traceContextValue &&
        typeof traceContextValue.withName === "function"
          ? (traceContextValue as SendAcceptanceTraceContext)
          : undefined;
      emitAcceptedSendEchoes({
        tm: this.tm,
        session,
        echoEntries: echoes,
        isAddressedChatOnScreen: isOnScreen,
        directAddressedAcceptance: settings.directAddressedAcceptance === true,
        ...(settings.clientNonce == null
          ? {}
          : { clientNonce: settings.clientNonce }),
        ...(acceptTraceContext == null
          ? {}
          : { traceCtx: acceptTraceContext }),
        ...(trace == null ? {} : { trace }),
        acceptedDurably: durable,
        durableAppendStartEpochMs,
        durableAppendStartPerfMs,
        hostReceiptEpochMs,
        hostReceiptPerfMs,
      });
      if (rosterDirty) await this.tm.roster.emitAgentUpdate(session.id);
      if (this.tm.roster.outlineAgentId === session.id) {
        this.tm.roster.streamingAssistantOutlineId = undefined;
        this.tm.roster.streamingThinkingOutlineId = undefined;
        if (cleanPrompt.length > 0) {
          this.tm.roster.appendOutlineItem({
            kind: "user",
            id: crypto.randomUUID(),
            text: cleanPrompt,
            timestampMs: Date.now(),
          });
        }
      }
      const {
        imageAttachmentPaths: imagePaths,
        videoAttachmentPaths: videoPaths,
        fileAttachmentPaths: filePaths,
      } = splitAttachmentPathsByChannel(attachmentPaths);
      const imageInputs =
        await loadSelectedImageInputs(imagePaths);
      const videoInputs = buildSelectedVideos(videoPaths);
      if (
        this.tm.groupChat.isRemoteRoomSession(session) ||
        this.tm.groupChat.isGroupSession(session)
      ) {
        await dispatchMirrorOrGroupSend(this.tm, {
          session,
          trimmedPrompt: cleanPrompt,
          selectedImages: imageInputs,
          videoAttachmentPaths: videoInputs,
          fileAttachmentPaths: filePaths,
          clientNonce: settings.clientNonce,
          userMessageId: messageEntryId,
          awaitTurn,
          acceptedAtMs,
          traceCtx: trace?.context,
          readAddressedTranscript: readTranscript,
          nextTurnEpoch: (target: LiveTranscriptSession) =>
            this.nextTurnEpoch(target),
          markSendAccepted: (nonceValue?: string) => this.markSendAccepted(nonceValue),
        });
        return;
      }
      await dispatchUserTurn({
        tm: this.tm,
        session,
        trimmedPrompt: cleanPrompt,
        ...(settings.richText == null ? {} : { richText: settings.richText }),
        ...(settings.composedAtMs == null
          ? {}
          : { composedAtMs: settings.composedAtMs }),
        ...(settings.enterEpochMs == null
          ? {}
          : { enterEpochMs: settings.enterEpochMs }),
        ...(settings.clientNonce == null
          ? {}
          : { clientNonce: settings.clientNonce }),
        awaitTurn,
        isFork: threadingInfo.isFork,
        ...(messageEntryId == null ? {} : { userMessageId: messageEntryId }),
        ...(threadingInfo.replyContext == null
          ? {}
          : { replyContext: threadingInfo.replyContext }),
        selectedImages: imageInputs,
        selectedVideos: videoInputs,
        fileAttachmentPaths: filePaths,
        attachedFileSizes: fileSizes,
        ...(trace?.context == null ? {} : { traceCtx: trace.context }),
        acceptedAtMs,
        wasInFlight: wasRunning,
        readAddressedTranscript: readTranscript,
        latestRecoverySends: this.latestRecoverySends,
        recoveryBreakEpochs: this.recoveryBreakEpochs,
        nextTurnEpoch: (target) => this.nextTurnEpoch(target),
        markSendAccepted: (nonceValue) => this.markSendAccepted(nonceValue),
        ackGuard: ackGuardHandle,
      });
    } finally {
      try {
        ackGuard?.[Symbol.dispose]?.();
      } catch {}
      if (pinnedConversation != null)
        this.tm.runLifecycle.endSessionRun(pinnedConversation);
      try {
        trace?.span.end();
      } catch {}
    }
  }

  markSendAccepted(clientNonce?: string): void {
    if (clientNonce)
      this.tm.acceptanceLedger.markAccepted({
        accountSlot: HOST_ACCOUNT_SLOT,
        clientNonce,
      });
  }

  nextTurnEpoch(session: { id: string }): number {
    const nextEpoch = (this.turnEpochs.get(session.id) ?? 0) + 1;
    this.turnEpochs.set(session.id, nextEpoch);
    return nextEpoch;
  }

  currentTurnEpoch(session: { id: string }): number {
    return this.turnEpochs.get(session.id) ?? 0;
  }

  claimSendAttachmentBatchId(sessionId: string): string {
    const existingBatch = this.sendAttachmentBatchIds.get(sessionId);
    if (existingBatch != null) return existingBatch;
    const batchValue = crypto.randomUUID();
    this.sendAttachmentBatchIds.set(sessionId, batchValue);
    return batchValue;
  }

  appendSendMessageEntry(entry: TranscriptEntry): void {
    this.boxRequests.trackBoxRequestEntry(entry);
    this.tm.appendEntry(entry);
  }

  resolveBoxRequestEntry(
    agentId: string,
    requestId: string,
    resolution: string,
  ): Promise<void> {
    return this.boxRequests.resolveBoxRequestEntry(
      agentId,
      requestId,
      resolution,
    );
  }

  validateAiReplyTarget(
    incomingMessage: SendMessage,
    inFlightId: string,
    entries: readonly TranscriptEntry[],
  ): SendMessage {
    return validateAiReplyTarget(incomingMessage, inFlightId, entries);
  }

  applyAutoReplyThread(
    incomingMessage: SendMessage,
    session: LiveTranscriptSession | null,
    entries: readonly TranscriptEntry[],
  ): SendMessage {
    return applyAutoReplyThread(
      { turnRuntime: this.tm.turnRuntime },
      incomingMessage,
      session,
      entries,
    );
  }

  async resolveDevSendMessage(incomingMessage: SendMessage): Promise<SendMessage> {
    if (incomingMessage.type !== "attachment" || typeof incomingMessage.url !== "string")
      return incomingMessage;
    const filePath = filePathFromFileUrl(incomingMessage.url);
    const session = this.tm.sessions.activeSession as
      LiveTranscriptSession | undefined;
    if (filePath == null || session == null) return incomingMessage;
    try {
      const storedPath =
        await this.tm.createAttachmentIngestor(session)(filePath);
      const baseName = basename(filePath);
      const finalFileName =
        baseName.length > 0 ? baseName : incomingMessage.file_name;
      return {
        type: "attachment",
        url: pathToFileURL(storedPath).href,
        ...(incomingMessage.reply_to == null ? {} : { reply_to: incomingMessage.reply_to }),
        ...(finalFileName == null ? {} : { file_name: finalFileName }),
        ...(incomingMessage.alt == null ? {} : { alt: incomingMessage.alt }),
        ...(incomingMessage.channel == null ? {} : { channel: incomingMessage.channel }),
        ...(incomingMessage.width == null ? {} : { width: incomingMessage.width }),
        ...(incomingMessage.height == null ? {} : { height: incomingMessage.height }),
      };
    } catch {
      return incomingMessage;
    }
  }

  async devAppendSendMessage(incomingMessage: SendMessage): Promise<void> {
    const resolved = await this.resolveDevSendMessage(incomingMessage);
    this.appendSendMessageEntry(
      createSendMessageEntry(
        nextEntryId(getTranscript(), "send-message"),
        resolved,
        Date.now(),
      ),
    );
  }

  async appendConnectorCard(input: {
    agentId?: string;
    connector: string;
    variant: string;
    reason?: string;
  }): Promise<void> {
    await this.tm.sessions.ensureActionTarget(input.agentId);
    const incomingMessage: SendMessage = {
      type: "connector",
      connector: input.connector,
      variant: input.variant,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    this.appendSendMessageEntry(
      createSendMessageEntry(
        nextEntryId(getTranscript(), "send-message"),
        incomingMessage,
        Date.now(),
      ),
    );
  }
}

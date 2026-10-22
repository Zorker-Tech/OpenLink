/** Whether a message that was sent is accepted, and where it came from.

 * The transcript a message was appended to decides what an accepted send looks like — the entry it produced, the turn it
 * belongs to — and the paths a caller may name a workspace by are read from what the platform keeps. */
import { dirname } from "node:path";
import {
  getSlateProfilePath,
  readSlateProfileFile,
  writeSlateProfileFile,
} from "../agents/agent-profile.ts";
import {
  SLATE_DEFAULT_AGENT_NAME,
  isSlateDefaultAgentName,
} from "../../shared/agents/agents.ts";
import { raisesUserActivity } from "../../shared/transcript.ts";
import { SlateSendNotPersistedError } from "./send-not-persisted-error.ts";
import { getTranscript } from "./transcript-store.ts";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.ts";

export interface SendAcceptanceTraceContext {
  withName(name: string): unknown;
}

export interface SendAcceptanceTrace {
  readonly span: { setAttribute(key: string, value: unknown): void };
}

export type CompletedSpanRecorder = (
  context: unknown,
  options: {
    readonly startTime: Date;
    readonly attributes: Readonly<Record<string, unknown>>;
  },
  endTime: Date,
) => void;

let completedSpanRecorder: CompletedSpanRecorder | undefined;

/** Supplies the bundle-scope tracing helper without inventing an SDK dependency. */
export function setSendAcceptanceCompletedSpanRecorder(
  recorder: CompletedSpanRecorder | undefined,
): void {
  completedSpanRecorder = recorder;
}

export function appendAddressedEcho(
  tm: TranscriptManagerLike,
  session: any,
  isAddressedChatOnScreen: () => boolean,
  buildEntry: (entries: readonly TranscriptEntry[]) => TranscriptEntry,
  appendOptions: { onPersistOutcome(value: boolean): void },
): { entry: TranscriptEntry; isOnActiveTranscript: boolean } {
  if (isAddressedChatOnScreen()) {
    const entry = tm.appendEntry(buildEntry(getTranscript()), {
      persistBeforeEmit: true,
      deferEmit: true,
      onPersistOutcome: appendOptions.onPersistOutcome,
    });
    return { entry, isOnActiveTranscript: true };
  }
  const entry = buildEntry(session.db.getTranscriptEntries());
  const durable = session.db.appendTranscriptEntry(entry);
  appendOptions.onPersistOutcome(durable);
  if (!durable) throw new SlateSendNotPersistedError();
  if (raisesUserActivity(entry))
    tm.sessionStore.markSessionActivity(session);
  return { entry, isOnActiveTranscript: false };
}

export function applySendRosterSideEffects(
  tm: TranscriptManagerLike,
  session: any,
  trimmedPrompt: string,
  readAddressedTranscript: () => readonly TranscriptEntry[],
): boolean {
  let needsRosterRefresh = false;
  const profilePath = getSlateProfilePath(dirname(session.dbPath));
  const currentProfile = readSlateProfileFile(profilePath);
  const effectiveName =
    currentProfile != null && currentProfile.name.trim().length > 0
      ? currentProfile.name
      : SLATE_DEFAULT_AGENT_NAME;
  if (
    readAddressedTranscript().length === 0 &&
    isSlateDefaultAgentName(effectiveName)
  ) {
    const trimmedSeed =
      trimmedPrompt.length > 0 ? trimmedPrompt : "New conversation";
    const seededName = trimmedSeed.replace(/\s+/g, " ").slice(0, 72);
    writeSlateProfileFile(profilePath, {
      name: seededName,
      description: currentProfile?.description ?? "",
      title: currentProfile?.title ?? "",
      avatarShape: currentProfile?.avatarShape ?? "",
      avatarColor: currentProfile?.avatarColor ?? "",
    });
    tm.roster.lastKnownAgentNames.set(session.id, seededName);
    needsRosterRefresh = true;
  }
  tm.trayErrors.clearForAgent(session.id);
  if (session.db.getAwaitingUserResponse() != null) {
    session.db.setAwaitingUserResponse(null);
    needsRosterRefresh = true;
  }
  return needsRosterRefresh;
}

export function emitAcceptedSendEchoes(args: {
  tm: TranscriptManagerLike;
  session: { id: string };
  echoEntries: readonly {
    entry: TranscriptEntry;
    isOnActiveTranscript: boolean;
  }[];
  isAddressedChatOnScreen(): boolean;
  directAddressedAcceptance: boolean;
  clientNonce?: string;
  traceCtx?: SendAcceptanceTraceContext;
  sendTrace?: SendAcceptanceTrace;
  acceptedDurably: boolean;
  durableAppendStartEpochMs: number;
  durableAppendStartPerfMs: number;
  hostReceiptEpochMs: number;
  hostReceiptPerfMs: number;
}): void {
  const onScreen = args.isAddressedChatOnScreen();
  let hasOffscreenEntries = false;
  for (const echo of args.echoEntries) {
    if (echo.isOnActiveTranscript && onScreen)
      args.tm.roster.emit({ type: "appended", entry: echo.entry });
    else {
      hasOffscreenEntries = true;
      if (args.directAddressedAcceptance)
        args.tm.roster.emit(
          { type: "appended", entry: echo.entry },
          args.session.id,
        );
    }
  }
  if (hasOffscreenEntries) {
    void args.tm.roster.emitAgentUpdate(args.session.id);
  }
  if (args.traceCtx !== undefined && completedSpanRecorder !== undefined) {
    try {
      const nonceAttributes =
        args.clientNonce != null && args.clientNonce.length > 0
          ? { "slate.client_nonce": args.clientNonce }
          : {};
      const durableAppendMs = Math.max(
        0,
        Math.round(performance.now() - args.durableAppendStartPerfMs),
      );
      completedSpanRecorder(
        args.traceCtx.withName("durable-append"),
        {
          startTime: new Date(args.durableAppendStartEpochMs),
          attributes: {
            "slate.durable_append_ms": durableAppendMs,
            "slate.durable": args.acceptedDurably,
            "slate.conversation_id": args.session.id,
            ...nonceAttributes,
          },
        },
        new Date(args.durableAppendStartEpochMs + durableAppendMs),
      );
      const ackEmitHostMs = Math.max(
        0,
        Math.round(performance.now() - args.hostReceiptPerfMs),
      );
      completedSpanRecorder(
        args.traceCtx.withName("send-ack-emit"),
        {
          startTime: new Date(args.hostReceiptEpochMs),
          attributes: {
            "slate.ack_emit_host_ms": ackEmitHostMs,
            "slate.conversation_id": args.session.id,
            ...nonceAttributes,
          },
        },
        new Date(args.hostReceiptEpochMs + ackEmitHostMs),
      );
      args.sendTrace?.span.setAttribute("slate.ack_emit_host_ms", ackEmitHostMs);
    } catch {}
  }
  if (hasOffscreenEntries) {
    console.warn(
      `[slate] send raced a chat switch away from ${args.session.id}: entries persisted to the addressed store off screen`,
    );
  }
}

/** Which message a sent one is threaded under.

 * The reply a caller asked for is resolved against the conversation it was addressed to, taken away when it points at
 * something that is not there any more, and filled in from the turn's own thread when the caller named none. */
import {
  stripReplyTo,
  withReplyTo,
  type SendMessage,
} from "./send-message-shaping.ts";
import type { TranscriptEntry } from "./transcript-hub.ts";

interface SendReplyRuntime {
  readonly turnRuntime: {
    resolveReplyTarget(entries: readonly TranscriptEntry[], id: string): string | undefined;
    buildReplyContext(entries: readonly TranscriptEntry[], id?: string): unknown;
  };
}

interface AutoThreadRuntime {
  readonly turnRuntime: { readonly replyThreadTargets: ReadonlyMap<object, string> };
}

function transcriptContains(entries: readonly TranscriptEntry[], targetId: string): boolean {
  return entries.some(entry => entry.id === targetId);
}

export function resolveSendReplyThreading(
  tm: SendReplyRuntime,
  replyToIdOption: string | undefined,
  isForkOption: boolean,
  readAddressedTranscript: () => readonly TranscriptEntry[],
): { replyToId?: string; replyContext: unknown; isFork: boolean } {
  const addressedEntries = replyToIdOption ? readAddressedTranscript() : [];
  const replyToId = replyToIdOption
    ? tm.turnRuntime.resolveReplyTarget(addressedEntries, replyToIdOption)
    : undefined;
  const replyContext = tm.turnRuntime.buildReplyContext(addressedEntries, replyToId);
  return {
    ...(replyToId == null ? {} : { replyToId }),
    replyContext,
    isFork: isForkOption && replyToId != null,
  };
}
export function validateAiReplyTarget<T extends SendMessage>(
  message: T,
  inFlightId: string | undefined,
  entries: readonly TranscriptEntry[],
): T {
  const target = message.reply_to;
  if (target == null || target.length === 0) return message;
  if (target === inFlightId || !transcriptContains(entries, target)) return stripReplyTo(message);
  return message;
}
export function applyAutoReplyThread<T extends SendMessage>(
  tm: AutoThreadRuntime,
  message: T,
  session: object | null,
  entries: readonly TranscriptEntry[],
): T {
  if (message.reply_to || session == null) return message;
  const target = tm.turnRuntime.replyThreadTargets.get(session);
  if (target == null || !transcriptContains(entries, target)) return message;
  return withReplyTo(message, target);
}

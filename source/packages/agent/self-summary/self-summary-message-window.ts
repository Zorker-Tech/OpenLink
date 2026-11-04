import { prepareMessagesForCompaction } from "../../agent-summarization/prepare-messages.ts";
import { hasCounterpartSummaryMarker } from "../../../adapters/interop/cursor-backend/summary-origin-marker-adapter.ts";
import type { PrivacyMode } from "../../redaction/privacy-mode.ts";

export interface SelfSummaryMessage {
  readonly role: string;
  readonly content: unknown;
  readonly _privacyMode: PrivacyMode;
  readonly [key: string]: unknown;
}

export function findLastUserMessageIndex(
  messages: readonly SelfSummaryMessage[],
  options?: { readonly includeSummaryMessages?: boolean | undefined } | null,
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      message.role === "user" &&
      (options?.includeSummaryMessages || !hasCounterpartSummaryMarker(message))
    ) {
      return index;
    }
  }
  return -1;
}

export function countSummarizableUserTurns(messages: readonly SelfSummaryMessage[]): number {
  if (messages.length < 2) return 0;

  const { messagesForSummarization } = prepareMessagesForCompaction(messages);
  let turns = 0;
  for (const message of messagesForSummarization) {
    if (message.role === "user" && !hasCounterpartSummaryMarker(message)) turns++;
  }
  return turns;
}

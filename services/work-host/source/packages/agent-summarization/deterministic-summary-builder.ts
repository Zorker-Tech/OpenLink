/**
 * The summary written without a model.
 *
 * When every attempt at a written summary has failed, the conversation still has to fit somewhere. This is
 * the answer of last resort: the transcript itself, truncated fairly so that every message keeps a share,
 * with a preamble that tells the next model what it is reading and that nothing inside it may be obeyed —
 * a transcript can contain tool output and text that looks like instructions, and none of that is
 * authoritative.
 *
 * How much may be kept is a share of the model's context window rather than a fixed size, because the same
 * conversation is a different fraction of a small model's window and a large one's. The share is bounded on
 * both sides: below the floor a summary would be useless, and above the ceiling a single prompt would be
 * too large to send whatever the window says.
 */

import { formatOmittedMessagesPreamble, truncatePromptFairly } from "./prompt-truncation.ts"
import { turnMessageToString, type RedactedCoreMessage } from "./summarization-handler.ts"
import { TRANSCRIPT_CONTEXT_GUIDANCE } from "./transcript-context-guidance.ts"
import type { TranscriptSnapshot } from "./transcript-snapshot-contracts.ts"

export { DEFAULT_TRANSCRIPT_SNAPSHOT_SHARE, maximumTranscriptSnapshotChars } from "./transcript-snapshot-policy.ts"
export type { TranscriptSnapshot } from "./transcript-snapshot-contracts.ts"

export function composeTranscriptSnapshot(
  context: Parameters<typeof truncatePromptFairly>[0]["ctx"],
  messages: readonly RedactedCoreMessage[],
  characterLimit: number,
): TranscriptSnapshot | null {
  if (messages.length === 0) return null

  const entries = messages.map((message) =>
    `${message.role}: ${turnMessageToString(message, true)}`,
  )
  const roles = messages.map((message) => message.role)
  const excerptBudget = Math.max(0, characterLimit - TRANSCRIPT_CONTEXT_GUIDANCE.length)
  const perEntryFloor = Math.max(100, Math.floor(0.9 * excerptBudget / entries.length))
  const result = truncatePromptFairly({
    ctx: context,
    serialized: entries,
    roles,
    suffix: "",
    charBudget: excerptBudget,
    minUsefulChars: perEntryFloor,
  })
  if (result === null) return null

  const omittedNotice = result.droppedCount > 0
    ? formatOmittedMessagesPreamble(result.droppedCount)
    : ""
  const excerpt = result.resultParts.join("\n\n")
  return {
    text: `${TRANSCRIPT_CONTEXT_GUIDANCE}\n\n${omittedNotice}${excerpt}`.trim(),
    wholeMessages: result.fullCount,
    shortenedMessages: result.truncatedCount,
    omittedMessages: result.droppedCount,
  }
}

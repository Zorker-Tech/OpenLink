/**
 * Noticing a turn that begins after a long run of user messages.
 *
 * The conversation normally alternates: the user speaks, the agent answers. A run of user messages with
 * no answer in between means the agent never replied — a failure that is otherwise invisible, since every
 * message is individually valid — so it is reported once with the shape of the tail: how many messages,
 * how far back the last answer was, and whether the same message ids appear more than once, which is what
 * tells a duplicated delivery from several real messages.
 *
 * Summaries and notifications are not the user speaking and are not counted.
 */

import type { Context } from "../../../context/context.ts"
import { createLogger } from "../../../context/logging.ts"
import { isSyntheticUserMessage } from "./synthetic-user-message.ts"

interface CursorProviderOptions {
  readonly isSummary?: boolean
  readonly messageId?: string
  readonly requestId?: string
}

interface Message {
  readonly role: string
  readonly content?: unknown
  readonly providerOptions?: { readonly cursor?: CursorProviderOptions }
}

const logger = createLogger("agent/user-message-run-warning")
const CONSECUTIVE_USER_MESSAGE_WARNING_THRESHOLD = 3
const TAIL_INSPECTION_WINDOW = 12

function extractCursorProviderOptions(message: Message): CursorProviderOptions | undefined {
  return message.providerOptions?.cursor
}

export function warnIfLongTrailingUserMessageRun(
  ctx: Context,
  messages: readonly Message[],
  invocationId: string,
): void {
  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role !== "user") return
  let trailingConsecutiveUserMessages = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== "user") break
    if (isSyntheticUserMessage(message)) continue
    trailingConsecutiveUserMessages += 1
  }
  if (trailingConsecutiveUserMessages <= CONSECUTIVE_USER_MESSAGE_WARNING_THRESHOLD) return
  let distanceToLastAssistant = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "assistant") {
      distanceToLastAssistant = messages.length - 1 - index
      break
    }
  }
  const tailMessages = messages.slice(-TAIL_INSPECTION_WINDOW)
  const tailRoles = tailMessages.map(message => message.role)
  const tailCursorMessageIds: string[] = []
  const tailCursorRequestIds: string[] = []
  for (const message of tailMessages) {
    const cursor = extractCursorProviderOptions(message)
    if (cursor?.messageId !== undefined) tailCursorMessageIds.push(cursor.messageId)
    if (cursor?.requestId !== undefined) tailCursorRequestIds.push(cursor.requestId)
  }
  const tailDistinctCursorMessageIdCount = new Set(tailCursorMessageIds).size
  const tailDistinctCursorRequestIdCount = new Set(tailCursorRequestIds).size
  logger.warn(ctx, "Turn contains unusually long trailing run of consecutive user messages", {
    trailingConsecutiveUserMessages,
    threshold: CONSECUTIVE_USER_MESSAGE_WARNING_THRESHOLD,
    totalMessages: messages.length,
    invocationId,
    distanceToLastAssistant,
    tailInspectionWindow: TAIL_INSPECTION_WINDOW,
    tailRoles,
    tailCursorMessageIdCount: tailCursorMessageIds.length,
    tailDistinctCursorMessageIdCount,
    hasDuplicateTailCursorMessageIds: tailDistinctCursorMessageIdCount < tailCursorMessageIds.length,
    tailCursorRequestIdCount: tailCursorRequestIds.length,
    tailDistinctCursorRequestIdCount,
    hasDuplicateTailCursorRequestIds: tailDistinctCursorRequestIdCount < tailCursorRequestIds.length,
  })
}

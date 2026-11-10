/** Runs the bounded set of earlier user turns that accompany a new message. */

export interface RecentMessageSelection<Message> {
  readonly retained: readonly Message[]
  readonly omittedCount: number
}

export function selectRecentPrependedMessages<Message>(
  messages: readonly Message[],
  maximum: number,
): RecentMessageSelection<Message> {
  const safeMaximum = Number.isFinite(maximum) ? Math.max(0, Math.trunc(maximum)) : 0
  const retained = safeMaximum === 0 ? [] : messages.slice(-safeMaximum)
  return { retained, omittedCount: messages.length - retained.length }
}

export interface PrependedTurnOptions {
  readonly additionalUserTurnSystemReminder: string | undefined
  readonly [key: string]: unknown
}

export interface PrependedTurnLogger {
  warn(event: string, fields: Readonly<Record<string, number>>): void
  info(event: string, fields: Readonly<Record<string, number | string | boolean>>): void
}

export interface PrependedUserTurnsInput<Context, WireMessage, UserMessage> {
  readonly context: Context
  readonly enabled: boolean
  readonly incoming: readonly WireMessage[] | undefined
  readonly maximum: number
  readonly reminder: string | undefined
  readonly turnOptions: Readonly<Record<string, unknown>>
  readonly logger: PrependedTurnLogger
  readonly decode: (message: WireMessage) => UserMessage
  readonly messageIdOf: (message: UserMessage) => string
  readonly existingMessageIds: (context: Context) => Promise<ReadonlySet<string>>
  readonly publish?: ((context: Context, message: WireMessage) => Promise<void>) | undefined
  readonly createTurn: (
    context: Context,
    message: UserMessage,
    options: PrependedTurnOptions,
  ) => Promise<unknown>
}

export interface PrependedUserTurnsResult {
  /** Number of candidates considered by this phase, including duplicates it skipped. */
  readonly candidateCount: number
  readonly omittedCount: number
  readonly createdCount: number
}

export async function appendPrependedUserTurns<Context, WireMessage, UserMessage>(
  input: PrependedUserTurnsInput<Context, WireMessage, UserMessage>,
): Promise<PrependedUserTurnsResult> {
  if (!input.enabled) return { candidateCount: 0, omittedCount: 0, createdCount: 0 }

  const selection = selectRecentPrependedMessages(input.incoming ?? [], input.maximum)
  const candidates = selection.retained
  if (selection.omittedCount > 0) {
    input.logger.warn("dropped excess prepended user messages", {
      droppedCount: selection.omittedCount,
      totalCount: (input.incoming ?? []).length,
      keptCount: candidates.length,
    })
  }
  if (candidates.length > 0) {
    input.logger.info("prepending user messages", { prependUserMessagesCount: candidates.length })
  }

  const priorIds = candidates.length > 0
    ? await input.existingMessageIds(input.context)
    : undefined
  let createdCount = 0
  for (const wireMessage of candidates) {
    const message = input.decode(wireMessage)
    const messageId = input.messageIdOf(message)
    const duplicate = messageId.length > 0 && priorIds?.has(messageId) === true
    if (duplicate) {
      input.logger.info("skipping duplicate prepended user message", {
        prependedMessageId: messageId,
        duplicateByMessageId: true,
      })
      continue
    }

    if (input.publish !== undefined) await input.publish(input.context, wireMessage)
    await input.createTurn(input.context, message, {
      additionalUserTurnSystemReminder: input.reminder,
      ...input.turnOptions,
    })
    createdCount += 1
  }

  return {
    candidateCount: candidates.length,
    omittedCount: selection.omittedCount,
    createdCount,
  }
}

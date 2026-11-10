import type {
  ConflictNoticeCommand,
  ConflictNoticeConversation,
  ConflictNoticeSyncRequest,
  Executor,
} from "./agent-store-conflict-notice-contracts.ts"

export function conflictNoticeSyncAndPeek(
  executor: Executor,
  context: unknown,
  args?: ConflictNoticeSyncRequest | null,
  options?: unknown,
): Promise<unknown> {
  const request: ConflictNoticeCommand = {
    op: "syncAndPeek",
    ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
    ...(args?.writtenPaths !== undefined ? { writtenPaths: args.writtenPaths } : {}),
    ...(args?.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args?.eager === true ? { eager: true } : {}),
  }
  return executor.execute(context, request, options)
}

export function conflictNoticePeek(
  executor: Executor,
  context: unknown,
  args?: ConflictNoticeConversation | null,
  options?: unknown,
): Promise<unknown> {
  const request: ConflictNoticeCommand = {
    op: "peek",
    ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
  }
  return executor.execute(context, request, options)
}

export async function conflictNoticeAck(
  executor: Executor,
  context: unknown,
  eventIds: readonly string[],
  args?: ConflictNoticeConversation | null,
  options?: unknown,
): Promise<void> {
  if (eventIds.length === 0) return
  const request: ConflictNoticeCommand = {
    op: "ack",
    eventIds,
    ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
  }
  await executor.execute(context, request, options)
}

export async function conflictNoticeRelease(
  executor: Executor,
  context: unknown,
  eventIds: readonly string[],
  args?: ConflictNoticeConversation | null,
  options?: unknown,
): Promise<void> {
  if (eventIds.length === 0) return
  const request: ConflictNoticeCommand = {
    op: "release",
    eventIds,
    ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
  }
  await executor.execute(context, request, options)
}

export async function conflictNoticeNoteDeferredEagerWrittenPaths(
  executor: Executor,
  context: unknown,
  writtenPaths: readonly string[],
  args?: ConflictNoticeConversation | null,
  options?: unknown,
): Promise<void> {
  if (writtenPaths.length === 0) return
  const request: ConflictNoticeCommand = {
    op: "noteDeferredEagerWrittenPaths",
    writtenPaths,
    ...(args?.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
  }
  await executor.execute(context, request, options)
}

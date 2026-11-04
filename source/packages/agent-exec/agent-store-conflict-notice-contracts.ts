export interface Executor<Args = unknown, Result = unknown, Context = unknown, Options = unknown> {
  execute(context: Context, args: Args, options?: Options): Promise<Result>
}

export interface ConflictNoticeConversation {
  readonly conversationId?: string
}

export interface ConflictNoticeSyncRequest extends ConflictNoticeConversation {
  readonly writtenPaths?: readonly string[]
  readonly timeoutMs?: number
  readonly eager?: boolean
}

export type ConflictNoticeCommand =
  | ({ readonly op: "syncAndPeek" } & ConflictNoticeSyncRequest)
  | ({ readonly op: "peek" } & ConflictNoticeConversation)
  | ({ readonly op: "ack"; readonly eventIds: readonly string[] } & ConflictNoticeConversation)
  | ({ readonly op: "release"; readonly eventIds: readonly string[] } & ConflictNoticeConversation)
  | ({ readonly op: "noteDeferredEagerWrittenPaths"; readonly writtenPaths: readonly string[] } & ConflictNoticeConversation)

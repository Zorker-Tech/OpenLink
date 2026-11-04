/** Adapts generated conversation, user-message and read-executor records to the Slate shell-watch contract. */

import { ConversationStateStructure, UserMessage } from "../proto/generated/agent/v1/agent_pb.ts"
import { ReadArgs, type ReadResult } from "../proto/generated/agent/v1/read_exec_pb.ts"
import { readExecutorResource } from "../../../packages/agent-exec/read-operation.ts"
import type { BlobStore } from "../../../packages/agent-kv/blob-store.ts"
import { collectPrependUserMessageRecords } from "../../../host/runner/shell-terminal-watch.ts"
import { slateConversationTurnSerde } from "./agent-conversation-state-serdes-adapter.ts"
import type {
  MaterializedUserMessage,
  RecentTerminalUserMessage,
  ShellTerminalWatchHost,
  TerminalReadResult,
  TerminalRemoteAccessor,
} from "../../../host/runner/shell-terminal-watch.ts"

interface GeneratedReadAccessor<Context> {
  get(resource: typeof readExecutorResource): {
    execute(context: Context, args: ReadArgs, options?: unknown): Promise<ReadResult>
  }
}

export interface ShellWatchGeneratedStateOwner<Context = unknown> {
  getConversationState(): ConversationStateStructure
  getBlobStore(): BlobStore<Context>
}

function readResultForSlate(result: ReadResult): TerminalReadResult {
  switch (result.result.case) {
    case "success": {
      const output = result.result.value.output
      if (output.case === "content") return { kind: "success", text: output.value }
      if (output.case === "data") return { kind: "success", bytes: output.value }
      return { kind: "success" }
    }
    case "fileNotFound": return { kind: "missing" }
    default: return { kind: "failure", resultName: result.result.case ?? "unknown" }
  }
}

/** Builds the shell watch's own file-read port over a remote generated executor. */
export function createShellWatchReadAccessor<Context>(reads: unknown): TerminalRemoteAccessor<Context> {
  return {
    async read(turnContext, args) {
      const generatedAccessor = reads as GeneratedReadAccessor<Context>
      const result = await generatedAccessor.get(readExecutorResource).execute(
        turnContext,
        new ReadArgs({ path: args.path, toolCallId: args.toolCallId }),
      )
      return readResultForSlate(result)
    },
  }
}

/** Projects a generated conversation checkpoint and blob store into the shell watch's read-only state view. */
export function createShellWatchGeneratedStateProjection<Context>(
  stateOwner: ShellWatchGeneratedStateOwner<Context>,
): Pick<ShellTerminalWatchHost<Context>, "getConversationState" | "getBlob" | "decodeConversationTurn" | "decodeUserMessage"> {
  return {
    getConversationState: () => stateOwner.getConversationState(),
    getBlob: async (turnContext, blobRef) => (await stateOwner.getBlobStore().getBlob(turnContext, blobRef)) ?? null,
    decodeConversationTurn(rawBytes) {
      try {
        const turn = slateConversationTurnSerde.deserialize(rawBytes)
        return turn.kind === "agent"
          ? { kind: "agent", userMessageBlobId: turn.userMessageBlobId }
          : { kind: "other" }
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid ConversationTurnStructure: missing turn case") {
          return { kind: "other" }
        }
        throw error
      }
    },
    decodeUserMessage(rawBytes) {
      const userMessage = UserMessage.fromBinary(rawBytes)
      return { text: userMessage.text, messageId: userMessage.messageId }
    },
  }
}

/** Restores the generated message wrapper after Slate decides which prior user messages to prepend. */
export async function collectPrependUserMessages<Context>(
  shellHost: ShellTerminalWatchHost<Context>,
  recentMessages: readonly RecentTerminalUserMessage[] | null | undefined,
  currentMessageId?: string,
): Promise<UserMessage[]> {
  const records: readonly MaterializedUserMessage[] = await collectPrependUserMessageRecords(shellHost, recentMessages, currentMessageId)
  return records.map(record => new UserMessage({
    text: record.text,
    messageId: record.messageId,
    ...(record.richText === undefined ? {} : { richText: record.richText }),
  }))
}

import type { Context } from "../context/context.ts"
import { createLogger } from "../context/index.ts"
import type { SummaryRunOptions, SummarySplit, SummaryMessageLike } from "./pipeline-contracts.ts"

const logger = createLogger("summarization-pipeline")

type TailShape = {
  readonly roles: readonly string[]
  readonly firstRole: string
  readonly startsWithUser: boolean
  readonly laterUserIndex: number
}

function describeTail<TMessage extends SummaryMessageLike>(tail: readonly TMessage[]): TailShape | null {
  if (tail.length === 0) return null
  const firstRole = tail[0]!.role
  const laterUserIndex = tail.findIndex((message, index) => index > 0 && message.role === "user")
  return {
    roles: tail.map(message => message.role),
    firstRole,
    startsWithUser: firstRole === "user",
    laterUserIndex,
  }
}

/** Report a split that would make the next answer lose the request it is meant to address. */
export function reportInvalidSummaryTail<TMessage extends SummaryMessageLike>(
  context: Context,
  split: SummarySplit<TMessage>,
  options: SummaryRunOptions,
): void {
  const shape = describeTail(split.preservedTailMessages)
  if (shape === null || (shape.startsWithUser && shape.laterUserIndex === -1)) return

  logger.warn(context, "[summarization-pipeline] preservedTailMessages shape invariant violated", {
    summarization: {
      preservedTailLength: shape.roles.length,
      preservedTailRoles: shape.roles,
      headRole: shape.firstRole,
      headIsUser: shape.startsWithUser,
      laterUserIndex: shape.laterUserIndex,
      messagesToSummarizeLength: split.messagesToSummarize.length,
      fullSummarization: options.fullSummarization === true,
      backgroundSummarizationMode: options.backgroundSummarizationMode,
      triggerReason: options.triggerReason,
    },
  })
}

import type { Context } from "../context/context.ts"
import { reportInvalidSummaryTail } from "./pipeline-tail-validation.ts"
import type {
  SummaryCarryData,
  SummaryMessageLike,
  SummaryPassAdapter,
  SummaryRunOptions,
  SummarySplit,
} from "./pipeline-contracts.ts"

export type { SummaryCarryData, SummaryMessageLike, SummaryPassAdapter, SummaryRunOptions, SummarySplit } from "./pipeline-contracts.ts"

function carryDataFor<TMessage extends SummaryMessageLike>(split: SummarySplit<TMessage>, options: SummaryRunOptions): SummaryCarryData {
  return {
    skillBlocks: split.skillBlocks,
    todoContent: options.todoContent,
    currentPlan: options.currentPlan,
    modePrompt: options.modePrompt,
    projectRootPrompt: options.projectRootPrompt,
    automationTriggerContext: options.automationTriggerContext,
    agentTranscriptsFolder: options.agentTranscriptsFolder,
    conversationId: options.conversationId,
  }
}

/** Execute the shared compaction stages while leaving split, generation and replacement policy with each adapter. */
export async function runSummaryPass<
  TMessage extends SummaryMessageLike,
  TRawSummary,
  TBuiltMessage extends TMessage,
>(
  adapter: SummaryPassAdapter<TMessage, TRawSummary, TBuiltMessage>,
  context: Context,
  messages: readonly TMessage[],
  options: SummaryRunOptions,
): Promise<{
  messagesActuallySummarized: readonly TMessage[]
  newSummaryMessage: TBuiltMessage
  preservedOriginalTailMessages: readonly TMessage[]
  fullReplacementMessages: readonly TMessage[]
  rawSummary: TRawSummary
  summaryTextLength: number
}> {
  const split = adapter.separateMessages(messages, options)
  reportInvalidSummaryTail(context, split, options)
  const carryData = carryDataFor(split, options)
  const rawSummary = await adapter.generateSummary(context, split, options)
  const carrier = adapter.formatSummaryCarrier(rawSummary, split, carryData)
  const replacement = adapter.rebuildConversation(split, carrier.message)

  return {
    messagesActuallySummarized: split.messagesToSummarize,
    newSummaryMessage: carrier.message,
    preservedOriginalTailMessages: split.preservedTailMessages,
    fullReplacementMessages: replacement,
    rawSummary,
    summaryTextLength: carrier.summaryTextLength,
  }
}

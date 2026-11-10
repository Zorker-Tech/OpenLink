import type { Context } from "../context/context.ts"

export interface SummaryMessageLike {
  readonly role: string
  readonly [key: string]: unknown
}

export interface SummarySplit<TMessage extends SummaryMessageLike> {
  readonly messagesToSummarize: readonly TMessage[]
  readonly preservedTailMessages: readonly TMessage[]
  readonly skillBlocks: readonly string[]
}

export interface SummaryRunOptions {
  readonly fullSummarization?: boolean | undefined
  readonly backgroundSummarizationMode?: unknown
  readonly triggerReason?: unknown
  readonly todoContent?: unknown
  readonly currentPlan?: unknown
  readonly modePrompt?: unknown
  readonly projectRootPrompt?: unknown
  readonly automationTriggerContext?: unknown
  readonly agentTranscriptsFolder?: unknown
  readonly conversationId?: unknown
  readonly [key: string]: unknown
}

export interface SummaryCarryData {
  readonly skillBlocks: readonly string[]
  readonly todoContent: unknown
  readonly currentPlan: unknown
  readonly modePrompt: unknown
  readonly projectRootPrompt: unknown
  readonly automationTriggerContext: unknown
  readonly agentTranscriptsFolder: unknown
  readonly conversationId: unknown
}

export interface SummaryPassAdapter<
  TMessage extends SummaryMessageLike,
  TRawSummary,
  TBuiltMessage extends TMessage,
> {
  separateMessages(messages: readonly TMessage[], options: SummaryRunOptions): SummarySplit<TMessage>
  generateSummary(context: Context, partition: SummarySplit<TMessage>, options: SummaryRunOptions): Promise<TRawSummary> | TRawSummary
  formatSummaryCarrier(
    rawSummary: TRawSummary,
    partition: SummarySplit<TMessage>,
    carryData: SummaryCarryData,
  ): { readonly message: TBuiltMessage; readonly summaryTextLength: number }
  rebuildConversation(partition: SummarySplit<TMessage>, message: TBuiltMessage): readonly TMessage[]
}

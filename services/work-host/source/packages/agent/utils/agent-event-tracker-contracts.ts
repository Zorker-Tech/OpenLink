import type { Context } from "../../context/context.ts"

export interface SkillAppliedEvent {
  readonly skillId: string
  readonly skillSource: string
  readonly entrypoint: string
  readonly plugin?: string | undefined
  readonly marketplace?: string | undefined
  readonly pluginId?: string | undefined
  readonly marketplaceId?: string | undefined
}

export interface AgentEventTracker {
  trackUnfinishedTodos(...args: unknown[]): void
  trackUnfinishedTodosWhenCreatedTodos(...args: unknown[]): void
  trackUnfinishedTodosWhenHadUnfinishedTodosAtStart(...args: unknown[]): void
  trackSummarizationTriggered(...args: unknown[]): void
  trackSummarizationPersistedForQualityGrading?(...args: unknown[]): void
  trackPromptTokens(...args: unknown[]): void
  trackNumberOfToolCalls(...args: unknown[]): void
  trackToolCallStarted(...args: unknown[]): void
  trackToolCallResult(...args: unknown[]): void
  trackComputerUseExecution(...args: unknown[]): void
  trackLoopDetected(...args: unknown[]): void
  trackSubagentCreated(...args: unknown[]): void
  trackSubagentCompleted(...args: unknown[]): void
  trackShellSandboxResult(...args: unknown[]): void
  trackSkillUsed(...args: unknown[]): void
  trackSkillApplied(context: Context, event: SkillAppliedEvent): void
  trackHookExecuted(...args: unknown[]): void
  trackSmartModeClassifierCall(...args: unknown[]): void
  trackPlanModeModelFinished(...args: unknown[]): void
  trackMcpToolCall(...args: unknown[]): void
  trackMcpToolCallResult(...args: unknown[]): void
}

export interface RecordSkillAppliedInput extends SkillAppliedEvent {
  readonly stateHandler?: {
    readonly lastSkillCatalogBudgetStrategy?: string
  }
}

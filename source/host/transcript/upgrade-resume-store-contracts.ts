export interface UpgradeResumeMarker {
  readonly agentId: string
  readonly markedAtMs: number
  readonly source?: string
  readonly automationId?: string
  readonly automationRunId?: string
}

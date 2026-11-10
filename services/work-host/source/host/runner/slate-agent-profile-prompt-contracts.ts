export interface AgentProfileIdentity {
  readonly name: string
  readonly description: string
}

export interface AgentProfilePromptSnapshot {
  readonly version: 1
  readonly profileSection: string
  readonly systemIdentity: AgentProfileIdentity
  readonly announcedIdentity: AgentProfileIdentity
  readonly compactionEpoch: number
}

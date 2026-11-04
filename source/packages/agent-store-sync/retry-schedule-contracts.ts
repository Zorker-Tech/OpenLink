export interface AgentStoreRetryConfiguration {
  readonly initialDelayMs: number
  readonly maximumDelayMs: number
  readonly growthFactor?: number
  readonly jitterFraction?: number
  readonly randomSample?: () => number
}

export interface ResolvedAgentStoreRetryConfiguration {
  readonly initialDelayMs: number
  readonly maximumDelayMs: number
  readonly growthFactor: number
  readonly jitterFraction: number
  readonly randomSample: () => number
}

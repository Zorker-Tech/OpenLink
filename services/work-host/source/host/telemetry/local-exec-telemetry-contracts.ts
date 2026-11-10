export type LocalExecRefusalCause = "no_providers" | "stale_heartbeat" | "computer_unknown"

export interface LocalExecRefusalReport {
  cause: LocalExecRefusalCause
  site: string
  conversationId: string
  providerCount: number
  liveProviderCount: number
  everRegistered: boolean
  emptyForMs?: number
}

export interface LocalExecFailureReport {
  errorClass: string
  errno?: string
  site: string
  conversationId: string
}

export type LocalExecProviderReport =
  | {
      phase: "hello"
      providerId: string
      providerCount: number
      helloDelayMs: number
      computerIdPresent: boolean
      rehello: boolean
      supervised?: boolean
      variant?: string
    }
  | {
      phase: "detached"
      providerId: string
      providerCount: number
      ageMs: number
      hadHello: boolean
      hasHeartbeat: boolean
      wasLive: boolean
      emptied: boolean
    }

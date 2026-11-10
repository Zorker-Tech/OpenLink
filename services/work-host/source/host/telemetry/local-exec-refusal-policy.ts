import type { LocalExecRefusalCause } from "./local-exec-telemetry-contracts.ts"

export interface LocalExecErrorDefinition {
  readonly code: string
  readonly domain: "transport"
  readonly retryable: true
}

const REFUSAL_ERRORS: Record<LocalExecRefusalCause, LocalExecErrorDefinition> = {
  no_providers: { code: "SLATE-E0111", domain: "transport", retryable: true },
  stale_heartbeat: { code: "SLATE-E0112", domain: "transport", retryable: true },
  computer_unknown: { code: "SLATE-E0113", domain: "transport", retryable: true },
}

export function describeLocalExecRefusal(cause: LocalExecRefusalCause): LocalExecErrorDefinition {
  return REFUSAL_ERRORS[cause]
}

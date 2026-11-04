import type { Clock, RetryPolicy } from "../extensions/scheduling.ts"
import type { InferenceCredential, RenewalResult } from "./credential-renewer.ts"

export interface HostAuthServiceOptions {
  readonly retry: RetryPolicy
  readonly clock: Clock
  readonly log: (message: string) => void
  readonly env?: NodeJS.ProcessEnv
  readonly backendUrl?: string
  readonly renewCredential?: (backendUrl: string, credential: string) => Promise<InferenceCredential>
  readonly readDevCredential?: (path: string) => Promise<InferenceCredential>
  readonly getMachineId?: () => Promise<string>
}

export interface HostAuthRenewalEvent extends RenewalResult {
  readonly isFirstCredential: boolean
}

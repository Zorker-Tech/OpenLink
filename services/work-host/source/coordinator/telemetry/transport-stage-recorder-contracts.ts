import type { Clock } from "../../host/extensions/scheduling.ts"

export interface TransportIdentity {
  readonly accountSlot: string
  readonly clientNonce?: string | null
  readonly traceparent?: string | null
}

export interface TransportStageReport {
  readonly accountSlot: string
  readonly clientNonce: string
  readonly stage: string
  readonly attempt: number
  readonly traceparent: string | null
  readonly startEpochMs: number
  readonly durationMs: number
  readonly isError: boolean
}

export interface TransportStageEgress {
  reportTransportStage(report: TransportStageReport): Promise<unknown>
  reportGatewayCommandSpan(report: unknown): Promise<unknown>
  reportGatewayReachability(report: unknown): Promise<unknown>
  reportGatewayDnsDiagnostic(report: unknown): Promise<unknown>
}

export interface StageTrace {
  beginStage(stage: string, attempt: number): { complete(): void; fail(): void }
  markStage(stage: string, attempt: number): void
}

export type TransportStageRecorderOptions = { readonly clock: Clock; readonly egress: TransportStageEgress }

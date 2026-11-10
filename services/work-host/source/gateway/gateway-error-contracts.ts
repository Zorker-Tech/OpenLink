export type GatewayFailureReason =
  | "daemon_refused"
  | "daemon_timeout"
  | "daemon_crash"
  | "no_monitor"
  | "refused"
  | "dns"
  | "timeout"
  | "network"
  | "application"

export interface GatewayFailureClassification {
  readonly reason: GatewayFailureReason
  readonly errorClass: string
  readonly errno: string | undefined
}

interface GatewayCommandTelemetryIds {
  readonly requestId?: string
  readonly traceId?: string
  readonly spanId?: string
}

export interface GatewayCommandFailureReport extends GatewayCommandTelemetryIds {
  readonly method: string
  readonly reason: string
  readonly errorClass: string
  readonly errno?: string
  readonly durationMs: number
}

export interface GatewayCommandSuccessReport extends GatewayCommandTelemetryIds {
  readonly method: string
  readonly durationMs: number
}

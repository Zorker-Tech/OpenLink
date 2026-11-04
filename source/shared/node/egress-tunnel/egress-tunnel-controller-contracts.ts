import type { TunnelConfig } from "./box-connection.ts"

export interface EgressTunnelStatus {
  readonly state: string
  readonly relayedStreams: number
  readonly activeStreams: number
  readonly [key: string]: unknown
}

export interface EgressTunnelClient {
  start(): void
  stop(): void
}

export interface EgressTunnelControllerOptions {
  readonly onStatus: (status: EgressTunnelStatus) => void
  readonly createClient: (options: {
    readonly config: TunnelConfig
    readonly onStatus: (status: EgressTunnelStatus) => void
    readonly log: (...values: unknown[]) => void
  }) => EgressTunnelClient
  readonly log?: (...values: unknown[]) => void
  readonly env?: NodeJS.ProcessEnv
}

export const OFF_STATUS: EgressTunnelStatus = {
  state: "off",
  relayedStreams: 0,
  activeStreams: 0,
}

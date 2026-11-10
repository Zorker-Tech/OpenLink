/**
 * Owns the desired and active lifecycle of one host egress tunnel.
 */
import type { TunnelConfig } from "./box-connection.ts"
import { configsEqual, desiredTunnelConfig } from "./egress-tunnel-config.ts"
import {
  OFF_STATUS,
  type EgressTunnelClient,
  type EgressTunnelControllerOptions,
  type EgressTunnelStatus,
} from "./egress-tunnel-controller-contracts.ts"

export {
  ANYRUN_NETWORK_TOKEN_HEADER,
  configFromEnv,
  configsEqual,
} from "./egress-tunnel-config.ts"
export {
  OFF_STATUS,
  type EgressTunnelClient,
  type EgressTunnelControllerOptions,
  type EgressTunnelStatus,
} from "./egress-tunnel-controller-contracts.ts"

export class EgressTunnelController {
  private enabled = false
  private boxConfig: TunnelConfig | null = null
  private activeConfig: TunnelConfig | null = null
  private client: EgressTunnelClient | null = null
  private lastStatus: EgressTunnelStatus = OFF_STATUS

  constructor(private readonly options: EgressTunnelControllerOptions) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.reconcile()
  }

  setBoxConnection(config: TunnelConfig | null): void {
    this.boxConfig = config
    this.reconcile()
  }

  getStatus(): EgressTunnelStatus {
    return this.lastStatus
  }

  dispose(): void {
    this.enabled = false
    this.reconcile()
  }

  private reconcile(): void {
    const desired = desiredTunnelConfig(this.enabled, this.options.env, this.boxConfig)
    if (desired === null) {
      this.client?.stop()
      this.client = null
      this.activeConfig = null
      this.publish(OFF_STATUS)
      return
    }
    if (this.client !== null && configsEqual(desired, this.activeConfig)) return

    this.client?.stop()
    this.activeConfig = desired
    this.client = this.options.createClient({
      config: desired,
      onStatus: status => this.publish(status),
      log: this.options.log ?? (() => undefined),
    })
    this.client.start()
  }

  private publish(status: EgressTunnelStatus): void {
    this.lastStatus = status
    this.options.onStatus(status)
  }
}

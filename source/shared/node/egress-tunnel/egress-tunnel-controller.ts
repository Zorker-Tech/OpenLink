/**
 * The tunnel that carries a box's egress through the host.
 *
 * A tunnel is opened, watched and closed, and what it reports is what a caller needs to know: whether it is up, how
 * many streams it is relaying and how many it could not.
 */
import type { TunnelConfig } from "./box-connection.ts";

export interface EgressTunnelStatus {
  readonly state: string;
  readonly relayedStreams: number;
  readonly activeStreams: number;
  readonly [key: string]: unknown;
}

export interface EgressTunnelClient {
  start(): void;
  stop(): void;
}

export const OFF_STATUS: EgressTunnelStatus = { state: "off", relayedStreams: 0, activeStreams: 0 };
export const ANYRUN_NETWORK_TOKEN_HEADER = "x-slate-network-token";

export function configsEqual(a: TunnelConfig | null, b: TunnelConfig | null): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return a.url === b.url
    && a.bearer === b.bearer
    && a.allowPrivateTargets === b.allowPrivateTargets
    && JSON.stringify(a.headers ?? {}) === JSON.stringify(b.headers ?? {});
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TunnelConfig | null {
  const url = env.SLATE_EGRESS_TUNNEL_URL;
  const bearer = env.SLATE_EGRESS_TUNNEL_BEARER;
  if (url == null || url === "" || bearer == null || bearer === "") return null;
  const networkToken = env.SLATE_EGRESS_TUNNEL_NETWORK_TOKEN;
  return {
    url,
    bearer,
    ...(networkToken != null && networkToken !== ""
      ? { headers: { [ANYRUN_NETWORK_TOKEN_HEADER]: networkToken } }
      : {}),
    allowPrivateTargets: env.SLATE_EGRESS_TUNNEL_ALLOW_PRIVATE === "1",
  };
}

export class EgressTunnelController {
  private enabled = false;
  private boxConfig: TunnelConfig | null = null;
  private activeConfig: TunnelConfig | null = null;
  private client: EgressTunnelClient | null = null;
  private lastStatus: EgressTunnelStatus = OFF_STATUS;

  constructor(private readonly options: {
    readonly onStatus: (status: EgressTunnelStatus) => void;
    readonly createClient: (options: {
      readonly config: TunnelConfig;
      readonly onStatus: (status: EgressTunnelStatus) => void;
      readonly log: (...values: unknown[]) => void;
    }) => EgressTunnelClient;
    readonly log?: (...values: unknown[]) => void;
    readonly env?: NodeJS.ProcessEnv;
  }) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.reconcile();
  }

  setBoxConnection(config: TunnelConfig | null): void {
    this.boxConfig = config;
    this.reconcile();
  }

  getStatus(): EgressTunnelStatus {
    return this.lastStatus;
  }

  dispose(): void {
    this.enabled = false;
    this.reconcile();
  }

  private resolveConfig(): TunnelConfig | null {
    return configFromEnv(this.options.env) ?? this.boxConfig;
  }

  private reconcile(): void {
    const desired = this.enabled ? this.resolveConfig() : null;
    if (desired == null) {
      this.client?.stop();
      this.client = null;
      this.activeConfig = null;
      this.publish(OFF_STATUS);
      return;
    }
    if (this.client != null && configsEqual(desired, this.activeConfig)) return;
    this.client?.stop();
    this.activeConfig = desired;
    this.client = this.options.createClient({
      config: desired,
      onStatus: (status) => this.publish(status),
      log: this.options.log ?? (() => undefined),
    });
    this.client.start();
  }

  private publish(status: EgressTunnelStatus): void {
    this.lastStatus = status;
    this.options.onStatus(status);
  }
}

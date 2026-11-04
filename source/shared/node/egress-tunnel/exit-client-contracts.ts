import type { RetryPolicy } from "../../../host/extensions/scheduling.ts";
import type { TunnelConfig } from "./box-connection.ts";
import type { EgressTunnelStatus } from "./egress-tunnel-controller-contracts.ts";

export const KIND_OPEN = 1;
export const KIND_DATA = 2;
export const KIND_CLOSE = 3;
export const SOCKET_HIGH_WATER_MARK = 1 << 20;
export const RECONNECT_INITIAL_DELAY_MS = 2_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

export type EgressFrame =
  | { readonly kind: typeof KIND_OPEN; readonly streamId: number; readonly host: string; readonly port: number }
  | { readonly kind: typeof KIND_DATA; readonly streamId: number; readonly payload: Buffer }
  | { readonly kind: typeof KIND_CLOSE; readonly streamId: number };

export interface ExitWebSocket {
  readonly readyState: number;
  binaryType: string;
  readonly bufferedAmount: number;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  send(data: Buffer, callback?: () => void): void;
  close(): void;
  terminate(): void;
  removeAllListeners(): void;
}

export interface EgressTunnelExitClientOptions {
  readonly config: TunnelConfig;
  readonly onStatus: (status: EgressTunnelStatus) => void;
  readonly log?: (message: string) => void;
  readonly createWebSocket: (url: string, options: { headers: Record<string, string> }) => ExitWebSocket;
  readonly openReadyState?: number;
  readonly lookup?: typeof import("node:dns/promises").lookup;
  readonly createConnection?: typeof import("node:net").createConnection;
  readonly reconnectPolicy?: RetryPolicy;
}

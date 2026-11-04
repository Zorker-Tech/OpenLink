import WebSocketModule from "ws";

import type { ExitWebSocket } from "../../../shared/node/egress-tunnel/exit-client.ts";

export interface EgressWebSocketOptions {
  readonly headers: Record<string, string>;
}

export interface EgressWebSocketConstructor {
  new (url: string, options: EgressWebSocketOptions): ExitWebSocket;
  readonly OPEN: number;
}

const WebSocket = WebSocketModule as unknown as EgressWebSocketConstructor;

export const EGRESS_TUNNEL_OPEN_READY_STATE = WebSocket.OPEN;

export function constructEgressWebSocket(
  Constructor: EgressWebSocketConstructor,
  url: string,
  options: EgressWebSocketOptions,
): ExitWebSocket {
  return new Constructor(url, options);
}

export function createWebSocket(url: string, options: EgressWebSocketOptions): ExitWebSocket {
  return constructEgressWebSocket(WebSocket, url, options);
}

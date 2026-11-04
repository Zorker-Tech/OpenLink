import type { IncomingMessage, ServerResponse } from "node:http";

export class SlateGatewayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlateGatewayRequestError";
  }
}

export const GATEWAY_REQUEST_ID_HEADER = "x-slate-request-id";
export const SSE_HEARTBEAT_MS = 15_000;
export const MAX_REQUEST_PAYLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_BODY_BYTES = Math.ceil(MAX_REQUEST_PAYLOAD_BYTES * 4 / 3) + 64 * 1024;
export const GZIP_MIN_BYTES = 1_400;
export const DISABLE_SSE_GZIP_ENV = "SLATE_DISABLE_GATEWAY_SSE_GZIP";

export interface GatewayServerDeps {
  readonly api: {
    getAgentAvatar(...args: any[]): any;
    [name: string]: (...args: any[]) => any;
  };
  readonly subscribe: (listener: (event: any) => void) => () => void;
  readonly getHealth: () => Record<string, any>;
  readonly startedAt: number;
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly tls?: { cert: Buffer; key: Buffer };
  readonly prepareForUpgrade?: () => Promise<unknown>;
  readonly onCommandError?: (report: Record<string, unknown>) => void;
  readonly onCommandComplete?: (report: Record<string, unknown>) => void;
  readonly onEventStreamClosed?: () => void;
  readonly onDesktopContact?: () => void;
  readonly localExec?: {
    registerProvider(listener: (frame: unknown) => void): () => void;
    submitResponses(batch: unknown): void;
  };
  readonly webauthn?: {
    registerProvider(listener: (frame: unknown) => void): () => void;
    submitResponses(batch: unknown): void;
  };
}

export interface GatewayResponsePort extends Pick<ServerResponse, "destroyed" | "writableEnded" | "headersSent" | "writeHead" | "end" | "write" | "on"> {}
export interface GatewayRequestPort extends Pick<IncomingMessage, "headers"> {}

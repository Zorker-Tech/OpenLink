import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface CoordinatorLogger {
  warn(event: Record<string, unknown>): void;
}

export type McpOAuthLoopbackHandler = (
  requestUrl: URL,
  request: IncomingMessage,
  response: ServerResponse,
) => boolean | Promise<boolean>;

export interface OriginCallbacks {
  listeners: Server[];
  handlers: Set<McpOAuthLoopbackHandler>;
}

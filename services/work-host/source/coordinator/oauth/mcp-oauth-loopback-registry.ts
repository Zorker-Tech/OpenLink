import { dispatchLoopbackCallback } from "./mcp-oauth-loopback-dispatch.ts";
import {
  type CoordinatorLogger,
  type OriginCallbacks,
  type McpOAuthLoopbackHandler,
} from "./mcp-oauth-loopback-contracts.ts";
import { parseLoopbackRedirect } from "./mcp-oauth-loopback-address.ts";
import { bindLoopbackServers, closeLoopbackServers } from "./mcp-oauth-loopback-server.ts";

export { loopbackBindHosts, parseLoopbackRedirect } from "./mcp-oauth-loopback-address.ts";
export type { CoordinatorLogger, McpOAuthLoopbackHandler } from "./mcp-oauth-loopback-contracts.ts";

export class McpOAuthLoopbackRegistry {
  private readonly openOrigins = new Map<string, Promise<OriginCallbacks>>();

  constructor(private readonly log: CoordinatorLogger) {}

  async acquire(redirectUri: URL, callback: McpOAuthLoopbackHandler): Promise<() => Promise<void>> {
    const { port } = parseLoopbackRedirect(redirectUri);
    const originKey = redirectUri.origin;
    let opening = this.openOrigins.get(originKey);
    if (opening === undefined) {
      opening = this.createOriginEntry(originKey, port, redirectUri.hostname);
      this.openOrigins.set(originKey, opening);
      const pendingBind = opening;
      void pendingBind.catch(() => {
        if (this.openOrigins.get(originKey) === pendingBind) this.openOrigins.delete(originKey);
      });
    }

    const record = await opening;
    record.handlers.add(callback);
    let leaseEnded = false;
    return async () => {
      if (leaseEnded) return;
      leaseEnded = true;
      record.handlers.delete(callback);
      if (record.handlers.size !== 0) return;
      if (this.openOrigins.get(originKey) === opening) this.openOrigins.delete(originKey);
      await closeLoopbackServers(record.listeners);
    };
  }

  async dispose(): Promise<void> {
    const openingOrigins = [...this.openOrigins.values()];
    this.openOrigins.clear();
    for (const opening of openingOrigins) {
      try {
        const record = await opening;
        record.handlers.clear();
        await closeLoopbackServers(record.listeners);
      } catch {
        // A failed bind has already closed each attempted server.
      }
    }
  }

  private async createOriginEntry(origin: string, port: number, redirectHost: string): Promise<OriginCallbacks> {
    const listeners = await bindLoopbackServers(port, redirectHost, (incoming, outgoing) => {
      void this.serveCallback(origin, incoming, outgoing);
    });
    return { listeners, handlers: new Set() };
  }

  private serveCallback(
    origin: string,
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    return dispatchLoopbackCallback(origin, request, response, () => this.openOrigins.get(origin), this.log);
  }
}

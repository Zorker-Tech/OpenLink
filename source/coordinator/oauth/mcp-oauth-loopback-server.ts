import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { loopbackBindHosts } from "./mcp-oauth-loopback-address.ts";

export async function bindLoopbackServers(
  port: number,
  redirectHost: string,
  handleRequest: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server[]> {
  const listeners: Server[] = [];
  const bindErrors: Error[] = [];
  for (const host of loopbackBindHosts(redirectHost)) {
    const listener = createServer(handleRequest);
    try {
      await new Promise<void>((resolve, reject) => {
        const rejectListen = (error: Error) => reject(error);
        listener.once("error", rejectListen);
        listener.listen(port, host, () => {
          listener.off("error", rejectListen);
          resolve();
        });
      });
      listeners.push(listener);
    } catch (error) {
      bindErrors.push(error instanceof Error ? error : new Error(String(error)));
      listener.close();
    }
  }

  if (listeners.length === 0) throw bindErrors[0] ?? new Error(`MCP OAuth loopback callback could not bind port ${port}.`);
  return listeners;
}

export async function closeLoopbackServers(listeners: readonly Server[]): Promise<void> {
  await Promise.all(listeners.filter((listener) => listener.listening).map(closeOneServer));
}

function closeOneServer(listener: Server): Promise<void> {
  return new Promise((resolve) => {
    listener.close(() => resolve());
    listener.closeIdleConnections?.();
  });
}

import type { IncomingMessage, ServerResponse } from "node:http";

import { errorMessage } from "../../shared/errors/summary.ts";
import type {
  CoordinatorLogger,
  OriginCallbacks,
} from "./mcp-oauth-loopback-contracts.ts";

export async function dispatchLoopbackCallback(
  baseOrigin: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  readCallbacks: () => Promise<OriginCallbacks> | undefined,
  log: CoordinatorLogger,
): Promise<void> {
  const registeredOrigin = readCallbacks();
  if (registeredOrigin === undefined) {
    outgoing.writeHead(404);
    outgoing.end("Not found");
    return;
  }

  let callbacks: OriginCallbacks;
  try {
    callbacks = await registeredOrigin;
  } catch {
    outgoing.writeHead(404);
    outgoing.end("Not found");
    return;
  }

  let callbackAddress: URL;
  try {
    callbackAddress = new URL(incoming.url ?? "/", baseOrigin);
  } catch {
    outgoing.writeHead(400);
    outgoing.end("Bad request");
    return;
  }

  for (const callback of [...callbacks.handlers]) {
    try {
      if (await callback(callbackAddress, incoming, outgoing)) return;
    } catch (error) {
      log.warn({ kind: "callback-handler-failed", detail: errorMessage(error) });
      if (outgoing.headersSent) return;
    }
  }

  if (!outgoing.headersSent) {
    outgoing.writeHead(404);
    outgoing.end("Not found");
  }
}

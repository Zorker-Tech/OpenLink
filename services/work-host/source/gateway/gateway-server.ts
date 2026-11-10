/** HTTP entry point for the loopback gateway used by desktop and the local-exec providers. */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { errorMessage } from "../shared/errors/summary.ts";
import { SLATE_GATEWAY } from "../shared/gateway-wire.ts";
import {
  GATEWAY_LOCAL_EXEC_REQUESTS_PATH,
  GATEWAY_LOCAL_EXEC_RESPONSES_PATH,
} from "../shared/local-exec-gateway.ts";
import {
  GATEWAY_WEBAUTHN_REQUESTS_PATH,
  GATEWAY_WEBAUTHN_RESPONSES_PATH,
} from "../shared/webauthn-gateway.ts";
import { GATEWAY_PREPARE_UPGRADE_PATH } from "./gateway-protocol.ts";
import {
  isAuthorized,
  parseSubscribedChannels,
  readBody,
  rejectUntrustedBrowserRequest,
  respondError,
  respondJson,
  routeCommand,
  statusForCommandError,
} from "./gateway-server-http.ts";
import {
  SlateGatewayRequestError,
  type GatewayServerDeps,
} from "./gateway-server-contracts.ts";
import { handleAvatarImage, handleBridgeRequests, handleBridgeResponses, handleEvents } from "./gateway-server-routes.ts";

export {
  DISABLE_SSE_GZIP_ENV,
  GATEWAY_REQUEST_ID_HEADER,
  GZIP_MIN_BYTES,
  MAX_BODY_BYTES,
  MAX_REQUEST_PAYLOAD_BYTES,
  SSE_HEARTBEAT_MS,
  SlateGatewayRequestError,
} from "./gateway-server-contracts.ts";
export type { GatewayServerDeps } from "./gateway-server-contracts.ts";
export {
  clientAcceptsGzip,
  clientWantsSlimAvatars,
  hostHeaderHostname,
  isAuthorized,
  openSseStream,
  parseSubscribedChannels,
  readBody,
  rejectUntrustedBrowserRequest,
  respondError,
  respondJson,
  routeCommand,
  statusForCommandError,
} from "./gateway-server-http.ts";

export async function handleRequest(
  dependencies: GatewayServerDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (rejectUntrustedBrowserRequest(dependencies, request, response)) return;

  if (request.method === "GET" && url.pathname === SLATE_GATEWAY.paths.health) {
    const health = dependencies.getHealth();
    return respondJson(response, {
      ok: true,
      pid: process.pid,
      isBusy: health.isBusy,
      ...(health.busyOnlyAwaitingApproval === undefined
        ? {}
        : { busyOnlyAwaitingApproval: health.busyOnlyAwaitingApproval }),
      activeAgentId: health.activeAgentId,
      startedAt: dependencies.startedAt,
      lastBusyAtMs: health.lastBusyAtMs,
    });
  }

  const eventStream = request.method === "GET" && url.pathname === SLATE_GATEWAY.paths.events;
  const prepareUpgrade = request.method === "POST" && url.pathname === GATEWAY_PREPARE_UPGRADE_PATH;
  const avatar = request.method === "GET" && url.pathname.startsWith(`${SLATE_GATEWAY.paths.avatars}/`);
  const localRequests = request.method === "GET" && url.pathname === GATEWAY_LOCAL_EXEC_REQUESTS_PATH;
  const localResponses = request.method === "POST" && url.pathname === GATEWAY_LOCAL_EXEC_RESPONSES_PATH;
  const webAuthnRequests = request.method === "GET" && url.pathname === GATEWAY_WEBAUTHN_REQUESTS_PATH;
  const webAuthnResponses = request.method === "POST" && url.pathname === GATEWAY_WEBAUTHN_RESPONSES_PATH;
  const command = request.method === "POST" && url.pathname.startsWith(`${SLATE_GATEWAY.paths.api}/`);

  if (!(eventStream || prepareUpgrade || avatar || localRequests || localResponses || webAuthnRequests || webAuthnResponses || command)) {
    return respondError(response, 404, `not found: ${request.method} ${url.pathname}`);
  }
  if ((localRequests || localResponses) && dependencies.authToken == null) {
    return respondError(response, 401, "local-exec requires gateway authentication");
  }
  if ((webAuthnRequests || webAuthnResponses) && dependencies.authToken == null) {
    return respondError(response, 401, "webauthn requires gateway authentication");
  }
  if (dependencies.authToken != null && !isAuthorized(request, dependencies.authToken)) {
    return respondError(response, 401, "unauthorized");
  }

  if (prepareUpgrade) {
    const result = dependencies.prepareForUpgrade == null
      ? { quiescing: false, runningTurns: 0 }
      : await dependencies.prepareForUpgrade();
    return respondJson(response, result);
  }
  if (localRequests || localResponses) dependencies.onDesktopContact?.();

  if (localRequests) return handleBridgeRequests(dependencies.localExec, "local-exec channel not enabled", request, response);
  if (localResponses) {
    const body = await readBody(request);
    return handleBridgeResponses(dependencies.localExec, "local-exec channel not enabled", body, response);
  }
  if (webAuthnRequests) return handleBridgeRequests(dependencies.webauthn, "webauthn channel not enabled", request, response);
  if (webAuthnResponses) {
    const body = await readBody(request);
    return handleBridgeResponses(dependencies.webauthn, "webauthn channel not enabled", body, response);
  }
  if (eventStream) return handleEvents(dependencies, request, response, parseSubscribedChannels(url));
  if (avatar) return handleAvatarImage(dependencies, request, response, url);

  const method = url.pathname.slice(SLATE_GATEWAY.paths.api.length + 1);
  return routeCommand(dependencies, method, await readBody(request), response, request);
}

export async function startGatewayServer(dependencies: GatewayServerDeps): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const host = dependencies.host ?? "127.0.0.1";
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(dependencies, request, response).catch((error) => {
      if (!response.headersSent) respondError(response, statusForCommandError(error), errorMessage(error));
      else response.end();
    });
  };

  const server = dependencies.tls == null
    ? createHttpServer(listener)
    : createHttpsServer({ cert: dependencies.tls.cert, key: dependencies.tls.key }, listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(dependencies.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("gateway did not bind a TCP address");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error != null ? reject(error) : resolve());
    }),
  };
}

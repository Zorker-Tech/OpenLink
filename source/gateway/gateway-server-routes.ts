import type { IncomingMessage, ServerResponse } from "node:http";
import { SLATE_GATEWAY } from "../shared/gateway-wire.ts";
import { GATEWAY_WEBAUTHN_REQUESTS_PATH } from "../shared/webauthn-gateway.ts";
import {
  GATEWAY_LOCAL_EXEC_REQUESTS_PATH,
} from "../shared/local-exec-gateway.ts";
import { stripInlineAvatarsFromEvent } from "./gateway-protocol.ts";
import {
  clientWantsSlimAvatars,
  contentDispositionAttachmentHeaders,
  openSseStream,
  respondError,
  respondJson,
} from "./gateway-server-http.ts";
import type { GatewayServerDeps } from "./gateway-server-contracts.ts";

const DATA_URL_PATTERN = /^data:([a-z0-9.+/-]+);base64,(.*)$/i;

export function handleEvents(
  dependencies: GatewayServerDeps,
  request: IncomingMessage,
  response: ServerResponse,
  channels?: Set<string>,
): void {
  const slimReplies = clientWantsSlimAvatars(request);
  response.on("close", () => dependencies.onEventStreamClosed?.());
  openSseStream(request, response, (write) => dependencies.subscribe((event) => {
    if (channels != null && !channels.has(event.channel)) return;
    write(JSON.stringify(slimReplies ? stripInlineAvatarsFromEvent(event) : event));
  }));
}

export async function handleAvatarImage(
  dependencies: GatewayServerDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (request.headers["sec-fetch-site"] === "cross-site") {
    return respondError(response, 403, "cross-site avatar loads are not allowed");
  }

  const id = decodeURIComponent(url.pathname.slice(SLATE_GATEWAY.paths.avatars.length + 1));
  if (id.length === 0) return respondError(response, 404, "missing agent id");
  const avatar = await dependencies.api.getAgentAvatar({ id }) as { dataUrl?: string | null; version?: string | null };
  const parsed = avatar.dataUrl == null ? null : DATA_URL_PATTERN.exec(avatar.dataUrl);
  if (avatar.version == null || parsed?.[1] == null || parsed[2] == null) {
    return respondError(response, 404, "agent has no avatar");
  }

  const requestedVersion = url.searchParams.get("v");
  if (requestedVersion != null && requestedVersion !== avatar.version) {
    return respondError(response, 404, "no such avatar version");
  }

  const etag = `"${avatar.version}"`;
  const cacheHeaders = requestedVersion == null
    ? { "cache-control": "no-store", etag }
    : { "cache-control": "private, max-age=31536000, immutable", etag };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, cacheHeaders);
    response.end();
    return;
  }

  const bytes = Buffer.from(parsed[2], "base64");
  response.writeHead(200, {
    ...cacheHeaders,
    ...contentDispositionAttachmentHeaders(),
    "content-type": parsed[1],
    "content-length": bytes.byteLength,
  });
  response.end(bytes);
}

export function handleBridgeRequests(
  bridge: GatewayServerDeps["localExec"] | GatewayServerDeps["webauthn"],
  missingMessage: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (bridge == null) return respondError(response, 404, missingMessage);
  openSseStream(request, response, (write) => bridge.registerProvider((frame) => write(JSON.stringify(frame))));
}

export function handleBridgeResponses(
  bridge: GatewayServerDeps["localExec"] | GatewayServerDeps["webauthn"],
  missingMessage: string,
  body: string,
  response: ServerResponse,
): void {
  if (bridge == null) return respondError(response, 404, missingMessage);
  bridge.submitResponses(body.length > 0 ? JSON.parse(body) : {});
  respondJson(response, { ok: true });
}

export const gatewayRoutePaths = {
  avatarPrefix: SLATE_GATEWAY.paths.avatars,
  events: SLATE_GATEWAY.paths.events,
  localExecRequests: GATEWAY_LOCAL_EXEC_REQUESTS_PATH,
  webauthnRequests: GATEWAY_WEBAUTHN_REQUESTS_PATH,
} as const;

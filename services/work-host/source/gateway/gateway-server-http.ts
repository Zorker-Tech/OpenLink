import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { constants as compressionFlags, createGzip, gzip } from "node:zlib";
import { errorMessage } from "../shared/errors/summary.ts";
import { SLATE_GATEWAY } from "../shared/gateway-wire.ts";
import { parseTraceparent } from "../shared/observability/send-trace.ts";
import { classifyGatewayFailure } from "./gateway-command-error.ts";
import { SLATE_GATEWAY_COMMANDS, SLATE_GATEWAY_SLIM_COMMANDS } from "./gateway-protocol.ts";
import {
  DISABLE_SSE_GZIP_ENV,
  GATEWAY_REQUEST_ID_HEADER,
  GZIP_MIN_BYTES,
  MAX_BODY_BYTES,
  SSE_HEARTBEAT_MS,
  SlateGatewayRequestError,
  type GatewayServerDeps,
} from "./gateway-server-contracts.ts";

export function statusForCommandError(error: unknown): number {
  const name = error instanceof Error ? error.name : "";
  if (name === "SlateAgentLimitError" || name === "SlateSkillPublishError") return 409;
  // Bot substrate failures already carry the status their caller needs
  // (unavailable, conflict, invalid identity). Preserve it instead of
  // flattening every failure to 500.
  const status = error !== null && typeof error === "object"
    ? (error as { status?: unknown }).status
    : undefined;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

export async function readBody(request: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as ArrayBuffer);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) throw new SlateGatewayRequestError("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function clientAcceptsGzip(request: Pick<IncomingMessage, "headers">): boolean {
  const header = request.headers["accept-encoding"];
  const encodings = Array.isArray(header) ? header.join(",") : header;
  return typeof encodings === "string" && encodings.toLowerCase().includes("gzip");
}

export function clientWantsSlimAvatars(request: Pick<IncomingMessage, "headers">): boolean {
  const header = request.headers[SLATE_GATEWAY.headers.slimAvatars];
  return (Array.isArray(header) ? header[0] : header) === "1";
}

export function respondJson(response: ServerResponse, value: unknown, request?: IncomingMessage): void {
  const raw = Buffer.from(JSON.stringify(value ?? null), "utf8");
  const writeUncompressed = () => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": raw.byteLength,
      [SLATE_GATEWAY.headers.mintDedupe]: "1",
    });
    response.end(raw);
  };

  if (request == null || raw.byteLength < GZIP_MIN_BYTES || !clientAcceptsGzip(request)) {
    writeUncompressed();
    return;
  }
  gzip(raw, (error, compressed) => {
    if (response.destroyed || response.writableEnded || response.headersSent) return;
    if (error != null) return writeUncompressed();
    response.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": compressed.byteLength,
      vary: "Accept-Encoding",
      [SLATE_GATEWAY.headers.mintDedupe]: "1",
    });
    response.end(compressed);
  });
}

export function respondError(response: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function isAuthorized(request: Pick<IncomingMessage, "headers">, expectedToken: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return false;
  const prefix = `${SLATE_GATEWAY.authentication.scheme} `;
  if (!authorization.startsWith(prefix)) return false;

  const provided = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function hostHeaderHostname(request: Pick<IncomingMessage, "headers">): string | null {
  const host = request.headers.host;
  if (typeof host !== "string" || host.length === 0) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

export function rejectUntrustedBrowserRequest(
  dependencies: Pick<GatewayServerDeps, "authToken">,
  request: Pick<IncomingMessage, "headers">,
  response: ServerResponse,
): boolean {
  if (request.headers.origin !== undefined) {
    respondError(response, 403, "browser-origin gateway requests are not allowed");
    return true;
  }
  if (dependencies.authToken == null) {
    const host = hostHeaderHostname(request);
    if (host == null || !isLoopbackHost(host)) {
      respondError(response, 403, "untrusted gateway host");
      return true;
    }
  }
  return false;
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function traceIdsFor(request: IncomingMessage) {
  const traceparent = headerValue(request, SLATE_GATEWAY.headers.traceparent);
  const parsed = parseTraceparent(traceparent);
  return parsed == null ? {} : { traceparent, traceId: parsed.traceId, spanId: parsed.spanId };
}

export async function routeCommand(
  dependencies: GatewayServerDeps,
  method: string,
  body: string,
  response: ServerResponse,
  request: IncomingMessage,
): Promise<void> {
  if (!Object.hasOwn(SLATE_GATEWAY_COMMANDS, method)) {
    return respondError(response, 404, `unknown gateway method: ${method}`);
  }

  const handlers = clientWantsSlimAvatars(request) ? SLATE_GATEWAY_SLIM_COMMANDS : SLATE_GATEWAY_COMMANDS;
  const handler = (handlers as Record<string, (api: unknown, body: string) => unknown>)[method];
  if (handler == null) return respondError(response, 404, `unknown gateway method: ${method}`);

  const requestId = headerValue(request, GATEWAY_REQUEST_ID_HEADER);
  const { traceparent: _parent, ...traceIds } = traceIdsFor(request);
  const startedAt = Date.now();
  let result: unknown;
  try {
    result = await handler(dependencies.api, body);
  } catch (error) {
    if (dependencies.onCommandError != null && statusForCommandError(error) >= 500) {
      try {
        dependencies.onCommandError({ method, ...classifyGatewayFailure(error), durationMs: Date.now() - startedAt, requestId, ...traceIds });
      } catch {
        // Reporting a failed command must not replace the error the caller receives.
      }
    }
    throw error;
  }

  try {
    dependencies.onCommandComplete?.({ method, durationMs: Date.now() - startedAt, requestId, ...traceIds });
  } catch {
    // A completion hook is observational and cannot invalidate the command result.
  }
  respondJson(response, result, request);
}

export function openSseStream(
  request: IncomingMessage,
  response: ServerResponse,
  register: (write: (data: string) => void) => () => void,
): void {
  const useCompression = process.env[DISABLE_SSE_GZIP_ENV] !== "1" && clientAcceptsGzip(request);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...(useCompression ? { "content-encoding": "gzip", vary: "Accept-Encoding" } : {}),
  });
  const compressor = useCompression ? createGzip({ flush: compressionFlags.Z_SYNC_FLUSH }) : null;
  compressor?.pipe(response);
  const stream = compressor ?? response;
  stream.write("retry: 1000\n\n");

  const unsubscribe = register((data) => stream.write(`data: ${data}\n\n`));
  const heartbeat = setInterval(() => stream.write(":ping\n\n"), SSE_HEARTBEAT_MS);
  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    compressor?.destroy();
  });
}

export function parseSubscribedChannels(url: URL): Set<string> | undefined {
  const query = url.searchParams.get("channels");
  if (query == null) return undefined;
  const selected = query.split(",").map((channel) => channel.trim()).filter(Boolean);
  return selected.length === 0 ? undefined : new Set(selected);
}

export function contentDispositionAttachmentHeaders() {
  return {
    "content-disposition": "attachment",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
}

export { errorMessage };

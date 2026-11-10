/** Slate-native HTTP control surface for the box exec daemon. */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { BoxExecRuntime } from "./runtime.ts";
import {
  SLATE_BOX_CONTROL_PATHS,
  SLATE_BOX_CONTROL_PROTOCOL_HEADER,
  SLATE_BOX_CONTROL_PROTOCOL_VERSION,
  parseBoxEnvironmentUpdate,
  parseBoxMcpLoadRequest,
} from "../shared/box-control-protocol.ts";

const MAX_CONTROL_BODY_BYTES = 1024 * 1024;
const CONTROL_PATHS: ReadonlySet<string> = new Set(Object.values(SLATE_BOX_CONTROL_PATHS));

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_CONTROL_BODY_BYTES) throw new RangeError("box control request is too large");
    chunks.push(bytes);
  }
  if (total === 0) throw new TypeError("box control request body is required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    [SLATE_BOX_CONTROL_PROTOCOL_HEADER]: String(SLATE_BOX_CONTROL_PROTOCOL_VERSION),
  });
  response.end(body);
}

function writeError(response: ServerResponse, status: number, code: string, message: string): void {
  writeJson(response, status, { error: { code, message } });
}

export async function handleSlateBoxControlHttp(
  runtime: BoxExecRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://slate-box.invalid").pathname;
  if (!CONTROL_PATHS.has(pathname)) return false;
  if (request.method !== "POST") {
    writeError(response, 405, "method_not_allowed", "box control endpoints require POST");
    return true;
  }

  try {
    switch (pathname) {
      case SLATE_BOX_CONTROL_PATHS.ping:
        writeJson(response, 200, { ok: true });
        return true;
      case SLATE_BOX_CONTROL_PATHS.environment: {
        const update = parseBoxEnvironmentUpdate(await readJsonBody(request));
        writeJson(response, 200, runtime.applyEnvPatch(update));
        return true;
      }
      case SLATE_BOX_CONTROL_PATHS.mcp:
        parseBoxMcpLoadRequest(await readJsonBody(request));
        writeJson(response, 200, { loadedServerNames: [] });
        return true;
      default:
        return false;
    }
  } catch (error) {
    writeError(
      response,
      error instanceof RangeError ? 413 : 400,
      error instanceof RangeError ? "payload_too_large" : "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
}

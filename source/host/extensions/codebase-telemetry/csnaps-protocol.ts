/**
 * The frames the codebase-telemetry helper speaks.
 *
 * A frame is a length-prefixed JSON body with a bounded size, and a body that does not decode is reported as a
 * protocol error rather than as a missing frame. Requests and responses name their method and carry parameters, and
 * failures carry a code the caller can act on.
 */

export const MAX_FRAME_BYTES = 1024 * 1024;

export class CsnapsProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CsnapsProtocolError";
  }
}

export type CsnapsOperationMethod = "ping" | "shutdown" | "initialize" | "apply_codebase_specs" | "snapshot" | "trigger_upload" | "flush_pending_uploads";

export type CsnapsOperation =
  | { method: "ping" | "shutdown" }
  | { method: "initialize" | "apply_codebase_specs" | "snapshot" | "trigger_upload" | "flush_pending_uploads"; params: Record<string, unknown> };

export type CsnapsErrorCode =
  | "unknown_method"
  | "invalid_params"
  | "already_initialized"
  | "not_initialized"
  | "codebases_not_reconciled"
  | "shutting_down"
  | "server_busy"
  | "invalid_configuration"
  | "invalid_codebases"
  | "codebase_environment_conflict"
  | "corrupt_uuid_state"
  | "state_io"
  | "snapshot_failed"
  | "upload_disabled"
  | "internal_error";

export type CsnapsResponse = { readonly id: number; readonly ok: true; readonly result: unknown } | { readonly id: number; readonly ok: false; readonly error: CsnapsErrorCode };

/** A codebase the helper tracks, as the helper names it in its own answers. */
export interface CsnapsTrackedCodebase {
  readonly codebaseUuid: string;
  readonly path: string;
  readonly kind: number;
  readonly environment: number;
}

const ERROR_CODES = new Set<CsnapsErrorCode>(["unknown_method", "invalid_params", "already_initialized", "not_initialized", "codebases_not_reconciled", "shutting_down", "server_busy", "invalid_configuration", "invalid_codebases", "codebase_environment_conflict", "corrupt_uuid_state", "state_io", "snapshot_failed", "upload_disabled", "internal_error"]);

/** An object whose own keys are exactly the ones named — nothing more, nothing less. */
function hasExactlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_BYTES) throw new CsnapsProtocolError(`csnaps request frame length ${payload.length} exceeds ${MAX_FRAME_BYTES}-byte limit`);
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Every whole frame in what arrived so far, and the bytes that are still waiting for the rest of their frame. */
export function decodeFramePayloads(input: Buffer): { payloads: Buffer[]; remainder: Buffer } {
  const payloads: Buffer[] = [];
  let offset = 0;
  while (input.length - offset >= 4) {
    const length = input.readUInt32BE(offset);
    if (length > MAX_FRAME_BYTES) throw new CsnapsProtocolError(`csnaps response frame length ${length} exceeds ${MAX_FRAME_BYTES}-byte limit`);
    if (input.length - offset < 4 + length) break;
    payloads.push(input.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return { payloads, remainder: input.subarray(offset) };
}

export function encodeCsnapsRequest(id: number, operation: CsnapsOperation): Buffer {
  if (!Number.isSafeInteger(id) || id < 0) throw new CsnapsProtocolError("invalid csnaps request ID");
  const request = { id, method: operation.method, params: "params" in operation ? operation.params : {} };
  return encodeFrame(Buffer.from(JSON.stringify(request), "utf8"));
}

export function parseCsnapsResponse(payload: Buffer): CsnapsResponse {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch (cause) {
    throw new CsnapsProtocolError("invalid csnaps response JSON", { cause });
  }
  if (value == null || typeof value !== "object" || !("id" in value) || typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id < 0 || !("ok" in value) || typeof value.ok !== "boolean") {
    throw new CsnapsProtocolError("invalid csnaps response envelope");
  }
  if (value.ok) {
    if (!hasExactlyKeys(value, ["id", "ok", "result"]) || !("result" in value)) throw new CsnapsProtocolError("invalid csnaps success response");
    return { id: value.id, ok: true, result: value.result };
  }
  if (!hasExactlyKeys(value, ["error", "id", "ok"]) || !("error" in value) || typeof value.error !== "string" || !ERROR_CODES.has(value.error as CsnapsErrorCode)) {
    throw new CsnapsProtocolError("invalid csnaps error response");
  }
  return { id: value.id, ok: false, error: value.error as CsnapsErrorCode };
}

const CODEBASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseTrackedCodebase(entry: unknown): CsnapsTrackedCodebase {
  const invalid = (): never => {
    throw new CsnapsProtocolError("invalid tracked csnaps codebase");
  };
  if (entry == null || typeof entry !== "object" || !hasExactlyKeys(entry, ["codebaseUuid", "environment", "kind", "path"])) invalid();
  const tracked = entry as Record<string, unknown>;
  if (!("codebaseUuid" in tracked) || typeof tracked.codebaseUuid !== "string" || !CODEBASE_UUID_PATTERN.test(tracked.codebaseUuid)) invalid();
  if (!("path" in tracked) || typeof tracked.path !== "string") invalid();
  if (!("kind" in tracked) || typeof tracked.kind !== "number") invalid();
  if (!("environment" in tracked) || typeof tracked.environment !== "number") invalid();
  return { codebaseUuid: tracked.codebaseUuid as string, path: tracked.path as string, kind: tracked.kind as number, environment: tracked.environment as number };
}

function parseServiceState(value: unknown): { tracked: readonly CsnapsTrackedCodebase[] } {
  if (value == null || typeof value !== "object" || !hasExactlyKeys(value, ["tracked"]) || !("tracked" in value) || !Array.isArray(value.tracked)) {
    throw new CsnapsProtocolError("invalid csnaps service state");
  }
  return { tracked: value.tracked.map(parseTrackedCodebase) };
}

function parseRejectedCodebase(entry: unknown): { path: string; kind: number } {
  const invalid = (): never => {
    throw new CsnapsProtocolError("invalid rejected csnaps codebase");
  };
  if (entry == null || typeof entry !== "object" || !hasExactlyKeys(entry, ["kind", "path"])) invalid();
  const rejected = entry as Record<string, unknown>;
  if (!("path" in rejected) || typeof rejected.path !== "string") invalid();
  if (!("kind" in rejected) || typeof rejected.kind !== "number") invalid();
  return { path: rejected.path as string, kind: rejected.kind as number };
}

const EMPTY_RESULT_METHODS: readonly CsnapsOperationMethod[] = ["ping", "snapshot", "trigger_upload", "flush_pending_uploads", "shutdown"];

export function parseCsnapsOperationResult(operation: CsnapsOperation, value: unknown): unknown {
  if (EMPTY_RESULT_METHODS.includes(operation.method)) {
    if (value == null || typeof value !== "object" || !hasExactlyKeys(value, [])) throw new CsnapsProtocolError("invalid empty csnaps result");
    return {};
  }
  if (operation.method === "initialize") {
    if (value == null || typeof value !== "object" || !hasExactlyKeys(value, ["state"]) || !("state" in value)) throw new CsnapsProtocolError("invalid csnaps initialize result");
    return { state: parseServiceState(value.state) };
  }
  if (value == null || typeof value !== "object" || !hasExactlyKeys(value, ["rejected", "state"]) || !("rejected" in value) || !Array.isArray(value.rejected) || !("state" in value)) {
    throw new CsnapsProtocolError("invalid csnaps apply result");
  }
  return { state: parseServiceState(value.state), rejected: value.rejected.map(parseRejectedCodebase) };
}

/** Decodes whatever arrived: frames are handed out whole, and the bytes of a half-arrived frame wait for the rest. */
export class CsnapsResponseDecoder {
  private buffer = Buffer.alloc(0);

  decode(chunk: Buffer): CsnapsResponse[] {
    const input = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const decoded = decodeFramePayloads(input);
    this.buffer = Buffer.from(decoded.remainder);
    return decoded.payloads.map(parseCsnapsResponse);
  }

  assertComplete(): void {
    if (this.buffer.length !== 0) throw new CsnapsProtocolError("truncated csnaps response frame");
  }
}

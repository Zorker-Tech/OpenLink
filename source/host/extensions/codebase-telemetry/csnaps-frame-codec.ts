import { TextDecoder } from "node:util"
import {
  CsnapsProtocolError,
  MAX_FRAME_BYTES,
} from "./csnaps-protocol-types.ts"
import type {
  CsnapsErrorCode,
  CsnapsOperation,
  CsnapsResponse,
} from "./csnaps-protocol-types.ts"

const RESPONSE_ERROR_CODES: ReadonlySet<CsnapsErrorCode> = new Set([
  "unknown_method",
  "invalid_params",
  "already_initialized",
  "not_initialized",
  "codebases_not_reconciled",
  "shutting_down",
  "server_busy",
  "invalid_configuration",
  "invalid_codebases",
  "codebase_environment_conflict",
  "corrupt_uuid_state",
  "state_io",
  "snapshot_failed",
  "upload_disabled",
  "internal_error",
])

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true })

export function hasExactlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_BYTES) throw new CsnapsProtocolError(`csnaps request frame length ${payload.length} exceeds ${MAX_FRAME_BYTES}-byte limit`)
  const frame = Buffer.allocUnsafe(4 + payload.length)
  frame.writeUInt32BE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

/** Returns complete bodies while keeping any partial body for the next read. */
export function decodeFramePayloads(input: Buffer): { payloads: Buffer[]; remainder: Buffer } {
  const payloads: Buffer[] = []
  let offset = 0
  while (input.length - offset >= 4) {
    const length = input.readUInt32BE(offset)
    if (length > MAX_FRAME_BYTES) throw new CsnapsProtocolError(`csnaps response frame length ${length} exceeds ${MAX_FRAME_BYTES}-byte limit`)
    if (input.length - offset < 4 + length) break
    payloads.push(input.subarray(offset + 4, offset + 4 + length))
    offset += 4 + length
  }
  return { payloads, remainder: input.subarray(offset) }
}

export function encodeCsnapsRequest(id: number, operation: CsnapsOperation): Buffer {
  if (!Number.isSafeInteger(id) || id < 0) throw new CsnapsProtocolError("invalid csnaps request ID")
  const request = { id, method: operation.method, params: "params" in operation ? operation.params : {} }
  return encodeFrame(Buffer.from(JSON.stringify(request), "utf8"))
}

export function parseCsnapsResponse(payload: Buffer): CsnapsResponse {
  let source: string
  try {
    source = STRICT_UTF8.decode(payload)
  } catch (cause) {
    throw new CsnapsProtocolError("invalid csnaps response UTF-8", { cause })
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (cause) {
    throw new CsnapsProtocolError("invalid csnaps response JSON", { cause })
  }
  if (value == null || typeof value !== "object" || !("id" in value) || typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id < 0 || !("ok" in value) || typeof value.ok !== "boolean") {
    throw new CsnapsProtocolError("invalid csnaps response envelope")
  }
  if (value.ok) {
    if (!hasExactlyKeys(value, ["id", "ok", "result"]) || !("result" in value)) throw new CsnapsProtocolError("invalid csnaps success response")
    return { id: value.id, ok: true, result: value.result }
  }
  if (!hasExactlyKeys(value, ["error", "id", "ok"]) || !("error" in value) || typeof value.error !== "string" || !RESPONSE_ERROR_CODES.has(value.error as CsnapsErrorCode)) {
    throw new CsnapsProtocolError("invalid csnaps error response")
  }
  return { id: value.id, ok: false, error: value.error as CsnapsErrorCode }
}

export class CsnapsResponseDecoder {
  private buffer = Buffer.alloc(0)

  decode(chunk: Buffer): CsnapsResponse[] {
    const input = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const decoded = decodeFramePayloads(input)
    this.buffer = Buffer.from(decoded.remainder)
    return decoded.payloads.map(parseCsnapsResponse)
  }

  assertComplete(): void {
    if (this.buffer.length !== 0) throw new CsnapsProtocolError("truncated csnaps response frame")
  }
}

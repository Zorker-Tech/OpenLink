import { CsnapsProtocolError } from "./csnaps-protocol-types.ts"
import type {
  CsnapsOperation,
  CsnapsTrackedCodebase,
} from "./csnaps-protocol-types.ts"
import { hasExactlyKeys } from "./csnaps-frame-codec.ts"

const CODEBASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const EMPTY_RESULT_METHODS: ReadonlySet<CsnapsOperation["method"]> = new Set([
  "ping",
  "snapshot",
  "trigger_upload",
  "flush_pending_uploads",
  "shutdown",
])

function parseTrackedCodebase(value: unknown): CsnapsTrackedCodebase {
  if (value == null || typeof value !== "object" || !hasExactlyKeys(value, ["codebaseUuid", "environment", "kind", "path"])) {
    throw new CsnapsProtocolError("invalid tracked csnaps codebase")
  }
  const row = value as Record<string, unknown>
  if (typeof row.codebaseUuid !== "string" || !CODEBASE_UUID_PATTERN.test(row.codebaseUuid)) {
    throw new CsnapsProtocolError("invalid tracked csnaps codebase")
  }
  if (typeof row.path !== "string" || typeof row.kind !== "number" || typeof row.environment !== "number") {
    throw new CsnapsProtocolError("invalid tracked csnaps codebase")
  }
  return {
    codebaseUuid: row.codebaseUuid,
    path: row.path,
    kind: row.kind,
    environment: row.environment,
  }
}

function parseServiceState(value: unknown): { tracked: readonly CsnapsTrackedCodebase[] } {
  if (value == null || typeof value !== "object" || !hasExactlyKeys(value, ["tracked"])) {
    throw new CsnapsProtocolError("invalid csnaps service state")
  }
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.tracked)) throw new CsnapsProtocolError("invalid csnaps service state")
  return { tracked: row.tracked.map(parseTrackedCodebase) }
}

function parseRejectedCodebase(value: unknown): { path: string; kind: number } {
  if (value == null || typeof value !== "object" || !hasExactlyKeys(value, ["kind", "path"])) {
    throw new CsnapsProtocolError("invalid rejected csnaps codebase")
  }
  const row = value as Record<string, unknown>
  if (typeof row.path !== "string" || typeof row.kind !== "number") {
    throw new CsnapsProtocolError("invalid rejected csnaps codebase")
  }
  return { path: row.path, kind: row.kind }
}

export function parseCsnapsOperationResult(operation: CsnapsOperation, value: unknown): unknown {
  if (EMPTY_RESULT_METHODS.has(operation.method)) {
    if (value == null || typeof value !== "object" || !hasExactlyKeys(value, [])) {
      throw new CsnapsProtocolError("invalid empty csnaps result")
    }
    return {}
  }

  if (operation.method === "initialize") {
    if (value == null || typeof value !== "object" || !hasExactlyKeys(value, ["state"])) {
      throw new CsnapsProtocolError("invalid csnaps initialize result")
    }
    return { state: parseServiceState((value as Record<string, unknown>).state) }
  }

  if (value == null || typeof value !== "object" || !hasExactlyKeys(value, ["rejected", "state"])) {
    throw new CsnapsProtocolError("invalid csnaps apply result")
  }
  const result = value as Record<string, unknown>
  if (!Array.isArray(result.rejected)) throw new CsnapsProtocolError("invalid csnaps apply result")
  return {
    state: parseServiceState(result.state),
    rejected: result.rejected.map(parseRejectedCodebase),
  }
}

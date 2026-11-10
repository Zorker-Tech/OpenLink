export const MAX_FRAME_BYTES = 1024 * 1024

export class CsnapsProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CsnapsProtocolError"
  }
}

export type CsnapsOperationMethod =
  | "ping"
  | "shutdown"
  | "initialize"
  | "apply_codebase_specs"
  | "snapshot"
  | "trigger_upload"
  | "flush_pending_uploads"

export type CsnapsOperation =
  | { method: "ping" | "shutdown" }
  | { method: "initialize" | "apply_codebase_specs" | "snapshot" | "trigger_upload" | "flush_pending_uploads"; params: Record<string, unknown> }

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
  | "internal_error"

export type CsnapsResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: CsnapsErrorCode }

export interface CsnapsTrackedCodebase {
  readonly codebaseUuid: string
  readonly path: string
  readonly kind: number
  readonly environment: number
}

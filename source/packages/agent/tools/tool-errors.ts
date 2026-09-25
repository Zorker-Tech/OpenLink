/**
 * What a tool failure is, and what each side is told about it.
 *
 * A failed tool call produces two different texts — one for the user, one for the model — because the
 * model is usually the only actor that can fix it: a parse error needs the call re-issued, an
 * unavailable environment needs the model to stop rather than retry. The classification travels with
 * the error so retry policy and metrics do not have to re-derive it from the message.
 *
 * This lives on its own so the error types and the helpers that raise them can both depend on it
 * without depending on each other.
 */

export const ToolErrorClassification = {
  NOOP: "noop",
  INVALID_ARGS: "invalid_args",
  UNEXPECTED_ENVIRONMENT: "unexpected_environment",
  USER_REJECTED: "user_rejected",
  TIMEOUT: "timeout",
  PROVIDER_ERROR: "provider_error",
  BAD_USER_DEVICE_STATE: "bad_user_device_state",
  ABORTED: "aborted",
  EXEC_BACKEND_UNAVAILABLE: "exec_backend_unavailable",
  HOOK_DENIED: "hook_denied",
  MCP_AUTH_ERROR: "mcp_auth_error",
  OTHER_ERROR: "error",
} as const

export type ToolErrorClassification = (typeof ToolErrorClassification)[keyof typeof ToolErrorClassification]

export class ToolCallError extends Error {
  readonly clientVisibleErrorMessage: string
  readonly modelVisibleErrorMessage: string

  constructor({ clientVisibleErrorMessage, modelVisibleErrorMessage, error }: {
    clientVisibleErrorMessage: string
    modelVisibleErrorMessage: string
    error: string
  }) {
    super(error)
    this.clientVisibleErrorMessage = clientVisibleErrorMessage
    this.modelVisibleErrorMessage = modelVisibleErrorMessage
  }
}

export class ToolTimeoutError extends ToolCallError {}

export class CustomToolCallError extends ToolCallError {
  readonly classification: ToolErrorClassification

  constructor(classification: ToolErrorClassification, fields: {
    clientVisibleErrorMessage: string
    modelVisibleErrorMessage: string
    error: string
  }) {
    super(fields)
    this.classification = classification
  }
}

export class ToolCallArgParseError extends ToolCallError {
  constructor(formattedError: string) {
    super({ clientVisibleErrorMessage: formattedError, modelVisibleErrorMessage: formattedError, error: formattedError })
  }
}

export class ToolCallRejectedError extends ToolCallError {
  constructor(reason: string) {
    super({ clientVisibleErrorMessage: reason, modelVisibleErrorMessage: reason, error: reason })
  }
}

export class ToolCallUnexpectedEnvironmentError extends ToolCallError {
  constructor(reason: string) {
    super({ clientVisibleErrorMessage: reason, modelVisibleErrorMessage: reason, error: reason })
  }
}

export class ToolCallAbortedError extends ToolCallError {
  constructor() {
    super({ clientVisibleErrorMessage: "Aborted", modelVisibleErrorMessage: "Aborted", error: "Aborted" })
  }
}

/** A failure the orchestrator may retry, with the classification carried forward when it has one. */
export class RetryableToolOrchestrationError extends Error {
  readonly isRetryable = true
  readonly classification: ToolErrorClassification | undefined

  constructor(message: string, options?: { classification?: ToolErrorClassification; cause?: unknown }) {
    super(message)
    this.name = "RetryableToolOrchestrationError"
    this.classification = options?.classification
    if (options?.cause) this.cause = options.cause
  }
}

/** The environment itself is unreachable: retryable, but only after it comes back. */
export class RetryableToolEnvironmentOrchestrationError extends RetryableToolOrchestrationError {
  readonly code: string

  constructor(reason: string, options?: { cause?: unknown; code?: string }) {
    super(reason, {
      ...(options?.cause ? { cause: options.cause } : {}),
      classification: ToolErrorClassification.UNEXPECTED_ENVIRONMENT,
    })
    this.name = "RetryableToolEnvironmentOrchestrationError"
    this.code = options?.code ?? "ENVIRONMENT_UNREACHABLE"
  }
}

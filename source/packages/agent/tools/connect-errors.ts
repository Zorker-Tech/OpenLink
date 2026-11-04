/**
 * Turning whatever the execution boundary threw into something a turn can act on.
 *
 * The boundary is a process, a socket and a remote host, so its failures arrive as Connect errors, raw
 * errno, custom error names and plain strings — often nested, one inside the cause of another. A turn
 * needs to know three things about them: whether the environment is gone (retry later, do not hammer
 * it), whether the user's action is what stopped it, or whether the failure is worth retrying at all.
 * This normalizes all of it into the platform's own error types, searching the cause chain rather than
 * trusting the outermost message.
 */

import { Code, ConnectError } from "@connectrpc/connect"

import {
  createInteropExtensionHostTimeoutError,
  hasInteropExtensionHostTimeoutMarker,
  readInteropErrorDetailTexts,
} from "../../../adapters/interop/agent/agent-error-details-adapter.ts"
import {
  CustomToolCallError,
  RetryableToolEnvironmentOrchestrationError,
  ToolCallAbortedError,
  ToolErrorClassification,
} from "./tool-errors.ts"

const AGENT_STREAM_START_TIMEOUT_TITLE = "Workspace Disconnected"
const AGENT_STREAM_START_TIMEOUT_DETAIL =
  "Slate lost connection to the workspace while starting tool execution. Reload the window and try again."
const AGENT_STREAM_START_TIMEOUT_ERROR_NAME = "AgentExecStreamStartTimeoutError"

export function maybeNormalizeExecBoundaryError(failure: unknown): unknown {
  if (failure instanceof Error && failure.message.includes("signal is aborted without reason")) {
    const normalizedFailure = new ToolCallAbortedError()
    setErrorCause(normalizedFailure, failure)
    return normalizedFailure
  }
  if (isExecutionBackendUnavailableError(failure)) {
    const normalizedFailure = new CustomToolCallError(ToolErrorClassification.EXEC_BACKEND_UNAVAILABLE, {
      clientVisibleErrorMessage: "The execution backend is unavailable. The extension host may have disconnected or stopped responding.",
      modelVisibleErrorMessage: "Execution backend unavailable. Do not retry tool calls — the execution environment is down. Inform the user and stop.",
      error: "Execution backend unavailable",
    })
    setErrorCause(normalizedFailure, failure)
    return normalizedFailure
  }
  if (
    isPodMissingBoundaryError(failure) ||
    isExecDaemonUnreachableError(failure) ||
    isBridgeTransportClosedError(failure) ||
    isEnvironmentUnreachableError(failure)
  ) {
    return new RetryableToolEnvironmentOrchestrationError("The execution environment has become unreachable.", { cause: failure })
  }
  const connectCode = getConnectErrorCode(failure)
  if (connectCode === undefined) return failure
  let failureMessage: string
  let errorClassification: ToolErrorClassification
  switch (connectCode) {
    case Code.DeadlineExceeded:
      failureMessage = "Tool failed; this may be temporary. Try again."
      errorClassification = ToolErrorClassification.OTHER_ERROR
      break
    case Code.ResourceExhausted:
      if (isRateLimitedError(failure)) {
        failureMessage = "Service is currently rate limited. This may be temporary; try again."
        errorClassification = ToolErrorClassification.PROVIDER_ERROR
      } else {
        failureMessage = "Tool failed; this may be temporary. Try again."
        errorClassification = ToolErrorClassification.OTHER_ERROR
      }
      break
    case Code.Unavailable:
      failureMessage = "Service temporarily unavailable. This may be temporary; try again."
      errorClassification = ToolErrorClassification.OTHER_ERROR
      break
    case Code.NotFound:
      failureMessage = "Requested resource was not found. Check model selection and access."
      errorClassification = ToolErrorClassification.OTHER_ERROR
      break
    case Code.Canceled:
    case Code.Aborted:
      failureMessage = "Aborted"
      errorClassification = ToolErrorClassification.ABORTED
      break
    default:
      failureMessage = "Tool failed; this may be temporary. Try again."
      errorClassification = ToolErrorClassification.OTHER_ERROR
  }
  const normalizedFailure = new CustomToolCallError(errorClassification, {
    clientVisibleErrorMessage: failureMessage,
    modelVisibleErrorMessage: failureMessage,
    error: failureMessage,
  })
  setErrorCause(normalizedFailure, failure)
  return normalizedFailure
}

/** A stream that never started is worth a distinct, non-retryable turn error: reload, do not retry. */
export function maybeCreateAgentStreamStartTimeoutTurnError(failure: unknown): ConnectError | undefined {
  if (!isAgentStreamStartTimeoutError(failure)) return undefined
  return createInteropExtensionHostTimeoutError({
    title: AGENT_STREAM_START_TIMEOUT_TITLE,
    detail: AGENT_STREAM_START_TIMEOUT_DETAIL,
    cause: failure instanceof Error ? failure : undefined,
  })
}

function isPodMissingBoundaryError(failure: unknown): boolean {
  return errorTextsOf(failure).some(errorText => errorText.toLowerCase().includes("object not found: pod"))
}
function isExecDaemonUnreachableError(failure: unknown): boolean {
  return errorTextsOf(failure).some(errorText => errorText.toLowerCase().includes("exec-daemon is unreachable"))
}
function isBridgeTransportClosedError(failure: unknown): boolean {
  return errorTextsOf(failure).some(errorText => errorText.toLowerCase().includes("bridge transport is closed"))
}
function isEnvironmentUnreachableError(failure: unknown): boolean {
  return errorTextsOf(failure).some(errorText => errorText.toLowerCase().includes("execution environment has become unreachable"))
}

function isExecutionBackendUnavailableError(failure: unknown): boolean {
  if (
    failure instanceof Error &&
    (failure.name === "ExecBackendUnavailableError" ||
      failure.name === "ControlledExecDisposedError" ||
      failure.name === AGENT_STREAM_START_TIMEOUT_ERROR_NAME)
  ) return true
  if (isAgentStreamStartTimeoutError(failure) || isExtensionHostTimeoutError(failure) || isLegacyStreamStartTimeoutError(failure)) return true
  return errorTextsOf(failure).map(errorText => errorText.toLowerCase()).some(errorText =>
    errorText.includes("execution runtime disposed") ||
    errorText.includes("agent execution timed out") ||
    errorText.includes("extension host is not running or is unresponsive") ||
    errorText.includes("controlledexecdisposederror"))
}

export function isAgentStreamStartTimeoutError(failure: unknown): boolean {
  return failure instanceof Error && failure.name === AGENT_STREAM_START_TIMEOUT_ERROR_NAME
}

export function isAgentStreamStartTimeoutRecoveryTurnError(failure: unknown): boolean {
  if (isAgentStreamStartTimeoutError(failure)) return true
  if (!(failure instanceof ConnectError) || failure.code !== Code.DeadlineExceeded) return false
  return hasInteropExtensionHostTimeoutMarker(failure) &&
    readInteropErrorDetailTexts(failure).some(errorDetail => errorDetail.title === AGENT_STREAM_START_TIMEOUT_TITLE)
}

function isExtensionHostTimeoutError(failure: unknown): boolean {
  return failure instanceof ConnectError && hasInteropExtensionHostTimeoutMarker(failure)
}

function isLegacyStreamStartTimeoutError(failure: unknown): boolean {
  return errorTextsOf(failure).some(errorText => errorText.toLowerCase().includes("agent stream start timeout"))
}

function setErrorCause(errorTarget: Error, failureCause: unknown): void {
  errorTarget.cause = failureCause
}

function isRateLimitedError(failure: unknown): boolean {
  const errorTexts = errorTextsOf(failure).map(errorText => errorText.toLowerCase())
  return errorTexts.length > 0 && errorTexts.some(errorText =>
    errorText.includes("resource exhausted") ||
    errorText.includes("high load") ||
    errorText.includes("rate limit") ||
    errorText.includes("rate-limited") ||
    errorText.includes("too many requests") ||
    errorText.includes("overloaded") ||
    errorText.includes("overload") ||
    errorText.includes("econnreset"))
}

/** Everything the error chain says, including the details Connect errors carry out of band. */
function errorTextsOf(failure: unknown): string[] {
  const errorTexts: string[] = []
  const pendingErrors: unknown[] = [failure]
  const visitedErrors = new Set<unknown>()
  while (pendingErrors.length > 0) {
    const currentError = pendingErrors.shift()
    if (currentError === undefined || visitedErrors.has(currentError)) continue
    visitedErrors.add(currentError)
    if (currentError instanceof Error) {
      errorTexts.push(currentError.message)
      if (currentError.cause !== undefined) pendingErrors.push(currentError.cause)
    }
    if (currentError instanceof ConnectError) {
      if (typeof currentError.rawMessage === "string") errorTexts.push(currentError.rawMessage)
      for (const detail of readInteropErrorDetailTexts(currentError)) {
        if (typeof detail.title === "string") errorTexts.push(detail.title)
        if (typeof detail.detail === "string") errorTexts.push(detail.detail)
      }
    }
  }
  return errorTexts.filter(errorText => errorText.length > 0)
}

const CONNECT_CODE_BY_NAME = new Map<string, Code>(
  Array.from(Object.values(Code).filter((codeValue): codeValue is Code => typeof codeValue === "number")).map(connectCode => {
    const varianceName = Code[connectCode]
    const codeName = typeof varianceName === "string"
      ? varianceName[0]!.toLowerCase() + varianceName.substring(1).replace(/[A-Z]/g, character => `_${character.toLowerCase()}`)
      : String(connectCode)
    return [codeName, connectCode]
  }),
)

/** A Connect code from the message's `[code]` prefix, its stack, or the words it used instead. */
export function getConnectErrorCode(failure: unknown): Code | undefined {
  if (!(failure instanceof Error)) return undefined
  const messageCodeMatch = /^\[([a-z_]+)\](?:\s|$)/.exec(failure.message)
  if (messageCodeMatch) return CONNECT_CODE_BY_NAME.get(messageCodeMatch[1] as string)
  const stackCodeMatch = typeof failure.stack === "string" ? /(?:^|\n)\s*ConnectError:\s*\[([a-z_]+)\](?:\s|$)/.exec(failure.stack) : null
  if (stackCodeMatch) return CONNECT_CODE_BY_NAME.get(stackCodeMatch[1] as string)
  const loweredTexts = errorTextsOf(failure).map(errorText => errorText.toLowerCase())
  if (loweredTexts.some(errorText => errorText.includes("user aborted request"))) return Code.Aborted
  if (loweredTexts.some(errorText => errorText === "canceled" || errorText.includes("request canceled") || errorText.includes("request cancelled"))) return Code.Canceled
  return undefined
}

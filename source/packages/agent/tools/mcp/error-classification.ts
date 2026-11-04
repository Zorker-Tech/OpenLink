import { ToolErrorClassification } from "../tool-errors.ts"

const JSON_RPC_ERROR_CODE = /MCP error\s*(-\d+):/i

const AUTH_FAILURE_FRAGMENTS = [
  "requires authentication",
  "invalid refresh token",
  "invalid_grant",
  "unauthorized",
  "authentication failed",
  "oauth token exchange failed",
  "oauth token refresh failed",
  "authentication timed out",
  "authentication required",
  "not authenticated",
  "bad credentials",
  "credential error",
  "invalid_token",
  "invalid token",
  "token is expired",
  "token was revoked",
]

const ENVIRONMENT_FAILURE_FRAGMENTS = [
  "connection closed",
  "econnrefused",
  "econnreset",
  "enotfound",
  "ehostunreach",
  "enetunreach",
  "epipe",
  "enoent",
  "no local mcp resource executor is configured",
  "unsupported operation:",
  "unsupported exec:",
  "unsupported slate exec request",
  "did not advertise",
  "failed to reinitialize mcp session",
]

const TIMEOUT_FAILURE_FRAGMENTS = ["connection timed out after", "etimedout"]

function includesAny(message: string, fragments: readonly string[]): boolean {
  return fragments.some(fragment => message.includes(fragment))
}

function errorCode(message: string): number | undefined {
  const match = JSON_RPC_ERROR_CODE.exec(message)
  if (match?.[1] === undefined) return undefined
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function classifyMcpErrorMessage(
  errorMessage: string,
): ToolErrorClassification | undefined {
  const message = errorMessage.toLowerCase()
  if (includesAny(message, AUTH_FAILURE_FRAGMENTS) || /\b401\b/.test(message)) {
    return ToolErrorClassification.MCP_AUTH_ERROR
  }
  const parsedCode = errorCode(errorMessage)
  switch (parsedCode) {
    case -32700:
    case -32600:
    case -32602:
      return ToolErrorClassification.INVALID_ARGS
    case -32601:
      return ToolErrorClassification.UNEXPECTED_ENVIRONMENT
    case -32001:
      return ToolErrorClassification.TIMEOUT
  }
  if (includesAny(message, TIMEOUT_FAILURE_FRAGMENTS)) {
    return ToolErrorClassification.TIMEOUT
  }
  if (includesAny(message, ENVIRONMENT_FAILURE_FRAGMENTS)) {
    return ToolErrorClassification.UNEXPECTED_ENVIRONMENT
  }
  return parsedCode === undefined ? undefined : ToolErrorClassification.OTHER_ERROR
}

import { findSystemErrno } from "../shared/system-errno.ts"
import type { GatewayFailureClassification, GatewayFailureReason } from "./gateway-error-contracts.ts"

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
])

function causeChainHasTimeoutName(error: unknown): boolean {
  const seen = new Set<object>()
  let current = error

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const node = current as { name?: unknown; cause?: unknown }
    if (typeof node.name === "string" && (node.name === "AbortError" || /TimeoutError$/.test(node.name))) return true
    current = node.cause
  }
  return false
}

function gatewayFailureReason(error: unknown, errno: string | undefined): GatewayFailureReason {
  const node = error as { name?: string; outcome?: string } | null
  if (node?.name === "BoxDaemonUnreachableError") {
    return node.outcome === "refused" ? "daemon_refused" : node.outcome === "timeout" ? "daemon_timeout" : "daemon_crash"
  }
  if (node?.name === "BoxNoMonitorAvailableError") return "no_monitor"
  if (errno === "ECONNREFUSED") return "refused"
  if (errno === "ENOTFOUND" || errno === "EAI_AGAIN") return "dns"
  if (errno === "ETIMEDOUT" || causeChainHasTimeoutName(error)) return "timeout"
  if (errno != null && RETRYABLE_NETWORK_CODES.has(errno)) return "network"
  return "application"
}

/** Reduces nested runtime errors to the stable reason code the gateway reports. */
export function classifyGatewayFailure(error: unknown): GatewayFailureClassification {
  const errorClass = error instanceof Error ? error.name || "Error" : "unknown"
  const errno = findSystemErrno(error)
  return { reason: gatewayFailureReason(error, errno), errorClass, errno }
}

import { parseRetryAfterHeaderMs } from "../retry-after.ts"

export const SLATE_RPC_INVALID_ARGUMENT = 3
export const SLATE_RPC_DEADLINE_EXCEEDED = 4
export const SLATE_RPC_RESOURCE_EXHAUSTED = 8
export const SLATE_RPC_UNAVAILABLE = 14

interface RemoteRpcFailure {
  readonly code: number
  readonly metadata?: { get(name: string): string | null } | undefined
}

function hasRemoteRpcCode(error: unknown): error is RemoteRpcFailure {
  return typeof error === "object" &&
    error !== null &&
    typeof (error as { readonly code?: unknown }).code === "number"
}

export function isSlateRateLimitError(error: unknown): boolean {
  return hasRemoteRpcCode(error) && error.code === SLATE_RPC_RESOURCE_EXHAUSTED
}

export function isSlateInvalidArgumentError(error: unknown): boolean {
  return hasRemoteRpcCode(error) && error.code === SLATE_RPC_INVALID_ARGUMENT
}

export function isSlateDeadlineExceededError(error: unknown): boolean {
  return hasRemoteRpcCode(error) && error.code === SLATE_RPC_DEADLINE_EXCEEDED
}

export function isSlateTransientRemoteError(error: unknown): boolean {
  if (!hasRemoteRpcCode(error)) return false
  return error.code === SLATE_RPC_UNAVAILABLE ||
    error.code === SLATE_RPC_DEADLINE_EXCEEDED ||
    error.code === SLATE_RPC_RESOURCE_EXHAUSTED
}

export function getSlateRetryAfterMs(error: unknown, nowMs = Date.now()): number | undefined {
  if (!hasRemoteRpcCode(error)) return undefined
  return parseRetryAfterHeaderMs(error.metadata?.get("retry-after"), nowMs)
}

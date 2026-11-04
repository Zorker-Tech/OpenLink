import {
  SLATE_RPC_DEADLINE_EXCEEDED,
  SLATE_RPC_INVALID_ARGUMENT,
  SLATE_RPC_RESOURCE_EXHAUSTED,
  SLATE_RPC_UNAVAILABLE,
  getSlateRetryAfterMs,
  isSlateDeadlineExceededError,
  isSlateInvalidArgumentError,
  isSlateRateLimitError,
  isSlateTransientRemoteError,
} from "../../../shared/network/remote-rpc-error.ts"

export const CONNECT_CODE_INVALID_ARGUMENT = SLATE_RPC_INVALID_ARGUMENT
export const CONNECT_CODE_DEADLINE_EXCEEDED = SLATE_RPC_DEADLINE_EXCEEDED
export const CONNECT_CODE_RESOURCE_EXHAUSTED = SLATE_RPC_RESOURCE_EXHAUSTED
export const CONNECT_CODE_UNAVAILABLE = SLATE_RPC_UNAVAILABLE
export const isRateLimitConnectError = isSlateRateLimitError
export const isInvalidArgumentConnectError = isSlateInvalidArgumentError
export const isDeadlineExceededConnectError = isSlateDeadlineExceededError
export const isTransientConnectError = isSlateTransientRemoteError
export const getConnectRetryAfterMs = getSlateRetryAfterMs

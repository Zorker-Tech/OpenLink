/**
 * Turning a failed call to the backend into something a caller can act on.
 *
 * The transport's error code, the details the backend attached and the kind of blob access that failed are read
 * together, so a caller is told whether to retry, re-authorize or stop.
 */
import { Code } from "@connectrpc/connect";

import { ErrorDetails, ErrorDetails_Error } from "../proto/generated/aiserver/v1/utils_pb.ts";
import { findBlobNotFoundError } from "../agent-kv/blob-not-found-error.ts";

export interface AgentErrorDisplayInfo {
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly isRetryable?: boolean | undefined;
  readonly connectCode?: number | undefined;
  readonly errorCode?: ErrorDetails_Error | undefined;
  readonly inferenceRequestErrorType?: string | undefined;
  readonly errorDetails?: ErrorDetails | undefined;
}

export interface AgentErrorOptions {
  readonly cause?: unknown;
  readonly requestId?: string | undefined;
  readonly displayInfo?: AgentErrorDisplayInfo | undefined;
  readonly isTransport?: boolean | undefined;
}

export class AgentError extends Error {
  override readonly cause: unknown;
  readonly requestId: string | undefined;
  readonly displayInfo: AgentErrorDisplayInfo | undefined;
  readonly isTransport: boolean | undefined;

  constructor(message: string, settings: AgentErrorOptions = {}) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.cause = settings.cause;
    this.requestId = settings.requestId;
    this.displayInfo = settings.displayInfo;
    this.isTransport = settings.isTransport;
  }

  override get name(): string {
    return (this as AgentError & { readonly kind?: string }).kind as string;
  }
}

export class RetriableError extends AgentError {
  protected get kind(): string {
    return "RetriableError";
  }
}

export class ActionRequiredError extends AgentError {
  readonly action: string;

  constructor(message: string, action: string, settings: AgentErrorOptions = {}) {
    super(message, settings);
    this.action = action;
  }

  protected get kind(): string {
    return "ActionRequiredError";
  }
}

export class NonRetriableError extends AgentError {
  protected get kind(): string {
    return "NonRetriableError";
  }
}

export class CancelledError extends AgentError {
  protected get kind(): string {
    return "CancelledError";
  }
}

const AUTH_ERROR_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.NOT_LOGGED_IN,
  ErrorDetails_Error.AGENT_REQUIRES_LOGIN,
  ErrorDetails_Error.AUTH_TOKEN_NOT_FOUND,
  ErrorDetails_Error.AUTH_TOKEN_EXPIRED,
  ErrorDetails_Error.INVALID_AUTH_ID,
  ErrorDetails_Error.UNAUTHORIZED,
  ErrorDetails_Error.GITHUB_NO_USER_CREDENTIALS,
  ErrorDetails_Error.GITHUB_USER_NO_ACCESS,
]);
const PLAN_ERROR_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.FREE_USER_USAGE_LIMIT,
  ErrorDetails_Error.FREE_USER_RATE_LIMIT_EXCEEDED,
  ErrorDetails_Error.PRO_USER_ONLY,
  ErrorDetails_Error.PRO_USER_USAGE_LIMIT,
  ErrorDetails_Error.PRO_USER_RATE_LIMIT_EXCEEDED,
  ErrorDetails_Error.RATE_LIMITED,
  ErrorDetails_Error.RATE_LIMITED_CHANGEABLE,
  ErrorDetails_Error.GENERIC_RATE_LIMIT_EXCEEDED,
]);
const BILLING_ERROR_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.USAGE_PRICING_REQUIRED,
  ErrorDetails_Error.USAGE_PRICING_REQUIRED_CHANGEABLE,
]);
const SETUP_ERROR_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.BAD_API_KEY,
  ErrorDetails_Error.BAD_USER_API_KEY,
  ErrorDetails_Error.OUTDATED_CLIENT,
]);
const ABORT_ERROR_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.USER_ABORTED_REQUEST,
  ErrorDetails_Error.DEBOUNCED,
]);
const CUSTOM_MESSAGE_CODES = new Set<ErrorDetails_Error>([ErrorDetails_Error.CUSTOM_MESSAGE]);
const TRANSPORT_PATTERNS = [
  "NGHTTP2",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "socket hang up",
  "Premature close",
  "ERR_STREAM",
  "protocol error",
  "http/2 stream",
  "ERR_HTTP2_SESSION_ERROR",
  "Session closed with error code",
  "connection aborted",
] as const;
const NETWORK_ERRNO_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "ESERVFAIL",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
]);
const NETWORK_ERRNO_RE = new RegExp(`\\b(${[...NETWORK_ERRNO_CODES].join("|")})\\b`);
const INFERENCE_REQUEST_ERROR_TYPE_HEADER = "x-cursor-inference-request-error-type";

interface ConnectErrorLike {
  readonly name: string;
  readonly code: number;
  readonly message: string;
  readonly metadata: { get(name: string): string | null };
  readonly cause?: unknown;
  findDetails(type: typeof ErrorDetails): readonly ErrorDetails[];
}

export function classifyError(failure: unknown, settings: { readonly requestId?: string } = {}): AgentError {
  const { requestId } = settings;
  if (failure instanceof AgentError) return failure;
  if (looksLikeConnectError(failure)) return mapConnectError(failure, requestId);
  const blobNotFound = findBlobNotFoundError(failure);
  if (blobNotFound !== undefined) {
    return new NonRetriableError(blobNotFound.message, {
      cause: failure instanceof Error ? failure : undefined,
      requestId,
      displayInfo: {
        title: "Conversation data missing",
        detail: blobNotFound.message,
        isRetryable: false,
      },
    });
  }
  if (failure instanceof Error) {
    if (failure.name === "AbortError") return new CancelledError(failure.message, { cause: failure, requestId });
    if (hasTransportPattern(failure)) return new RetriableError(failure.message, { cause: failure, requestId });
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  return new RetriableError(message, { cause: failure instanceof Error ? failure : undefined, requestId });
}

function looksLikeConnectError(failure: unknown): failure is ConnectErrorLike {
  return failure !== null && typeof failure === "object" && "code" in failure && "name" in failure && failure.name === "ConnectError";
}

function mapConnectError(failure: ConnectErrorLike, requestId: string | undefined): AgentError {
  const errorDetail = readErrorDetails(failure);
  const displayInfo: AgentErrorDisplayInfo = {
    title: errorDetail?.details?.title,
    detail: errorDetail?.details?.detail,
    isRetryable: errorDetail?.details?.isRetryable,
    connectCode: failure.code,
    errorCode: errorDetail?.error,
    inferenceRequestErrorType: failure.metadata.get(INFERENCE_REQUEST_ERROR_TYPE_HEADER) ?? undefined,
    errorDetails: errorDetail,
  };
  const settings: AgentErrorOptions = { cause: failure, requestId, displayInfo };
  if (failure.code === Code.Canceled || failure.code === Code.Aborted) {
    if (hasTransportPattern(failure)) return new RetriableError(failure.message, settings);
    return new CancelledError(failure.message, settings);
  }
  if (errorDetail?.error !== undefined) {
    const reasonCode = errorDetail.error;
    if (ABORT_ERROR_CODES.has(reasonCode)) return new CancelledError(combinedMessage(failure, errorDetail), settings);
    const backendAction = errorDetail.details?.analyticsMetadata?.actionRequired;
    if (backendAction !== undefined && backendAction !== "") return new ActionRequiredError(combinedMessage(failure, errorDetail), backendAction, settings);
    if (AUTH_ERROR_CODES.has(reasonCode)) return new ActionRequiredError(combinedMessage(failure, errorDetail), "login", settings);
    if (PLAN_ERROR_CODES.has(reasonCode)) return new ActionRequiredError(combinedMessage(failure, errorDetail), "upgrade", settings);
    if (BILLING_ERROR_CODES.has(reasonCode)) return new ActionRequiredError(combinedMessage(failure, errorDetail), "payment", settings);
    if (SETUP_ERROR_CODES.has(reasonCode)) return new ActionRequiredError(combinedMessage(failure, errorDetail), "config", settings);
    if (CUSTOM_MESSAGE_CODES.has(reasonCode) && errorDetail.details?.isRetryable !== true) return new NonRetriableError(combinedMessage(failure, errorDetail), settings);
    if (errorDetail.details?.isRetryable === false) return new NonRetriableError(combinedMessage(failure, errorDetail), settings);
  }
  if (failure.code === Code.Unauthenticated) return new ActionRequiredError(failure.message, "login", settings);
  return new RetriableError(failure.message, settings);
}

function readErrorDetails(failure: ConnectErrorLike): ErrorDetails | undefined {
  const errorDetail = failure.findDetails(ErrorDetails);
  if (errorDetail.length > 0) return errorDetail[0];
  try {
    const cause = failure.cause;
    if (cause !== null && typeof cause === "object" && "findDetails" in cause && typeof cause.findDetails === "function") {
      const causeDetails = cause.findDetails(ErrorDetails) as readonly ErrorDetails[];
      return causeDetails[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function combinedMessage(failure: ConnectErrorLike, errorDetail: ErrorDetails | undefined): string {
  if (errorDetail?.details !== undefined) {
    const { title, detail } = errorDetail.details;
    if (title && detail) return `${title} ${detail}`;
    return title || detail || failure.message;
  }
  return failure.message;
}

function hasTransportPattern(failure: Error | ConnectErrorLike): boolean {
  const visited = new Set<Error>();
  let current: unknown = failure;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const errorText = `${current.name}: ${current.message}`;
    if (TRANSPORT_PATTERNS.some((transportFragment) => errorText.includes(transportFragment)) || NETWORK_ERRNO_RE.test(errorText)) return true;
    const codeValue = (current as Error & { readonly code?: unknown }).code;
    if (typeof codeValue === "string" && (TRANSPORT_PATTERNS.some((transportFragment) => codeValue.includes(transportFragment)) || NETWORK_ERRNO_CODES.has(codeValue))) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Turning a failed call to the backend into something a caller can act on.
 *
 * The transport's error code, the details the backend attached and the kind of blob access that failed are read
 * together, so a caller is told whether to retry, re-authorize or stop.
 */
import {
  projectAgentTransportDisposition,
  readInteropAgentErrorContext,
} from "../../adapters/interop/agent/agent-error-details-adapter.ts";
import { findBlobNotFoundError } from "../agent-kv/blob-not-found-error.ts";
import type { AgentErrorCode, AgentErrorDetails } from "./error-contract.ts";

export type { AgentErrorCode, AgentErrorDetails } from "./error-contract.ts";

export interface AgentErrorDisplayInfo {
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly isRetryable?: boolean | undefined;
  readonly connectCode?: number | undefined;
  readonly errorCode?: AgentErrorCode | undefined;
  readonly inferenceRequestErrorType?: string | undefined;
  readonly errorDetails?: AgentErrorDetails | undefined;
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

interface ConnectErrorLike {
  readonly name: string;
  readonly code: number;
  readonly message: string;
  readonly metadata: { get(name: string): string | null };
  readonly cause?: unknown;
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
  const interop = readInteropAgentErrorContext(failure);
  const errorDetail = interop.details;
  const displayInfo: AgentErrorDisplayInfo = {
    title: errorDetail?.title,
    detail: errorDetail?.detail,
    isRetryable: errorDetail?.isRetryable,
    connectCode: failure.code,
    errorCode: errorDetail?.code,
    inferenceRequestErrorType: interop.inferenceRequestErrorType,
    errorDetails: errorDetail,
  };
  const settings: AgentErrorOptions = { cause: failure, requestId, displayInfo };
  const transportDisposition = projectAgentTransportDisposition(failure.code);
  if (transportDisposition === "cancelled" || transportDisposition === "aborted") {
    if (hasTransportPattern(failure)) return new RetriableError(failure.message, settings);
    return new CancelledError(failure.message, settings);
  }
  if (errorDetail !== undefined) {
    if (errorDetail.code === "cancelled") return new CancelledError(combinedMessage(failure, errorDetail), settings);
    const backendAction = errorDetail.actionRequired;
    if (backendAction !== undefined && backendAction !== "") return new ActionRequiredError(combinedMessage(failure, errorDetail), backendAction, settings);
    if (errorDetail.code === "authentication") return new ActionRequiredError(combinedMessage(failure, errorDetail), "login", settings);
    if (errorDetail.code === "usage-limit") return new ActionRequiredError(combinedMessage(failure, errorDetail), "upgrade", settings);
    if (errorDetail.code === "payment-required") return new ActionRequiredError(combinedMessage(failure, errorDetail), "payment", settings);
    if (errorDetail.code === "configuration-required") return new ActionRequiredError(combinedMessage(failure, errorDetail), "config", settings);
    if (errorDetail.code === "custom-message" && errorDetail.isRetryable !== true) return new NonRetriableError(combinedMessage(failure, errorDetail), settings);
    if (errorDetail.isRetryable === false) return new NonRetriableError(combinedMessage(failure, errorDetail), settings);
  }
  if (transportDisposition === "unauthenticated") return new ActionRequiredError(failure.message, "login", settings);
  return new RetriableError(failure.message, settings);
}

function combinedMessage(failure: ConnectErrorLike, errorDetail: AgentErrorDetails | undefined): string {
  if (errorDetail?.title !== undefined || errorDetail?.detail !== undefined) {
    const { title, detail } = errorDetail;
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

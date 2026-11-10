import { Code, ConnectError } from "@connectrpc/connect";

import { ErrorDetails, ErrorDetails_Error } from "../proto/generated/aiserver/v1/utils_pb.ts";
import type { AgentErrorCode, AgentErrorDetails } from "../../../packages/agent-client/error-contract.ts";

const INFERENCE_FAILURE_HEADER = "x-slate-backend-client-request-error-type";

const CATEGORY_CODES: ReadonlyArray<readonly [AgentErrorCode, readonly number[]]> = [
  ["authentication", [2, 18, 11, 12, 3, 38, 46, 47]],
  ["usage-limit", [9, 7, 23, 10, 8, 50, 51, 22]],
  ["payment-required", [44, 45]],
  ["configuration-required", [1, 42, 30]],
  ["cancelled", [21, 35]],
  ["custom-message", [29]],
];

const categoryByWireCode = new Map<number, AgentErrorCode>(
  CATEGORY_CODES.flatMap(([category, codes]) => codes.map((code) => [code, category] as const)),
);

export interface InteropAgentErrorContext {
  readonly details?: AgentErrorDetails | undefined;
  readonly inferenceRequestErrorType?: string | undefined;
}

export interface InteropErrorDetailText {
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
}

export type AgentTransportDisposition = "cancelled" | "aborted" | "unauthenticated" | "other";

export function projectAgentTransportDisposition(code: number): AgentTransportDisposition {
  if (code === Code.Canceled) return "cancelled";
  if (code === Code.Aborted) return "aborted";
  if (code === Code.Unauthenticated) return "unauthenticated";
  return "other";
}

export function projectAgentErrorDetails(wireDetails: ErrorDetails): AgentErrorDetails {
  const copy = wireDetails.details;
  return {
    code: categoryByWireCode.get(wireDetails.error) ?? "other",
    title: copy?.title,
    detail: copy?.detail,
    isRetryable: copy?.isRetryable,
    actionRequired: copy?.analyticsMetadata?.actionRequired,
    expected: wireDetails.isExpected,
  };
}

export function readInteropAgentErrorContext(failure: unknown): InteropAgentErrorContext {
  const wireDetails = firstWireDetails(failure);
  let selected = wireDetails;
  if (selected === undefined) {
    try {
      selected = firstWireDetails(readCause(failure));
    } catch {
      selected = undefined;
    }
  }

  return {
    details: selected === undefined ? undefined : projectAgentErrorDetails(selected),
    inferenceRequestErrorType: readInferenceFailureType(failure),
  };
}

/** Text that Slate's error classifier may inspect, without exposing the generated detail message. */
export function readInteropErrorDetailTexts(source: unknown): readonly InteropErrorDetailText[] {
  return wireDetailsOf(source).map(wire => ({
    ...(wire.details?.title === undefined ? {} : { title: wire.details.title }),
    ...(wire.details?.detail === undefined ? {} : { detail: wire.details.detail }),
  }));
}

/** Whether a remote transport error carries the counterpart's extension-host timeout marker. */
export function hasInteropExtensionHostTimeoutMarker(source: unknown): boolean {
  return wireDetailsOf(source).some(wire => wire.error === ErrorDetails_Error.EXTENSION_HOST_TIMEOUT);
}

/** Construct the transport error used to recover from a stream that never started. */
export function createInteropExtensionHostTimeoutError(input: {
  readonly title: string;
  readonly detail: string;
  readonly cause?: Error | undefined;
}): ConnectError {
  return new ConnectError(input.title, Code.DeadlineExceeded, undefined, [
    new ErrorDetails({
      error: ErrorDetails_Error.EXTENSION_HOST_TIMEOUT,
      details: {
        title: input.title,
        detail: input.detail,
        isRetryable: false,
        shouldShowImmediateError: true,
      },
    }),
  ], input.cause);
}

function firstWireDetails(source: unknown): ErrorDetails | undefined {
  return wireDetailsOf(source)[0];
}

function wireDetailsOf(source: unknown): readonly ErrorDetails[] {
  if (!isRecord(source) || typeof source.findDetails !== "function") return [];
  const findDetails = source.findDetails as (type: typeof ErrorDetails) => readonly ErrorDetails[];
  return findDetails.call(source, ErrorDetails);
}

function readCause(source: unknown): unknown {
  return isRecord(source) ? source.cause : undefined;
}

function readInferenceFailureType(source: unknown): string | undefined {
  if (!isRecord(source) || !isRecord(source.metadata) || typeof source.metadata.get !== "function") return undefined;
  const get = source.metadata.get as (name: string) => unknown;
  const value = get.call(source.metadata, INFERENCE_FAILURE_HEADER);
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

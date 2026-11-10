import {
  RequestContextArgs,
  type RequestContext as GeneratedRequestContext,
  type RequestContextResult as GeneratedRequestContextResult,
} from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import {
  fromRedactedRequestContext as decodeGeneratedRequestContext,
  toRedactedRequestContext as encodeGeneratedRequestContext,
} from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"

export type InteropRequestContext = GeneratedRequestContext
export type InteropRequestContextArgs = RequestContextArgs
export type InteropRequestContextResult = GeneratedRequestContextResult
export type RedactedRequestContext = Parameters<typeof decodeGeneratedRequestContext>[0]

export type RequestContextResultProjection =
  | { readonly kind: "available"; readonly requestContext: InteropRequestContext }
  | { readonly kind: "unavailable" }

export function createRequestContextArgs(notesSessionId: string | undefined): InteropRequestContextArgs {
  return notesSessionId === undefined ? new RequestContextArgs() : new RequestContextArgs({ notesSessionId })
}

export function projectRequestContextResult(result: InteropRequestContextResult): RequestContextResultProjection {
  if (result.result.case !== "success") return { kind: "unavailable" }
  const requestContext = result.result.value.requestContext
  return requestContext === undefined ? { kind: "unavailable" } : { kind: "available", requestContext }
}

export function decodeRedactedRequestContext(value: RedactedRequestContext): InteropRequestContext {
  return (decodeGeneratedRequestContext as unknown as (
    message: RedactedRequestContext,
    capability: PrivacyCapability,
    options?: unknown,
  ) => InteropRequestContext)(value, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
}

export function encodeRedactedRequestContext(
  value: InteropRequestContext,
  prior: RedactedRequestContext | undefined,
): RedactedRequestContext {
  return encodeGeneratedRequestContext(value, prior?._privacyMode ?? PrivacyMode.UNSPECIFIED)
}

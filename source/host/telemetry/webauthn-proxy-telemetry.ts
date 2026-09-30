/** What the security-key proxy did, in the shape the telemetry backend takes. */
import { brandedEnumOf } from "../../shared/errors/bounded-values.ts";
import {
  SlateError,
  slateErrorTags,
  type SlateErrorValue,
} from "../../shared/errors/registry.ts";
import { WEBAUTHN_SIGN_ERROR_CLASSES } from "../../shared/observability/telemetry-events.ts";

export { WEBAUTHN_SIGN_ERROR_CLASSES };

export const WEBAUTHN_PROXY_EVENT = "slate.webauthn_proxy";
export const KNOWN_DOM_ERROR_NAMES = [
  "NotAllowedError",
  "InvalidStateError",
  "NotSupportedError",
  "SecurityError",
  "AbortError",
  "ConstraintError",
  "DataError",
  "TimeoutError",
  "NetworkError",
  "OperationError",
  "UnknownError",
] as const;
export const brandedDomError = brandedEnumOf(
    KNOWN_DOM_ERROR_NAMES,
    "OtherError",
  ),
  brandedSignErrorClass = brandedEnumOf(WEBAUTHN_SIGN_ERROR_CLASSES, "other");
export type WebAuthnFailureCause =
  | "no_provider"
  | "provider_stale"
  | "dispatch_failed"
  | "timeout"
  | "consent_declined"
  | "sign_failed"
  | "desktop_failed";

export function causeError(
  cause: WebAuthnFailureCause,
  rawDomErrorName?: string,
  rawSignErrorClass?: string,
): SlateErrorValue {
  switch (cause) {
    case "no_provider":
      return SlateError.webauthnNoProvider();
    case "provider_stale":
      return SlateError.webauthnProviderStale();
    case "dispatch_failed":
      return SlateError.webauthnDispatchFailed();
    case "timeout":
      return SlateError.webauthnCeremonyTimedOut();
    case "consent_declined":
      return SlateError.webauthnConsentDeclined();
    case "sign_failed":
      return SlateError.webauthnSignFailed({
        domError: brandedDomError(rawDomErrorName),
        signErrorClass: brandedSignErrorClass(rawSignErrorClass),
      });
    case "desktop_failed":
      return SlateError.webauthnDesktopFailed({
        domError: brandedDomError(rawDomErrorName),
        signErrorClass: brandedSignErrorClass(rawSignErrorClass),
      });
  }
}

export interface WebAuthnProxyReport {
  outcome: string;
  stage: string;
  originClass: string;
  ceremonyKind: string;
  requestId: string;
  elapsedMs: number;
  providerCount?: number;
  liveProviderCount?: number;
  cause?: WebAuthnFailureCause;
  rawDomErrorName?: string;
  rawSignErrorClass?: string;
}
export function webauthnProxyTelemetry(r: WebAuthnProxyReport) {
  return {
    level: r.outcome === "failed" || r.outcome === "timeout" ? "warn" : "info",
    event: WEBAUTHN_PROXY_EVENT,
    metadata: {
      stage: r.stage,
      outcome: r.outcome,
      origin_class: r.originClass,
      ceremony_kind: r.ceremonyKind,
      request_id: r.requestId,
      elapsed_ms: String(Math.round(r.elapsedMs)),
      provider_count:
        r.providerCount !== undefined ? String(r.providerCount) : undefined,
      live_provider_count:
        r.liveProviderCount !== undefined
          ? String(r.liveProviderCount)
          : undefined,
      ...(r.cause !== undefined
        ? slateErrorTags(
            causeError(r.cause, r.rawDomErrorName, r.rawSignErrorClass),
          )
        : {}),
    },
  };
}

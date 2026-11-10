import { brandedEnumOf } from "../../shared/errors/bounded-values.ts";
import {
  SlateError,
  type SlateErrorValue,
} from "../../shared/errors/registry.ts";
import { WEBAUTHN_SIGN_ERROR_CLASSES } from "../../shared/observability/telemetry-events.ts";
import type { SlateWebAuthnFailureCause } from "./webauthn-proxy-contracts.ts";

export const RECOGNIZED_WEB_AUTHN_DOM_FAILURES = [
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

export const normalizeWebAuthnDomFailure = brandedEnumOf(
  RECOGNIZED_WEB_AUTHN_DOM_FAILURES,
  "OtherError",
);
export const normalizeWebAuthnSignFailure = brandedEnumOf(
  WEBAUTHN_SIGN_ERROR_CLASSES,
  "other",
);

export function registeredWebAuthnFailure(
  reason: SlateWebAuthnFailureCause,
  domErrorName?: string,
  signErrorClass?: string,
): SlateErrorValue {
  switch (reason) {
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
        domError: normalizeWebAuthnDomFailure(domErrorName),
        signErrorClass: normalizeWebAuthnSignFailure(signErrorClass),
      });
    case "desktop_failed":
      return SlateError.webauthnDesktopFailed({
        domError: normalizeWebAuthnDomFailure(domErrorName),
        signErrorClass: normalizeWebAuthnSignFailure(signErrorClass),
      });
  }
}

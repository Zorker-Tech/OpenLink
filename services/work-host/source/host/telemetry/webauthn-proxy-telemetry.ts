export {
  type SlateWebAuthnFailureCause as WebAuthnFailureCause,
  type SlateWebAuthnObservation as WebAuthnProxyReport,
  type SlateWebAuthnTelemetryEntry,
} from "./webauthn-proxy-contracts.ts";
export {
  RECOGNIZED_WEB_AUTHN_DOM_FAILURES as KNOWN_DOM_ERROR_NAMES,
  normalizeWebAuthnDomFailure as brandedDomError,
  normalizeWebAuthnSignFailure as brandedSignErrorClass,
  registeredWebAuthnFailure as causeError,
} from "./webauthn-proxy-error-policy.ts";
export { WEBAUTHN_SIGN_ERROR_CLASSES } from "../../shared/observability/telemetry-events.ts";
export { WEBAUTHN_PROXY_EVENT } from "../../shared/observability/telemetry-events.ts";
export { projectWebAuthnProxyObservation as webauthnProxyTelemetry } from "./webauthn-proxy-projection.ts";

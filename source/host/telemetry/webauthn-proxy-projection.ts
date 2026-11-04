import { slateErrorTags } from "../../shared/errors/registry.ts";
import { WEBAUTHN_PROXY_EVENT } from "../../shared/observability/telemetry-events.ts";
import type {
  SlateWebAuthnObservation,
  SlateWebAuthnTelemetryEntry,
} from "./webauthn-proxy-contracts.ts";
import { registeredWebAuthnFailure } from "./webauthn-proxy-error-policy.ts";

const roundedText = (value: number): string => String(Math.round(value));
const optionalCountText = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

export function projectWebAuthnProxyObservation(
  observation: SlateWebAuthnObservation,
): SlateWebAuthnTelemetryEntry {
  const { outcome, cause, rawDomErrorName, rawSignErrorClass } = observation;
  return {
    level: outcome === "failed" || outcome === "timeout" ? "warn" : "info",
    event: WEBAUTHN_PROXY_EVENT,
    metadata: {
      stage: observation.stage,
      outcome,
      origin_class: observation.originClass,
      ceremony_kind: observation.ceremonyKind,
      request_id: observation.requestId,
      elapsed_ms: roundedText(observation.elapsedMs),
      provider_count: optionalCountText(observation.providerCount),
      live_provider_count: optionalCountText(observation.liveProviderCount),
      ...(cause === undefined
        ? {}
        : slateErrorTags(
            registeredWebAuthnFailure(cause, rawDomErrorName, rawSignErrorClass),
          )),
    },
  };
}

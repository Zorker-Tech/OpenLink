/** The security-key proxy as a host extension: the bridge is started from here and stopped with the host. */
import { createDeadlinePolicy, realClock } from "../scheduling.ts";
import { defineHostExtension } from "../host-extensions.ts";
import { SLATE_WEBAUTHN_CEREMONY_TIMEOUT_MS, type WebAuthnCeremony, type WebAuthnResponseFrame } from "../../../shared/webauthn-gateway.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { SlateWebAuthnBridge } from "./webauthn-proxy-bridge.ts";
import { applyWebAuthnProxyMarker } from "./webauthn-proxy-marker.ts";

interface TelemetryDependency { readonly logs: { readonly reportWebAuthnProxy: (report: Record<string, unknown>) => void } }

export const webauthnProxyExtension = defineHostExtension({
  id: HostExtensions.WebauthnProxy,
  dependencies: [HostExtensions.Telemetry],
  start: (context) => {
    const telemetry = context.deps[HostExtensions.Telemetry] as TelemetryDependency;
    const bridge = new SlateWebAuthnBridge({
      clock: realClock,
      ceremonyDeadline: createDeadlinePolicy(realClock, { name: "slate-webauthn-ceremony", timeoutMs: SLATE_WEBAUTHN_CEREMONY_TIMEOUT_MS }),
      report: (report) => telemetry.logs.reportWebAuthnProxy(report)
    });
    return {
      requestCeremony: (ceremony: WebAuthnCeremony) => bridge.requestCeremony(ceremony),
      registerProvider: (send: Parameters<typeof bridge.registerProvider>[0]) => bridge.registerProvider(send),
      submitResponses: (batch: { providerId?: string; frames: readonly WebAuthnResponseFrame[] }) => bridge.submitResponses(batch),
      applyEnablement: (enabled: boolean) => applyWebAuthnProxyMarker(enabled)
    };
  }
});


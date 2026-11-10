/** The host-owned entrypoint for security-key ceremonies initiated by a box browser. */
import { createDeadlinePolicy, realClock } from "../scheduling.ts";
import { defineHostExtension } from "../host-extensions.ts";
import { SLATE_WEBAUTHN_CEREMONY_TIMEOUT_MS } from "../../../shared/webauthn-gateway.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { SlateWebAuthnBridge, type SlateWebAuthnBridgeDependencies } from "./webauthn-proxy-bridge.ts";
import { applyWebAuthnProxyMarker } from "./webauthn-proxy-marker.ts";

type CeremonyBridge = Pick<SlateWebAuthnBridge, "requestCeremony" | "registerProvider" | "submitResponses">;

export interface WebauthnProxyExtensionServices {
  createBridge(report: SlateWebAuthnBridgeDependencies["report"]): CeremonyBridge;
  applyEnablement(enabled: boolean): ReturnType<typeof applyWebAuthnProxyMarker>;
}

export type WebauthnProxyExtensionApi = CeremonyBridge & {
  applyEnablement(enabled: boolean): ReturnType<typeof applyWebAuthnProxyMarker>;
};

interface TelemetryDependency {
  readonly logs: {
    readonly reportWebAuthnProxy: SlateWebAuthnBridgeDependencies["report"];
  };
}

function makeProductionBridge(report: SlateWebAuthnBridgeDependencies["report"]): CeremonyBridge {
  return new SlateWebAuthnBridge({
    clock: realClock,
    ceremonyDeadline: createDeadlinePolicy(realClock, {
      name: "slate-webauthn-ceremony",
      timeoutMs: SLATE_WEBAUTHN_CEREMONY_TIMEOUT_MS,
    }),
    report,
  });
}

const productionServices: WebauthnProxyExtensionServices = Object.freeze({
  createBridge: makeProductionBridge,
  applyEnablement: (enabled: boolean) => applyWebAuthnProxyMarker(enabled),
});

export function createWebauthnProxyExtension(
  services: WebauthnProxyExtensionServices = productionServices,
) {
  return defineHostExtension<WebauthnProxyExtensionApi>({
    id: HostExtensions.WebauthnProxy,
    dependencies: [HostExtensions.Telemetry],
    start: ({ deps }) => {
      const telemetry = deps[HostExtensions.Telemetry] as TelemetryDependency;
      const bridge = services.createBridge((report) => telemetry.logs.reportWebAuthnProxy(report));
      return {
        requestCeremony: (ceremony) => bridge.requestCeremony(ceremony),
        registerProvider: (send) => bridge.registerProvider(send),
        submitResponses: (batch) => bridge.submitResponses(batch),
        applyEnablement: (enabled) => services.applyEnablement(enabled),
      };
    },
  });
}

export const webauthnProxyExtension = createWebauthnProxyExtension();

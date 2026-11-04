import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import {
  createWebauthnProxyExtension,
  webauthnProxyExtension,
  type WebauthnProxyExtensionServices,
} from "../../source/host/extensions/webauthn-proxy/extension.ts";
import type {
  WebAuthnCeremony,
  WebAuthnRequestFrame,
  WebAuthnResponseFrame,
} from "../../source/shared/webauthn-gateway.ts";

describe("security-key host extension declaration", () => {
  it("is registered under its own id and waits for telemetry before starting", () => {
    assert.equal(webauthnProxyExtension.kind, "host-extension");
    assert.equal(webauthnProxyExtension.id, HostExtensions.WebauthnProxy);
    assert.deepEqual(webauthnProxyExtension.dependencies, [HostExtensions.Telemetry]);
    assert.equal(typeof webauthnProxyExtension.start, "function");
  });

  it("keeps the declaration and dependency order immutable", () => {
    assert.equal(Object.isFrozen(webauthnProxyExtension), true);
    assert.equal(Object.isFrozen(webauthnProxyExtension.dependencies), true);
  });

  it("connects the bridge, telemetry sink and enablement port", async () => {
    const ceremonies: WebAuthnCeremony[] = [];
    const providers: Array<(frame: WebAuthnRequestFrame) => void> = [];
    const responseBatches: Array<{ readonly providerId?: string; readonly frames: readonly WebAuthnResponseFrame[] }> = [];
    const reports: Array<Record<string, unknown>> = [];
    const enablementChanges: boolean[] = [];
    let reportFromBridge: ((fields: Record<string, unknown>) => void) | undefined;

    const services: WebauthnProxyExtensionServices = {
      createBridge(report) {
        reportFromBridge = report;
        return {
          async requestCeremony(ceremony) {
            ceremonies.push(ceremony);
            return { ok: true, credentialJson: { id: "credential-1" } };
          },
          registerProvider(send) {
            providers.push(send);
            return () => {};
          },
          submitResponses(batch) {
            responseBatches.push(batch);
          },
        };
      },
      applyEnablement(enabled) {
        enablementChanges.push(enabled);
        return "applied";
      },
    };
    const extension = createWebauthnProxyExtension(services);
    const api = await extension.start({
      deps: {
        [HostExtensions.Telemetry]: {
          logs: { reportWebAuthnProxy: (report: Record<string, unknown>) => reports.push(report) },
        },
      },
      host: {},
      onStop: () => {},
    });

    const ceremony: WebAuthnCeremony = {
      kind: "get",
      origin: "https://login.example.test",
      challenge: "challenge-1",
    };
    assert.deepEqual(await api.requestCeremony(ceremony), {
      ok: true,
      credentialJson: { id: "credential-1" },
    });
    assert.equal(ceremonies[0], ceremony);

    const send = (_frame: WebAuthnRequestFrame) => {};
    assert.equal(typeof api.registerProvider(send), "function");
    assert.equal(providers[0], send);

    const batch = { providerId: "provider-1", frames: [{ kind: "ping" }] as const };
    api.submitResponses(batch);
    assert.equal(responseBatches[0], batch);

    assert.equal(api.applyEnablement(true), "applied");
    assert.deepEqual(enablementChanges, [true]);

    const diagnostic = { stage: "request", requestId: "request-1", ceremonyKind: "get" };
    reportFromBridge?.(diagnostic);
    assert.deepEqual(reports, [diagnostic]);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_NO_WEBAUTHN_MACHINE_MESSAGE,
  SLATE_WEBAUTHN_LIVENESS_WINDOW_MS,
  SLATE_WEBAUTHN_MACHINE_UNAVAILABLE_MESSAGE,
  type WebAuthnRequestFrame,
  type WebAuthnResponseFrame,
} from "../../source/shared/webauthn-gateway.ts";
import { DeadlineExceededError } from "../../source/host/extensions/scheduling.ts";
import {
  SlateWebAuthnBridge,
  parseDesktopStage,
  stageCause,
} from "../../source/host/extensions/webauthn-proxy/webauthn-proxy-bridge.ts";

function harness(options: { timeout?: boolean } = {}) {
  let monotonic = 100;
  let wall = 1_000;
  const reports: any[] = [];
  const sent: WebAuthnRequestFrame[] = [];
  let id = 0;
  const bridge = new SlateWebAuthnBridge({
    clock: { now: () => wall, monotonicNow: () => monotonic } as never,
    ceremonyDeadline: { run: async (work: () => Promise<unknown>) => options.timeout === true ? Promise.reject(new DeadlineExceededError("timed out")) : work() } as never,
    report: (report) => reports.push(report),
    createId: () => "id-" + (++id),
  });
  const register = () => bridge.registerProvider((frame) => sent.push(frame));
  return { bridge, reports, sent, register, advance: (delta: number) => { monotonic += delta; wall += delta; } };
}
const frame = (overrides: Record<string, unknown>) => overrides as never;
const ceremony = { kind: "get", origin: "https://example.test" } as never;

describe("the WebAuthn proxy bridge", () => {
  it("welcomes a provider and counts live ones", () => {
    const fake = harness();
    const unregister = fake.register();
    assert.deepEqual(fake.sent[0], { kind: "welcome", providerId: "id-1" });
    assert.deepEqual(fake.bridge.providerCounts(), { providerCount: 1, liveProviderCount: 1 });
    unregister();
    assert.deepEqual(fake.bridge.providerCounts(), { providerCount: 0, liveProviderCount: 0 });
  });

  it("records hello and heartbeat frames and expires a stale provider", async () => {
    const fake = harness();
    fake.register();
    fake.bridge.submitResponses({ providerId: "id-1", frames: [frame({ kind: "hello", computerId: "computer-1", label: "Laptop" }), frame({ kind: "ping" })] });
    assert.deepEqual(fake.bridge.providerCounts(), { providerCount: 1, liveProviderCount: 1 });
    fake.advance(SLATE_WEBAUTHN_LIVENESS_WINDOW_MS + 1);
    assert.deepEqual(fake.bridge.providerCounts(), { providerCount: 1, liveProviderCount: 0 });
    const result = await fake.bridge.requestCeremony(ceremony);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.error.message : "", SLATE_WEBAUTHN_MACHINE_UNAVAILABLE_MESSAGE);
  });

  it("fails without a machine when no provider is registered", async () => {
    const fake = harness();
    const result = await fake.bridge.requestCeremony(ceremony);
    assert.equal(result.ok === false ? result.error.message : "", SLATE_NO_WEBAUTHN_MACHINE_MESSAGE);
    assert.deepEqual(fake.reports.map((report) => [report.stage, report.outcome, report.cause]), [["request", "failed", "no_provider"], ["complete", "failed", "no_provider"]]);
  });

  it("settles a ceremony with the browser result", async () => {
    const fake = harness();
    fake.register();
    fake.bridge.submitResponses({ providerId: "id-1", frames: [frame({ kind: "hello" }), frame({ kind: "ping" })] });
    const running = fake.bridge.requestCeremony(ceremony);
    const sentFrame = fake.sent.find((entry) => entry.kind === "ceremony") as any;
    assert.equal(sentFrame.ceremony, ceremony);
    fake.bridge.submitResponses({ providerId: "id-1", frames: [frame({ kind: "result", requestId: "id-2", credentialJson: { id: "credential-1" } })] });
    const result = await running;
    assert.deepEqual(result, { ok: true, credentialJson: { id: "credential-1" } });
    assert.equal(fake.reports.some((report) => report.stage === "complete" && report.outcome === "ok"), true);
  });

  it("reports a browser error with the last stage as its cause", async () => {
    const fake = harness();
    fake.register();
    fake.bridge.submitResponses({ providerId: "id-1", frames: [frame({ kind: "hello" }), frame({ kind: "ping" })] });
    const running = fake.bridge.requestCeremony(ceremony);
    fake.bridge.submitResponses({ providerId: "id-1", frames: [frame({ kind: "stage", stage: "grant", outcome: "declined", requestId: "id-2" })] });
    assert.equal(fake.reports.some((report) => report.stage === "grant" && report.cause === "consent_declined"), true);
    fake.bridge.submitResponses({ providerId: "id-1", frames: [frame({ kind: "error", requestId: "id-2", name: "NotAllowedError", message: "declined", code: "declined" })] });
    const result = await running;
    assert.equal(result.ok, false);
    const complete = fake.reports.find((report) => report.stage === "complete" && report.outcome === "failed")!;
    assert.equal(complete.cause, "consent_declined");
    assert.equal(complete.rawDomErrorName, "NotAllowedError");
    assert.equal(complete.rawSignErrorClass, "declined");
  });

  it("cancels the ceremony when the deadline passes", async () => {
    const fake = harness({ timeout: true });
    fake.register();
    fake.bridge.submitResponses({ providerId: "id-1", frames: [frame({ kind: "hello" }), frame({ kind: "ping" })] });
    const result = await fake.bridge.requestCeremony(ceremony);
    assert.equal(result.ok === false ? result.error.message : "", "The security key ceremony timed out before it was completed.");
    assert.equal((fake.sent.at(-1) as any).kind, "cancel");
    assert.equal(fake.reports.some((report) => report.stage === "complete" && report.outcome === "timeout"), true);
  });

  it("parses stage frames and names their cause", () => {
    assert.deepEqual(parseDesktopStage(frame({ kind: "stage", stage: "sign", outcome: "failed", requestId: "r" })), { stage: "sign", outcome: "failed" });
    assert.equal(parseDesktopStage(frame({ kind: "stage", stage: "other", outcome: "ok", requestId: "r" })), undefined);
    assert.equal(stageCause({ stage: "grant", outcome: "declined" }), "consent_declined");
    assert.equal(stageCause({ stage: "sign", outcome: "failed" }), "sign_failed");
    assert.equal(stageCause({ stage: "grant", outcome: "failed" }), "desktop_failed");
    assert.equal(stageCause({ stage: "grant", outcome: "ok" }), undefined);
  });
  it("prefers the most recently seen provider", async () => {
    const fake = harness();
    const firstSent: WebAuthnRequestFrame[] = [];
    const secondSent: WebAuthnRequestFrame[] = [];
    fake.bridge.registerProvider((frame) => firstSent.push(frame));
    fake.advance(10);
    fake.bridge.registerProvider((frame) => secondSent.push(frame));
    fake.bridge.submitResponses({ providerId: "id-1", frames: [frame({ kind: "hello" }), frame({ kind: "ping" })] });
    fake.advance(1);
    fake.bridge.submitResponses({ providerId: "id-2", frames: [frame({ kind: "hello" }), frame({ kind: "ping" })] });
    const running = fake.bridge.requestCeremony(ceremony);
    assert.equal(secondSent.some((entry) => entry.kind === "ceremony"), true);
    assert.equal(firstSent.some((entry) => entry.kind === "ceremony"), false);
    fake.bridge.submitResponses({ providerId: "id-2", frames: [frame({ kind: "result", requestId: "id-3", credentialJson: { id: "c" } })] });
    assert.deepEqual(await running, { ok: true, credentialJson: { id: "c" } });
  });

  it("reports and rethrows a dispatch failure", async () => {
    const reports: any[] = [];
    const bridge = new SlateWebAuthnBridge({
      clock: { now: () => 1_000, monotonicNow: () => 100 } as never,
      ceremonyDeadline: { run: async (work: () => Promise<unknown>) => work() } as never,
      report: (report) => reports.push(report),
      createId: () => "id-" + reports.length + "-" + Math.random().toString(36).slice(2, 6),
    });
    bridge.registerProvider((frame) => { if (frame.kind === "ceremony") throw new Error("send failed"); });
    bridge.submitResponses({ frames: [frame({ kind: "hello" })] });
    await assert.rejects(bridge.requestCeremony(ceremony), /send failed/);
    assert.equal(reports.some((report) => report.cause === "dispatch_failed" && report.stage === "complete"), true);
  });
});

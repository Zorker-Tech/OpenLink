/**
 * Bridging security-key prompts from the box's browser to the host.
 *
 * A prompt that arrives from the browser is answered by the host's own security key, and the bridge is only offered
 * when the host actually has one to offer.
 */
import { randomUUID } from "node:crypto";

import { DeadlineExceededError, type Clock, type DeadlinePolicy } from "../scheduling.ts";
import {
  SLATE_NO_WEBAUTHN_MACHINE_MESSAGE,
  SLATE_WEBAUTHN_LIVENESS_WINDOW_MS,
  SLATE_WEBAUTHN_MACHINE_UNAVAILABLE_MESSAGE,
  slateWebAuthnOriginClass,
  type WebAuthnCeremony,
  type WebAuthnRequestFrame,
  type WebAuthnResponseFrame
} from "../../../shared/webauthn-gateway.ts";

type DesktopStage = { readonly stage: "grant"; readonly outcome: "ok" | "declined" | "failed" } | { readonly stage: "sign"; readonly outcome: "ok" | "failed" };
type Settlement = { readonly ok: true; readonly credentialJson: unknown } | { readonly ok: false; readonly name: string; readonly message: string; readonly code?: string };

function failureResult(name: string, message: string) { return { ok: false as const, error: { name, message } }; }

export function parseDesktopStage(incomingFrame: Extract<WebAuthnResponseFrame, { kind: "stage" }>): DesktopStage | undefined {
  if (incomingFrame.stage === "grant" && (incomingFrame.outcome === "ok" || incomingFrame.outcome === "declined" || incomingFrame.outcome === "failed")) return { stage: "grant", outcome: incomingFrame.outcome };
  if (incomingFrame.stage === "sign" && (incomingFrame.outcome === "ok" || incomingFrame.outcome === "failed")) return { stage: "sign", outcome: incomingFrame.outcome };
  return undefined;
}

export function stageCause(desktopStage: DesktopStage): "consent_declined" | "sign_failed" | "desktop_failed" | undefined {
  if (desktopStage.outcome === "declined") return "consent_declined";
  if (desktopStage.outcome === "failed") return desktopStage.stage === "sign" ? "sign_failed" : "desktop_failed";
  return undefined;
}

interface Funnel { requestId: string; originClass: string; ceremonyKind: "create" | "get"; startedAt: number; }
interface Pending { settle(value: Settlement): void; funnel: Funnel; lastStage?: DesktopStage; }
interface Provider {
  id: string;
  send(incomingFrame: WebAuthnRequestFrame): void;
  lastSeenAt: number;
  hasHeartbeat: boolean;
  computerId?: string;
  label?: string;
}

export interface SlateWebAuthnBridgeDependencies {
  readonly clock: Clock;
  readonly ceremonyDeadline: DeadlinePolicy;
  readonly report: (reportFields: Record<string, unknown>) => void;
  readonly createId?: () => string;
}

export class SlateWebAuthnBridge {
  private readonly providers = new Set<Provider>();
  private readonly providersById = new Map<string, Provider>();
  private readonly waitingRequest = new Map<string, Pending>();

  constructor(private readonly deps: SlateWebAuthnBridgeDependencies) {}

  registerProvider(send: (incomingFrame: WebAuthnRequestFrame) => void): () => void {
    const bridgeProvider: Provider = { id: this.deps.createId?.() ?? randomUUID(), send, lastSeenAt: this.deps.clock.now(), hasHeartbeat: false };
    this.providers.add(bridgeProvider);
    this.providersById.set(bridgeProvider.id, bridgeProvider);
    send({ kind: "welcome", providerId: bridgeProvider.id });
    return () => { this.providers.delete(bridgeProvider); this.providersById.delete(bridgeProvider.id); };
  }

  submitResponses(responseBatch: { readonly providerId?: string; readonly frames: readonly WebAuthnResponseFrame[] }): void {
    const bridgeProvider = responseBatch.providerId === undefined ? undefined : this.providersById.get(responseBatch.providerId);
    if (bridgeProvider !== undefined) bridgeProvider.lastSeenAt = this.deps.clock.now();
    for (const incomingFrame of responseBatch.frames) {
      switch (incomingFrame.kind) {
        case "hello":
          if (bridgeProvider !== undefined) {
            if (incomingFrame.computerId !== undefined) bridgeProvider.computerId = incomingFrame.computerId;
            if (incomingFrame.label !== undefined) bridgeProvider.label = incomingFrame.label;
          }
          break;
        case "ping":
          if (bridgeProvider !== undefined) bridgeProvider.hasHeartbeat = true;
          break;
        case "stage": {
          const waitingRequest = this.waitingRequest.get(incomingFrame.requestId);
          const desktopStage = parseDesktopStage(incomingFrame);
          if (waitingRequest !== undefined && desktopStage !== undefined) {
            waitingRequest.lastStage = desktopStage;
            this.reportStage(waitingRequest.funnel, { stage: desktopStage.stage, outcome: desktopStage.outcome, cause: stageCause(desktopStage) });
          }
          break;
        }
        case "result": this.settle(incomingFrame.requestId, { ok: true, credentialJson: incomingFrame.credentialJson }); break;
        case "error": this.settle(incomingFrame.requestId, { ok: false, name: incomingFrame.name, message: incomingFrame.message, ...(incomingFrame.code === undefined ? {} : { code: incomingFrame.code }) }); break;
      }
    }
  }

  async requestCeremony(ceremony: WebAuthnCeremony): Promise<{ ok: true; credentialJson: unknown } | { ok: false; error: { name: string; message: string } }> {
    const funnel: Funnel = {
      requestId: this.deps.createId?.() ?? randomUUID(),
      originClass: slateWebAuthnOriginClass(ceremony.origin),
      ceremonyKind: ceremony.kind === "create" ? "create" : "get",
      startedAt: this.deps.clock.monotonicNow()
    };
    const bridgeProvider = this.chooseProvider();
    if (bridgeProvider === undefined) {
      const cause = this.providers.size === 0 ? "no_provider" : "provider_stale";
      this.reportStage(funnel, { stage: "request", outcome: "failed", cause, ...this.providerCounts() });
      this.reportStage(funnel, { stage: "complete", outcome: "failed", cause });
      return failureResult("NotAllowedError", this.providers.size === 0 ? SLATE_NO_WEBAUTHN_MACHINE_MESSAGE : SLATE_WEBAUTHN_MACHINE_UNAVAILABLE_MESSAGE);
    }
    const { promise: settlementPromise, resolve: settle } = Promise.withResolvers<Settlement>();
    this.waitingRequest.set(funnel.requestId, { settle, funnel });
    try {
      bridgeProvider.send({ kind: "ceremony", requestId: funnel.requestId, ceremony });
    } catch (failure) {
      this.waitingRequest.delete(funnel.requestId);
      this.reportStage(funnel, { stage: "request", outcome: "failed", cause: "dispatch_failed", ...this.providerCounts() });
      this.reportStage(funnel, { stage: "complete", outcome: "failed", cause: "dispatch_failed" });
      throw failure;
    }
    this.reportStage(funnel, { stage: "request", outcome: "ok", ...this.providerCounts() });
    try {
      const settlement = await this.deps.ceremonyDeadline.run(() => settlementPromise);
      return settlement.ok ? { ok: true, credentialJson: settlement.credentialJson } : failureResult(settlement.name, settlement.message);
    } catch (failure) {
      if (failure instanceof DeadlineExceededError) {
        if (this.waitingRequest.has(funnel.requestId)) this.reportStage(funnel, { stage: "complete", outcome: "timeout", cause: "timeout" });
        bridgeProvider.send({ kind: "cancel", requestId: funnel.requestId });
        return failureResult("NotAllowedError", "The security key ceremony timed out before it was completed.");
      }
      throw failure;
    } finally { this.waitingRequest.delete(funnel.requestId); }
  }

  private settle(requestId: string, settlement: Settlement): void {
    const waitingRequest = this.waitingRequest.get(requestId);
    if (waitingRequest === undefined) return;
    this.waitingRequest.delete(requestId);
    if (settlement.ok) this.reportStage(waitingRequest.funnel, { stage: "complete", outcome: "ok" });
    else {
      const cause = (waitingRequest.lastStage !== undefined ? stageCause(waitingRequest.lastStage) : undefined) ?? "desktop_failed";
      this.reportStage(waitingRequest.funnel, { stage: "complete", outcome: "failed", cause, rawDomErrorName: settlement.name, ...(settlement.code === undefined ? {} : { rawSignErrorClass: settlement.code }) });
    }
    waitingRequest.settle(settlement);
  }

  private reportStage(funnel: Funnel, reportFields: Record<string, unknown>): void {
    this.deps.report({ ...reportFields, requestId: funnel.requestId, originClass: funnel.originClass, ceremonyKind: funnel.ceremonyKind, elapsedMs: this.deps.clock.monotonicNow() - funnel.startedAt });
  }

  providerCounts(): { providerCount: number; liveProviderCount: number } {
    const nowMs = this.deps.clock.now();
    let providerLive = 0;
    for (const bridgeProvider of this.providers) if (!bridgeProvider.hasHeartbeat || nowMs - bridgeProvider.lastSeenAt <= SLATE_WEBAUTHN_LIVENESS_WINDOW_MS) providerLive += 1;
    return { providerCount: this.providers.size, liveProviderCount: providerLive };
  }

  private chooseProvider(): Provider | undefined {
    const nowMs = this.deps.clock.now();
    let bestProvider: Provider | undefined;
    for (const bridgeProvider of this.providers) {
      const providerLive = !bridgeProvider.hasHeartbeat || nowMs - bridgeProvider.lastSeenAt <= SLATE_WEBAUTHN_LIVENESS_WINDOW_MS;
      if (providerLive && (bestProvider === undefined || bridgeProvider.lastSeenAt > bestProvider.lastSeenAt)) bestProvider = bridgeProvider;
    }
    return bestProvider;
  }
}


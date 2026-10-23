/**
 * Asking the user to touch their security key.
 *
 * A WebAuthn ceremony needs a gatewayConnection to the browser — a channel the desktop answers on — and that gatewayConnection can be
 * lost: the provider keeps one open, watches it with a heartbeatHandle, reconnects with backoff, and asks the user for consent
 * before it starts, so a ceremony is either served by a live gatewayConnection or reported as unavailable rather than left to
 * time out.
 */
import { SseBlockDecoder } from "../gateway/sse-block-decoder.ts";
import {
  GATEWAY_WEBAUTHN_REQUESTS_PATH,
  GATEWAY_WEBAUTHN_RESPONSES_PATH,
  type WebAuthnCeremony,
  type WebAuthnRequestFrame,
  type WebAuthnResponseFrame
} from "../../shared/webauthn-gateway.ts";
import type { ApprovedWebAuthnConsent, WebAuthnSigner } from "./signer.ts";

export class WebAuthnChannelError extends Error {
  override readonly name = "WebAuthnChannelError";
}

export interface WebAuthnConnection {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly token?: string;
}

export interface RetryPolicy {
  runWithRetry<T>(work: (ceremonyAbort: number, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface HeartbeatPolicy {
  start(work: () => Promise<void>, signal: AbortSignal): { dispose(): void };
}

export interface WebAuthnConsentProvider {
  requestConsent(ceremony: WebAuthnCeremony, signal: AbortSignal): Promise<ApprovedWebAuthnConsent | { readonly approved: false }>;
  finish(): void;
}

export interface WebAuthnProviderOptions {
  readonly resolveConnection: () => Promise<WebAuthnConnection>;
  readonly signer: WebAuthnSigner;
  readonly heartbeatPolicy: HeartbeatPolicy;
  readonly reconnectPolicy: RetryPolicy;
  readonly deliveryPolicy?: RetryPolicy;
  readonly consent?: WebAuthnConsentProvider;
  readonly computerId?: string;
  readonly label?: string;
  readonly log?: (message: string) => void;
}

export function createWebAuthnProvider(settings: WebAuthnProviderOptions): { start(): void; stop(): void } {
  const log = settings.log ?? (() => {});
  let lifetimeController: AbortController | undefined;
  let providerId: string | undefined;
  const pendingCeremonies = new Map<string, AbortController>();

  function buildHeaders(gatewayConnection: WebAuthnConnection): Record<string, string> {
    return { ...(gatewayConnection.headers ?? {}), ...(gatewayConnection.token === undefined ? {} : { authorization: `Bearer ${gatewayConnection.token}` }) };
  }

  async function sendResponseFrames(gatewayConnection: WebAuthnConnection, outgoingFrames: readonly WebAuthnResponseFrame[], signal?: AbortSignal): Promise<void> {
    const batch = providerId === undefined ? { frames: outgoingFrames } : { providerId, frames: outgoingFrames };
    const httpResponse = await fetch(`${gatewayConnection.baseUrl}${GATEWAY_WEBAUTHN_RESPONSES_PATH}`, {
      method: "POST",
      headers: { ...buildHeaders(gatewayConnection), "content-type": "application/json" },
      body: JSON.stringify(batch),
      ...(signal === undefined ? {} : { signal })
    });
    if (!httpResponse.ok) throw new WebAuthnChannelError(`webauthn response POST rejected: HTTP ${httpResponse.status}`);
  }

  async function serveCeremony(gatewayConnection: WebAuthnConnection, requestId: string, ceremony: WebAuthnCeremony): Promise<void> {
    const ceremonyAbort = new AbortController();
    pendingCeremonies.set(requestId, ceremonyAbort);
    log(`ceremony ${requestId}: ${ceremony.kind} for ${ceremony.origin}`);
    let failureStage: Pick<Extract<WebAuthnResponseFrame, { kind: "stage" }>, "stage" | "outcome"> =
      settings.consent === undefined ? { stage: "sign", outcome: "failed" } : { stage: "grant", outcome: "failed" };
    let outgoingFrames: WebAuthnResponseFrame[];
    try {
      const consent = await settings.consent?.requestConsent(ceremony, ceremonyAbort.signal);
      if (consent !== undefined && !consent.approved) {
        await sendResponseFrames(gatewayConnection, [
          { kind: "stage", requestId, stage: "grant", outcome: "declined" },
          { kind: "error", requestId, name: "NotAllowedError", message: "The security key request was declined on your computer." }
        ]);
        pendingCeremonies.delete(requestId);
        return;
      }
      if (consent !== undefined) {
        failureStage = { stage: "sign", outcome: "failed" };
        await sendResponseFrames(gatewayConnection, [{ kind: "stage", requestId, stage: "grant", outcome: "ok" }], ceremonyAbort.signal)
          .catch((error: unknown) => log(`grant stage frame failed: ${String(error)}`));
      }
      if (ceremonyAbort.signal.aborted) return;
      const result = await settings.signer.sign(ceremony, ceremonyAbort.signal, consent);
      outgoingFrames = result.ok
        ? [
            { kind: "stage", requestId, stage: "sign", outcome: "ok" },
            { kind: "result", requestId, credentialJson: result.credentialJson }
          ]
        : [
            { kind: "stage", requestId, stage: "sign", outcome: "failed" },
            { kind: "error", requestId, name: result.error.name, message: result.error.message, ...(result.error.code === undefined ? {} : { code: result.error.code }) }
          ];
    } catch (error) {
      outgoingFrames = [
        { kind: "stage", requestId, ...failureStage },
        { kind: "error", requestId, name: "NotAllowedError", message: `the security key could not complete the request: ${error instanceof Error ? error.message : String(error)}` }
      ];
    } finally {
      settings.consent?.finish();
      pendingCeremonies.delete(requestId);
    }
    if (ceremonyAbort.signal.aborted) return;
    try {
      if (settings.deliveryPolicy === undefined) await sendResponseFrames(gatewayConnection, outgoingFrames);
      else await settings.deliveryPolicy.runWithRetry(() => sendResponseFrames(gatewayConnection, outgoingFrames), ceremonyAbort.signal);
    } catch (error) {
      log(`ceremony ${requestId} result could not be delivered: ${String(error)}`);
    }
  }

  function handleRequestFrame(gatewayConnection: WebAuthnConnection, incomingMessage: WebAuthnRequestFrame): void {
    switch (incomingMessage.kind) {
      case "welcome":
        providerId = incomingMessage.providerId;
        void sendResponseFrames(gatewayConnection, [{ kind: "hello", ...(settings.computerId === undefined ? {} : { computerId: settings.computerId }), ...(settings.label === undefined ? {} : { label: settings.label }) }])
          .catch((error: unknown) => log(`hello frame failed: ${String(error)}`));
        break;
      case "ceremony":
        void serveCeremony(gatewayConnection, incomingMessage.requestId, incomingMessage.ceremony);
        break;
      case "cancel":
        pendingCeremonies.get(incomingMessage.requestId)?.abort();
        pendingCeremonies.delete(incomingMessage.requestId);
        break;
    }
  }

  async function openRequestStream(signal: AbortSignal): Promise<never> {
    const gatewayConnection = await settings.resolveConnection();
    const httpResponse = await fetch(`${gatewayConnection.baseUrl}${GATEWAY_WEBAUTHN_REQUESTS_PATH}`, { headers: buildHeaders(gatewayConnection), signal });
    if (!httpResponse.ok || httpResponse.body == null) throw new WebAuthnChannelError(`webauthn request stream refused: HTTP ${httpResponse.status}`);
    log("webauthn request stream open");
    providerId = undefined;
    const blockDecoder = new SseBlockDecoder((block) => {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          handleRequestFrame(gatewayConnection, JSON.parse(line.slice("data:".length).trim()) as WebAuthnRequestFrame);
        } catch (error) {
          log(`dropped an unparseable request frame: ${String(error)}`);
        }
      }
    });
    const heartbeatHandle = settings.heartbeatPolicy.start(async () => {
      try { await sendResponseFrames(gatewayConnection, [{ kind: "ping" }]); }
      catch (error) { log(`heartbeatHandle failed: ${String(error)}`); }
    }, signal);
    try {
      for await (const chunkPiece of httpResponse.body) blockDecoder.push(chunkPiece);
    } finally {
      heartbeatHandle.dispose();
      for (const ceremonyAbort of pendingCeremonies.values()) ceremonyAbort.abort();
      pendingCeremonies.clear();
    }
    throw new WebAuthnChannelError("webauthn request stream closed");
  }

  return {
    start() {
      if (lifetimeController !== undefined) return;
      const controller = new AbortController();
      lifetimeController = controller;
      void settings.reconnectPolicy.runWithRetry(async (_attempt, signal) => openRequestStream(signal), controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) log(`webauthn provider gave up: ${String(error)}`);
      });
    },
    stop() {
      lifetimeController?.abort();
      lifetimeController = undefined;
    }
  };
}


/** Keeping the credential this build infers with alive.

 * The credential is renewed before it runs out rather than after a call has failed: how long is left decides when the
 * next attempt happens, a failure is backed off and retried, and where the credential comes from — the environment, a
 * file a development build was given, or the platform itself — is decided here. */
import { readFile } from "node:fs/promises";

import type { Clock, RetryPolicy } from "../extensions/scheduling.ts";
import { errorLogTag } from "../../shared/errors/summary.ts";
import { getAccessTokenExpiryMs, getConfiguredBackendUrl } from "../../shared/node/slate-token.ts";
import { getSlateBackendClientHeaders } from "../../adapters/interop/backend/slate-client-metadata-adapter.ts";

export class SlateCredentialRenewalError extends Error {
  constructor(message: string) { super(message); this.name = "SlateCredentialRenewalError"; }
}

export const SLATE_INFERENCE_RENEWAL_CREDENTIAL_ENV = "SLATE_INFERENCE_RENEWAL_CREDENTIAL";
export const SLATE_DEV_INFERENCE_TOKEN_FILE_ENV = "SLATE_DEV_INFERENCE_TOKEN_FILE";
export const REFRESH_LEEWAY_MS = 2 * 60 * 1_000;
export const MIN_REFRESH_INTERVAL_MS = 30 * 1_000;
export const MAX_REFRESH_INTERVAL_MS = 30 * 60 * 1_000;
export const CREDENTIAL_RETRY_BASE_DELAY_MS = 5 * 1_000;
export const CREDENTIAL_RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;
export const DEFAULT_TTL_MS = 10 * 60 * 1_000;
export const RENEWAL_PATH = "/slate-box/inference-credential";

export interface InferenceCredential { readonly accessToken: string; readonly expiresAtMs: number; }
export interface RenewalResult {
  readonly outcome: "renewed" | "failed";
  readonly consecutiveFailures: number;
  readonly durationMs: number;
  readonly errorSummary: string | undefined;
}

function credentialFromPayload(payload: unknown, absentMessage: string): InferenceCredential {
  const payloadRecord = payload as Record<string, unknown>;
  const accessToken = typeof payloadRecord.accessToken === "string" ? payloadRecord.accessToken : "";
  if (accessToken.length === 0) throw new SlateCredentialRenewalError(absentMessage);
  const expiresAtMs = typeof payloadRecord.expiresAtMs === "number" && Number.isFinite(payloadRecord.expiresAtMs)
    ? payloadRecord.expiresAtMs
    : getAccessTokenExpiryMs(accessToken) ?? Date.now() + DEFAULT_TTL_MS;
  return { accessToken, expiresAtMs };
}

export async function renewBoxInferenceCredential(args: {
  readonly backendUrl: string;
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<InferenceCredential> {
  const response = await (args.fetchImpl ?? fetch)(new URL(RENEWAL_PATH, args.backendUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", ...getSlateBackendClientHeaders() },
    body: JSON.stringify({ credential: args.credential })
  });
  if (!response.ok) throw new SlateCredentialRenewalError(`Slate inference-credential renewal failed (HTTP ${response.status}).`);
  return credentialFromPayload(await response.json(), "Slate inference-credential renewal returned no token.");
}

export async function readDevInferenceCredentialFile(args: {
  readonly path: string;
  readonly readFileImpl?: (path: string) => Promise<string>;
}): Promise<InferenceCredential> {
  const rawText = await (args.readFileImpl ?? ((path) => readFile(path, "utf8")))(args.path);
  return credentialFromPayload(JSON.parse(rawText) as unknown, `Dev inference token file ${args.path} has no accessToken yet.`);
}

export class SlateInferenceCredentialRenewer {
  private readonly abortController = new AbortController();
  private loop: Promise<void> | undefined;
  private failureCount = 0;
  private wakeRefresh: (() => void) | undefined;
  private demandRenewal: PromiseWithResolvers<void> | undefined;

  constructor(private readonly renewalOptions: {
    readonly getCredential: () => string | null;
    readonly renew: (credential: string) => Promise<InferenceCredential>;
    readonly setCredential: (credential: InferenceCredential) => void;
    readonly onResult?: (result: RenewalResult) => void;
    readonly retry: RetryPolicy;
    readonly clock: Clock;
  }) {}

  start(): void { this.loop ??= this.runLoop(); }
  close(): void { this.abortController.abort(); }

  requestImmediateRenewal(): Promise<boolean> {
    if (this.demandRenewal !== undefined) return this.demandRenewal.promise.then(() => true);
    const interrupt = this.wakeRefresh;
    if (interrupt === undefined) return Promise.resolve(false);
    this.demandRenewal = Promise.withResolvers<void>();
    const result = this.demandRenewal.promise.then(() => true);
    interrupt();
    return result;
  }

  private async runLoop(): Promise<void> {
    try {
      while (!this.abortController.signal.aborted) {
        const nextDelay = await this.renewalCycle();
        this.settleDemandRenewal();
        if (nextDelay === null) return;
        await this.waitUntilNext(nextDelay);
      }
    } finally { this.settleDemandRenewal(); }
  }

  private settleDemandRenewal(): void { this.demandRenewal?.resolve(); this.demandRenewal = undefined; }

  private async renewalCycle(): Promise<{ kind: "refresh"; delayMs: number } | { kind: "backoff"; attempt: number } | null> {
    const cycleStartedAtMs = Date.now();
    try {
      const credential = this.renewalOptions.getCredential();
      if (credential == null || credential.length === 0) return { kind: "refresh", delayMs: MAX_REFRESH_INTERVAL_MS };
      const renewedCredential = await this.renewalOptions.renew(credential);
      if (this.abortController.signal.aborted) return null;
      this.renewalOptions.setCredential(renewedCredential);
      this.failureCount = 0;
      this.publishResult("renewed", Date.now() - cycleStartedAtMs);
      const untilRefresh = renewedCredential.expiresAtMs - Date.now() - REFRESH_LEEWAY_MS;
      return { kind: "refresh", delayMs: Math.min(Math.max(untilRefresh, MIN_REFRESH_INTERVAL_MS), MAX_REFRESH_INTERVAL_MS) };
    } catch (error) {
      if (this.abortController.signal.aborted) return null;
      this.failureCount += 1;
      this.publishResult("failed", Date.now() - cycleStartedAtMs, redactRenewalErrorForReport(error instanceof Error ? error.message : String(error)));
      return { kind: "backoff", attempt: this.failureCount };
    }
  }

  private async waitUntilNext(nextDelay: { kind: "refresh"; delayMs: number } | { kind: "backoff"; attempt: number }): Promise<void> {
    const abortSignal = this.abortController.signal;
    if (abortSignal.aborted) return;
    if (nextDelay.kind === "backoff") {
      await this.renewalOptions.retry.schedule(nextDelay.attempt, abortSignal).elapsed.catch((error) => {
        if (!abortSignal.aborted) console.warn(`[slate-credential-renewer] backoff wait failed (${errorLogTag(error)})`);
      });
      return;
    }
    await new Promise<void>((resolve) => {
      let isSettled = false;
      let scheduledWait: { dispose(): void };
      const finish = () => {
        if (isSettled) return;
        isSettled = true;
        scheduledWait.dispose();
        abortSignal.removeEventListener("abort", finish);
        if (this.wakeRefresh === finish) this.wakeRefresh = undefined;
        resolve();
      };
      scheduledWait = this.renewalOptions.clock.schedule(nextDelay.delayMs, finish);
      this.wakeRefresh = finish;
      abortSignal.addEventListener("abort", finish, { once: true });
    });
  }

  private publishResult(outcome: "renewed" | "failed", durationMs: number, errorSummary?: string): void {
    try { this.renewalOptions.onResult?.({ outcome, consecutiveFailures: this.failureCount, durationMs, errorSummary }); }
    catch {}
  }
}

export function redactRenewalErrorForReport(rawText: string): string {
  return rawText.replace(/https?:\/\/\S+/gi, "<url>").replace(/\/[^\s"']+/g, "<path>").replace(/[A-Za-z0-9_-]{24,}/g, "<id>").replace(/\s+/g, " ").trim().slice(0, 160);
}

export function getSlateInferenceBackendUrl(): string { return getConfiguredBackendUrl(); }

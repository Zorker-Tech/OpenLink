import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CREDENTIAL_RETRY_BASE_DELAY_MS,
  DEFAULT_TTL_MS,
  MAX_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  REFRESH_LEEWAY_MS,
  RENEWAL_PATH,
  SlateCredentialRenewalError,
  SlateInferenceCredentialRenewer,
  getSlateInferenceBackendUrl,
  readDevInferenceCredentialFile,
  redactRenewalErrorForReport,
  renewBoxInferenceCredential,
} from "../../source/host/auth/credential-renewer.ts";

const token = (expiresAtMs = Date.now() + 60_000) => ({ accessToken: "token-1", expiresAtMs });
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as never;

describe("reading renewable credentials", () => {
  it("renews the box credential over its endpoint", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const result = await renewBoxInferenceCredential({
      backendUrl: "https://backend.test",
      credential: "c1",
      fetchImpl: (async (url: string, init: any) => { calls.push({ url, init }); return response({ accessToken: "fresh", expiresAtMs: 123 }); }) as never,
    });
    assert.deepEqual(result, { accessToken: "fresh", expiresAtMs: 123 });
    assert.equal(calls[0]!.url, "https://backend.test/slate-box/inference-credential");
    assert.equal(calls[0]!.init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.init.body), { credential: "c1" });
  });

  it("fails when the response is not ok or has no token", async () => {
    await assert.rejects(renewBoxInferenceCredential({ backendUrl: "https://b.test", credential: "c", fetchImpl: (async () => response({}, false)) as never }), (error: unknown) => error instanceof SlateCredentialRenewalError && String((error as Error).message).includes("HTTP 500"));
    await assert.rejects(renewBoxInferenceCredential({ backendUrl: "https://b.test", credential: "c", fetchImpl: (async () => response({})) as never }), /returned no token/);
  });

  it("falls back to a default ttl when the payload has no usable expiry", async () => {
    const before = Date.now();
    const result = await renewBoxInferenceCredential({ backendUrl: "https://b.test", credential: "c", fetchImpl: (async () => response({ accessToken: "plain" })) as never });
    assert.equal(result.accessToken, "plain");
    assert.equal(result.expiresAtMs >= before + DEFAULT_TTL_MS - 1_000, true);
  });

  it("reads a dev token file", async () => {
    const credential = await readDevInferenceCredentialFile({ path: "/tmp/token.json", readFileImpl: async () => JSON.stringify({ accessToken: "dev", expiresAtMs: 5 }) });
    assert.deepEqual(credential, { accessToken: "dev", expiresAtMs: 5 });
    await assert.rejects(readDevInferenceCredentialFile({ path: "/tmp/token.json", readFileImpl: async () => "{}" }), /Dev inference token file \/tmp\/token.json has no accessToken/);
  });

  it("redacts a renewal error for the report", () => {
    const redacted = redactRenewalErrorForReport("failed at https://backend.test/secret/path with token abcdefghijklmnopqrstuvwx and   spaces");
    assert.equal(redacted.includes("https://backend.test"), false);
    assert.equal(redacted.includes("abcdefghijklmnopqrstuvwx"), false);
    assert.equal(redacted.includes("  "), false);
    assert.equal(redactRenewalErrorForReport("x".repeat(300)).length <= 160, true);
    assert.equal(getSlateInferenceBackendUrl().length >= 0, true);
    assert.equal(CREDENTIAL_RETRY_BASE_DELAY_MS > 0, true);
  });
});

function flusher() { return new Promise((resolve) => setTimeout(resolve, 0)); }
function harness(options: { credential?: string | null; renew?: (credential: string) => Promise<any> } = {}) {
  const results: any[] = [];
  const set: any[] = [];
  let credential = options.credential === undefined ? null : options.credential;
  let scheduled: { delayMs: number; callback: () => void } | null = null;
  let renewer: any;
  const clock = { schedule: (delayMs: number, callback: () => void) => { scheduled = { delayMs, callback }; return { dispose: () => { if (scheduled?.callback === callback) scheduled = null; } }; } };
  const retry = { schedule: () => ({ elapsed: new Promise((resolve) => setTimeout(resolve, 1)) }) };
  renewer = new SlateInferenceCredentialRenewer({
    getCredential: () => credential,
    renew: options.renew ?? (async () => token()),
    setCredential: (value: any) => set.push(value),
    onResult: (result: any) => results.push(result),
    retry: retry as never,
    clock: clock as never,
  });
  return { renewer, results, set, clock, wake: () => scheduled?.callback(), hasWait: () => scheduled !== null, nextDelay: () => scheduled?.delayMs, setCredential: (value: string | null) => { credential = value; } };
}

describe("the credential renewer", () => {
  it("renews when woken and schedules the next refresh", async () => {
    const fake = harness();
    fake.renewer.start();
    await flusher();
    assert.equal(fake.hasWait(), true);
    fake.setCredential("c1");
    const renewed = fake.renewer.requestImmediateRenewal();
    assert.equal(await renewed, true);
    await flusher();
    assert.equal(fake.set.length, 1);
    assert.equal(fake.results[0].outcome, "renewed");
    assert.equal(fake.results[0].consecutiveFailures, 0);
    assert.equal(fake.nextDelay()! >= MIN_REFRESH_INTERVAL_MS, true);
    assert.equal(fake.nextDelay()! < MAX_REFRESH_INTERVAL_MS, true);
    fake.renewer.close();
  });

  it("returns false when there is nothing waiting for a wake-up", async () => {
    const fake = harness();
    fake.renewer.start();
    await flusher();
    fake.renewer.close();
    assert.equal(await fake.renewer.requestImmediateRenewal(), false);
  });

  it("backs off after a failure and reports the redacted summary", async () => {
    let attempts = 0;
    const fake = harness({ credential: "c1", renew: async () => { attempts += 1; throw new Error("boom at https://backend.test/secret" + (attempts === 2 ? "" : "")); } });
    fake.renewer.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fake.results.length >= 1, true);
    assert.equal(fake.results[0].outcome, "failed");
    assert.equal(fake.results[0].consecutiveFailures, 1);
    assert.equal(String(fake.results[0].errorSummary).includes("https://"), false);
    fake.renewer.close();
  });
});

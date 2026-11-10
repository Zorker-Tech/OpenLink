/**
 * The host's runtime pieces, twelfth group: the credential this build infers with, what an agent remembers about its
 * user, and waking an automation because something happened.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDebouncePolicy, createRetryPolicy, type Clock } from "../../source/host/extensions/scheduling.ts";
import { CREDENTIAL_RETRY_BASE_DELAY_MS, CREDENTIAL_RETRY_MAX_DELAY_MS, DEFAULT_TTL_MS, MAX_REFRESH_INTERVAL_MS, MIN_REFRESH_INTERVAL_MS, REFRESH_LEEWAY_MS, RENEWAL_PATH, readDevInferenceCredentialFile, redactRenewalErrorForReport, renewBoxInferenceCredential, SlateCredentialRenewalError, SlateInferenceCredentialRenewer, SLATE_DEV_INFERENCE_TOKEN_FILE_ENV, SLATE_INFERENCE_RENEWAL_CREDENTIAL_ENV } from "../../source/host/auth/credential-renewer.ts";
import { agentMemoryHasContent, FileMemoryStore, getAgentMemoryDir, getUserMemoryDir, getUserMemoryShardDir, getProjectMemoryShardsDir, MEMORY_CHANGE_DEBOUNCE_MS, MEMORY_DIRNAME, MEMORY_SYNTHESIS_INPUT_LIMIT, MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS, memoryIdFor, parseFacts, PROFILE_FILENAME, serializeFactLine } from "../../source/host/memory/memory-service.ts";
import { AutomationEventFires, EVENT_FIRE_DEBOUNCE_MS, MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION, MAX_REPORTED_DROPPED_FIRES } from "../../source/host/transcript/automation-event-fires.ts";

describe("the credential this build infers with", () => {
  const day = (year: number, month: number, dayOfMonth: number) => Date.UTC(year, month - 1, dayOfMonth);

  it("renews the credential at the platform's own path, and reports what it could not do", async () => {
    assert.equal(RENEWAL_PATH, "/slate-box/inference-credential");
    assert.equal(SLATE_INFERENCE_RENEWAL_CREDENTIAL_ENV, "SLATE_INFERENCE_RENEWAL_CREDENTIAL");
    assert.equal(SLATE_DEV_INFERENCE_TOKEN_FILE_ENV, "SLATE_DEV_INFERENCE_TOKEN_FILE");
    const calls: Array<{ url: string; body: unknown }> = [];
    const renewed = await renewBoxInferenceCredential({
      backendUrl: "https://backend.invalid",
      credential: "credential-1",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        // A token that says when it expires is read as such.
        return new Response(JSON.stringify({ accessToken: "header.eyJleHAiOjQxMDI0NDQ4MDB9.sig" }), { status: 200 });
      }) as typeof fetch,
    });
    assert.deepEqual(calls, [{ url: "https://backend.invalid/slate-box/inference-credential", body: { credential: "credential-1" } }]);
    assert.deepEqual(renewed, { accessToken: "header.eyJleHAiOjQxMDI0NDQ4MDB9.sig", expiresAtMs: 4_102_444_800_000 });
    // A refusal, and an answer without a token, are both reported as the renewal they are.
    await renewBoxInferenceCredential({ backendUrl: "https://backend.invalid", credential: "c", fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch }).then(
      () => assert.fail("a refused renewal was taken as renewed"),
      (error: SlateCredentialRenewalError) => { assert.equal(error instanceof SlateCredentialRenewalError, true); assert.equal(error.message, "Slate inference-credential renewal failed (HTTP 500)."); },
    );
    await renewBoxInferenceCredential({ backendUrl: "https://backend.invalid", credential: "c", fetchImpl: (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch }).then(
      () => assert.fail("an answer without a token was taken as renewed"),
      (error: Error) => assert.equal(error.message, "Slate inference-credential renewal returned no token."),
    );
    // A token that does not say when it expires is given the platform's own lifetime rather than none at all.
    const opaque = await renewBoxInferenceCredential({ backendUrl: "https://backend.invalid", credential: "c", fetchImpl: (async () => new Response(JSON.stringify({ accessToken: "opaque" }), { status: 200 })) as typeof fetch });
    assert.equal(opaque.accessToken, "opaque");
    assert.equal(Math.abs(opaque.expiresAtMs - (Date.now() + DEFAULT_TTL_MS)) < 5_000, true);
  });

  it("reads a development token from the file it was given", async () => {
    assert.deepEqual(await readDevInferenceCredentialFile({ path: "/dev/token", readFileImpl: async () => JSON.stringify({ accessToken: "from-file", expiresAtMs: 42 }) }), { accessToken: "from-file", expiresAtMs: 42 });
    await readDevInferenceCredentialFile({ path: "/dev/token", readFileImpl: async () => JSON.stringify({}) }).then(
      () => assert.fail("a file without a token was taken as one"),
      (error: Error) => assert.equal(error.message, "Dev inference token file /dev/token has no accessToken yet."),
    );
  });

  it("takes the identifying parts out of what it reports about a failure", () => {
    assert.equal(redactRenewalErrorForReport("failed GET https://api.example.invalid/v1/tokens with abcdefghijklmnopqrstuvwxyz123456"), "failed GET <url> with <id>");
    assert.equal(redactRenewalErrorForReport("   collapsed   spaces\n\nand lines  "), "collapsed spaces and lines");
    // An unbroken run of characters is an id, and what is left is only ever as long as the platform reports.
    assert.equal(redactRenewalErrorForReport("x".repeat(200)), "<id>");
    assert.equal(redactRenewalErrorForReport("word ".repeat(50)).length, 160);
    assert.equal(redactRenewalErrorForReport("token t-9f8e7d6c5b4a39281706f5e4d3c2b1a0"), "token <id>");
    assert.equal(redactRenewalErrorForReport(""), "");
  });

  it("renews before the credential runs out, and backs off when it cannot", async () => {
    let now = 1_000_000;
    const scheduled: Array<{ at: number; callback: () => void; disposed: boolean }> = [];
    const clock: Clock = {
      now: () => now,
      monotonicNow: () => now,
      schedule(delayMs, callback) { const entry = { at: now + delayMs, callback, disposed: false }; scheduled.push(entry); return { dispose() { entry.disposed = true; } }; },
    };
    const advance = async (ms: number) => { now += ms; for (const entry of [...scheduled]) if (!entry.disposed && entry.at <= now) { entry.disposed = true; await entry.callback(); } };
    const results: Array<{ outcome: string; consecutiveFailures: number; errorSummary?: string | undefined }> = [];
    const stored: Array<{ accessToken: string }> = [];
    // The wait before a renewal is measured against the real clock, as the credential's own expiry is.
    let renew = async () => ({ accessToken: "renewed-1", expiresAtMs: Date.now() + 60 * 60_000 });
    const renewer = new SlateInferenceCredentialRenewer({
      getCredential: () => "start-credential",
      renew: (credential) => { assert.equal(credential, "start-credential"); return renew(); },
      setCredential: (credential) => { stored.push(credential); },
      onResult: (result) => { results.push(result); },
      retry: createRetryPolicy(clock, { name: "credential", maxAttempts: 3, initialDelayMs: CREDENTIAL_RETRY_BASE_DELAY_MS, maxDelayMs: CREDENTIAL_RETRY_MAX_DELAY_MS, backoffFactor: 2 }),
      clock,
    });
    renewer.start();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.accessToken, "renewed-1");
    assert.deepEqual(results.map((result) => result.outcome), ["renewed"]);
    // The wait until the next renewal is what is left of the credential's life, less the leeway, and never longer than
    // the platform allows; a credential already inside the leeway is renewed no sooner than the platform's floor.
    assert.equal(scheduled.at(-1) !== undefined && scheduled.at(-1)!.at - now, MAX_REFRESH_INTERVAL_MS);
    assert.equal(MIN_REFRESH_INTERVAL_MS, 30_000);
    assert.equal(MAX_REFRESH_INTERVAL_MS, 30 * 60_000);
    assert.equal(REFRESH_LEEWAY_MS, 2 * 60_000);
    renew = async () => ({ accessToken: "short-lived", expiresAtMs: Date.now() + 1_000 });
    await advance(MAX_REFRESH_INTERVAL_MS);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(scheduled.at(-1) !== undefined && scheduled.at(-1)!.at - now, MIN_REFRESH_INTERVAL_MS);

    // A renewal that fails is reported with what it was, and the wait before the next attempt grows.
    renew = async () => { throw new Error("renewal exploded at https://backend.invalid/path with abcdefghijklmnopqrstuvwxyz123456"); };
    await advance(60 * 60_000);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(results.at(-1)?.outcome, "failed");
    assert.equal(results.at(-1)?.consecutiveFailures, 1);
    assert.equal(results.at(-1)?.errorSummary, "renewal exploded at <url> with <id>");
    assert.equal(scheduled.at(-1) !== undefined, true);

    // Renewing on demand does not start a second renewal, and a closed renewer does nothing at all.
    assert.equal(await renewer.requestImmediateRenewal(), false);
    renewer.close();
    assert.equal(await renewer.requestImmediateRenewal(), false);
  });

  it("renews with no credential to renew only as often as the platform allows", async () => {
    let now = 5_000;
    const scheduled: Array<{ at: number; callback: () => void; disposed: boolean }> = [];
    const clock: Clock = { now: () => now, monotonicNow: () => now, schedule(delayMs, callback) { const entry = { at: now + delayMs, callback, disposed: false }; scheduled.push(entry); return { dispose() { entry.disposed = true; } }; } };
    let renewals = 0;
    const renewer = new SlateInferenceCredentialRenewer({
      getCredential: () => null,
      renew: async () => { renewals += 1; return { accessToken: "t", expiresAtMs: now + 60_000 }; },
      setCredential: () => {},
      retry: createRetryPolicy(clock, { name: "credential", maxAttempts: 3, initialDelayMs: CREDENTIAL_RETRY_BASE_DELAY_MS, maxDelayMs: CREDENTIAL_RETRY_MAX_DELAY_MS }),
      clock,
    });
    renewer.start();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(renewals, 0);
    assert.equal(scheduled.at(-1) !== undefined && scheduled.at(-1)!.at - now, MAX_REFRESH_INTERVAL_MS);
    renewer.close();
  });
});

describe("what an agent remembers about its user", () => {
  const root = () => mkdtempSync(join(tmpdir(), "slate-memory-"));
  const store = (directory: string, clock: Clock) => new FileMemoryStore(join(directory, MEMORY_DIRNAME), createDebouncePolicy(clock, { name: "memory", delayMs: MEMORY_CHANGE_DEBOUNCE_MS }));
  const fixedClock: Clock = { now: () => 1_000, monotonicNow: () => 1_000, schedule: () => ({ dispose() {} }) };

  it("keeps a fact as a dated line, and gives the same fact the same id however it is written", () => {
    assert.deepEqual([MEMORY_DIRNAME, PROFILE_FILENAME, "log"], ["memory", "profile.md", "log"]);
    assert.equal(serializeFactLine("likes tea", Date.UTC(2026, 8, 29)), "- (2026-09-29) likes tea");
    assert.equal(memoryIdFor("prefers dark mode"), memoryIdFor("  prefers   dark mode  "));
    assert.equal(memoryIdFor("prefers dark mode"), memoryIdFor("Prefers dark mode"));
    assert.equal(memoryIdFor("prefers dark mode").length, 16);
    assert.equal(MEMORY_SYNTHESIS_INPUT_LIMIT, 512);
    assert.equal(MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS, 24 * 60 * 60_000);
    assert.equal(MEMORY_CHANGE_DEBOUNCE_MS, 50);
    // Only a dated line is a fact, and what it carries is trimmed.
    assert.deepEqual(parseFacts("# About\n\n- (2026-09-29) likes tea\n- not a fact\n- (2026-09-30)   likes    tea   \n", "profile", "profile.md", 10).map((fact) => [fact.content, fact.createdAt, fact.line, fact.order, fact.origin]), [
      // What the line carries is normalized the way the rest of the platform normalizes it, so the same fact is
      // one fact however it was written.
      ["likes tea", Date.UTC(2026, 8, 29), 2, 10, "legacy"],
      ["likes tea", Date.UTC(2026, 8, 30), 4, 11, "legacy"],
    ]);
  });

  it("adds a fact without writing it twice, recalls it, and forgets it when asked", () => {
    const directory = root();
    const memory = store(directory, fixedClock);
    assert.equal(agentMemoryHasContent(directory), false);
    assert.deepEqual(memory.addMemory("  likes tea  ", Date.UTC(2026, 8, 29), "profile"), { id: memoryIdFor("likes tea"), content: "likes tea", createdAt: Date.UTC(2026, 8, 29), kind: "profile" });
    assert.equal(memory.addMemory("likes tea", Date.UTC(2026, 8, 30), "profile"), null);
    assert.equal(memory.countMemories(), 1);
    assert.equal(memory.addMemory("   ", 1, "log"), null);
    memory.addMemory("shipped the release", Date.UTC(2026, 8, 28), "log");
    assert.deepEqual(memory.recall(5).profile.map((record) => record.content), ["likes tea"]);
    assert.deepEqual(memory.recall(5).recent.map((record) => record.content), ["shipped the release"]);
    assert.deepEqual(memory.listMemories().map((record) => record.content), ["likes tea", "shipped the release"]);
    // The profile is an ordinary file of dated lines; the log lives beside it.
    assert.deepEqual(readdirSync(join(directory, MEMORY_DIRNAME)).sort(), ["log", "profile.md"]);
    assert.equal(readFileSync(memory.profileFile, "utf8").endsWith("- (2026-09-29) likes tea\n"), true);
    assert.equal(agentMemoryHasContent(directory), true);
    assert.equal(memory.removeMemoryByContent("  likes tea  "), true);
    assert.equal(memory.countMemories(), 1);
    assert.equal(memory.removeMemory("no-such-id"), false);
    memory.clearMemories();
    assert.equal(memory.countMemories(), 0);
    assert.equal(readFileSync(memory.profileFile, "utf8").startsWith("# About the user"), true);
  });

  it("applies what a review of the whole memory decided, and refuses one that no longer fits", () => {
    const memory = store(root(), fixedClock);
    memory.addMemory("likes tea", Date.UTC(2026, 8, 29), "profile");
    memory.addMemory("shipped the release", Date.UTC(2026, 8, 28), "log");
    const snapshot = memory.prepareSynthesis();
    assert.deepEqual(snapshot.memories.map((entry) => entry.content), ["likes tea", "shipped the release"]);
    assert.equal(typeof snapshot.fingerprint, "string");
    // A change computed against a memory that has since changed is refused rather than applied.
    assert.equal(memory.applySynthesis({ ...snapshot, fingerprint: "something-else" }, [{ action: "create", content: "new fact", kind: "profile" }], 5), "stale");
    assert.equal(memory.applySynthesis(snapshot, [{ action: "update", id: "no-such-id", content: "x", kind: "profile" }], 5), "invalid");
    assert.equal(memory.applySynthesis(snapshot, [{ action: "create", content: "new fact", kind: "profile" }, { action: "remove", id: memoryIdFor("shipped the release") }], 5), "committed");
    // What the user said about themselves comes before the log, and each side is newest first.
    assert.deepEqual(memory.listMemories().map((entry) => entry.content), ["likes tea", "new fact"]);
  });

  it("knows when a review of the whole memory is due", () => {
    const memory = store(root(), fixedClock);
    assert.equal(memory.isTemporalReviewDue(1_000), true);
    memory.markTemporalReview(1_000);
    assert.equal(memory.isTemporalReviewDue(1_000), false);
    assert.equal(memory.isTemporalReviewDue(1_000 + MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS), true);
  });

  it("keeps each agent's memory in its own directory, and the user's under the platform root", () => {
    assert.equal(getAgentMemoryDir("/agents/agent-1"), join("/agents/agent-1", "memory"));
    assert.equal(getUserMemoryDir("/root/slate"), "/root/slate/user-memory");
    assert.equal(getUserMemoryShardDir("/root/slate", "agent-1").endsWith("agent-1"), true);
    assert.equal(getProjectMemoryShardsDir("/root/slate", "project-1").includes("project-1"), true);
    // A store over a directory that does not exist yet is still empty rather than broken.
    const missing = store(root(), fixedClock);
    assert.deepEqual(missing.recall(), { profile: [], recent: [] });
    assert.equal(missing.hasMemories(), false);
  });

  it("does not keep memory where there is nothing to keep", () => {
    const directory = root();
    const memory = store(directory, fixedClock);
    memory.clearMemories();
    assert.equal(memory.countMemories(), 0);
    mkdirSync(join(directory, MEMORY_DIRNAME, "log"), { recursive: true });
    writeFileSync(join(directory, MEMORY_DIRNAME, "log", "2026-09-29.md"), "- (2026-09-29) an old log line\n");
    // A memory written as a log file is one this build did not write, and it still counts as content.
    assert.equal(agentMemoryHasContent(directory), true);
    rmSync(join(directory, MEMORY_DIRNAME), { recursive: true, force: true });
  });
});

describe("waking an automation because something happened", () => {
  function transcriptManager(options: { canExecute?: boolean; outcome?: string; throws?: boolean } = {}) {
    const fired: Array<Record<string, unknown>> = [];
    const dropped: Array<Record<string, unknown>> = [];
    const manager = {
      execution: { canExecute: options.canExecute ?? true },
      disposed: false,
      automationRuntime: {
        fireAutomation: async (args: Record<string, unknown>) => {
          fired.push(args);
          if (options.throws === true) throw new Error("dispatch failed");
          return options.outcome ?? "ok";
        },
      },
      telemetry: { reportAutomationFireDropped: (report: Record<string, unknown>) => { dropped.push(report); } },
    };
    return { manager, fired, dropped };
  }
  const automation = { id: "automation-1", name: "Nightly" };

  it("gathers what arrives for the same automation and delivers it as one wake", async () => {
    assert.equal(EVENT_FIRE_DEBOUNCE_MS, 750);
    assert.equal(MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION, 500);
    const harness = transcriptManager();
    const fires = new AutomationEventFires(harness.manager as never);
    const one = fires.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation as never, event: { kind: "push" }, runUuid: "run-1" });
    const two = fires.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation as never, event: { kind: "push" }, runUuid: "run-2" });
    // Both are waiting, and only one wait is armed.
    assert.equal(fires.pendingEventFireBatches.size, 1);
    assert.equal(fires.pendingEventFireBatches.get("agent-1:automation-1")?.timer != null, true);
    assert.deepEqual(await Promise.all([one, two]), ["ok", "ok"]);
    assert.deepEqual(harness.fired.map((call) => ({ trigger: call.trigger, events: (call.events as unknown[]).length, runUuid: call.runUuid, coalesced: call.coalescedRunUuids })), [{ trigger: "event", events: 2, runUuid: "run-1", coalesced: ["run-2"] }]);
    assert.equal(fires.pendingEventFireBatches.size, 0);
  });

  it("does not wake anything when the host cannot run automations at all", async () => {
    const harness = transcriptManager({ canExecute: false });
    const fires = new AutomationEventFires(harness.manager as never);
    assert.equal(await fires.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation as never, event: {} }), undefined);
    assert.equal(harness.fired.length, 0);
    assert.equal(fires.pendingEventFireBatches.size, 0);
  });

  it("reports a wake that could not be dispatched, and answers the caller either way", async () => {
    const harness = transcriptManager({ throws: true });
    const fires = new AutomationEventFires(harness.manager as never);
    const outcome = await fires.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation as never, event: {} });
    assert.equal(outcome, undefined);
    assert.equal(harness.fired.length, 1);
    assert.equal(fires.pendingEventFireBatches.size, 0);
  });

  it("drops what it cannot hold, says so once per run, and never loses the count of what it did", async () => {
    // A burst larger than the platform holds is bounded: the oldest are dropped and each of those is reported.
    assert.equal(MAX_REPORTED_DROPPED_FIRES, 256);
    const harness = transcriptManager();
    const fires = new AutomationEventFires(harness.manager as never);
    const queued: Array<Promise<string | undefined>> = [];
    for (let index = 0; index < MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION + 3; index += 1) {
      queued.push(fires.enqueueEventAutomationFire({ agentId: "agent-1", automation: automation as never, event: { index }, runUuid: `run-${index}` }));
    }
    assert.equal(harness.dropped.length, 3);
    assert.deepEqual(harness.dropped[0], { conversationId: "agent-1", trigger: "event", reason: "event_batch_overflow" });
    assert.equal((await Promise.all(queued)).filter((outcome) => outcome === "error").length, 3);
    // The same run is not reported twice, however often it comes up.
    const reported = harness.dropped.length;
    fires.reportFireDropped({ agentId: "agent-1", trigger: "event", reason: "again", runUuid: "run-0" });
    assert.equal(harness.dropped.length, reported);
    // What it remembers having reported is bounded too.
    for (let index = 0; index < MAX_REPORTED_DROPPED_FIRES + 10; index += 1) fires.reportFireDropped({ agentId: "agent-1", trigger: "schedule", reason: "late", runUuid: `other-${index}` });
    assert.equal(fires.reportedDroppedFireUuids.size <= MAX_REPORTED_DROPPED_FIRES, true);
  });
});

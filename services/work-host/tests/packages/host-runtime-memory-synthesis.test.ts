/**
 * Reviewing an agent's memory as a whole: what the review is given, what it may propose, what is accepted, and what is
 * reported about every attempt.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_PENDING_AGENTS, MAX_PENDING_EVIDENCE_PER_AGENT, MAX_TEMPORAL_TARGETS_PER_SWEEP, MEMORY_SYNTHESIS_DEBOUNCE_MS, MEMORY_SYNTHESIS_DEADLINE_MS, MEMORY_SYNTHESIS_POLL_INTERVAL_MS, MEMORY_SYNTHESIS_PROMPT_MARKER, MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS, MEMORY_SYNTHESIS_RETRY_ATTEMPTS, MEMORY_SYNTHESIS_VERIFICATION_PROMPT_MARKER, MemorySynthesisAttemptError, MemorySynthesisService, boundedEvidenceText, currentDate, memorySynthesisTelemetryReport, normalizedChanges, parseJsonObject, parseMemorySynthesisChanges, synthesisSystemPrompt, usesKnownEvidence, verificationSystemPrompt, type SynthesisTarget } from "../../source/host/memory/memory-synthesis-service.ts";

const until = (ms = 10) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A memory an agent can recall, as the review sees it. */
function target(options: { memories?: boolean; due?: boolean; apply?: "committed" | "stale" | "invalid" } = {}) {
  const calls: string[] = [];
  const applied: Array<{ snapshot: unknown; changes: readonly unknown[]; now: number }> = [];
  const value: SynthesisTarget = {
    prepareSynthesis: () => { calls.push("prepare"); return { fingerprint: "fingerprint-1", memories: (options.memories ?? true) ? [{ id: "memory-1", content: "likes tea", createdAt: 1, kind: "profile", origin: "legacy" }] : [] }; },
    applySynthesis: (snapshot, changes, now) => { calls.push("apply"); applied.push({ snapshot, changes, now }); return options.apply ?? "committed"; },
    hasMemories: () => options.memories ?? true,
    isTemporalReviewDue: () => options.due ?? false,
    markTemporalReview: () => { calls.push("marked"); },
  };
  return { value, calls, applied };
}

describe("the review of an agent's memory as a whole", () => {
  it("bounds what the review is given, and takes the middle out of anything long", () => {
    const prompt = synthesisSystemPrompt();
    assert.equal(prompt.startsWith(MEMORY_SYNTHESIS_PROMPT_MARKER), true);
    assert.equal(prompt.includes('{"changes":[...]}'), true);
    assert.equal(verificationSystemPrompt().startsWith(MEMORY_SYNTHESIS_VERIFICATION_PROMPT_MARKER), true);
    assert.equal(verificationSystemPrompt().includes('{"approved":true}'), true);
    // What the review is given is trimmed, and a long exchange keeps its beginning and its end.
    assert.equal(boundedEvidenceText("  hello  "), "hello");
    // One side of an exchange is kept to a bounded length — beginning and end, with the middle left out.
    const kept = "x".repeat(8_000);
    assert.equal(boundedEvidenceText(kept), kept);
    const long = "y".repeat(20_000);
    const bounded = boundedEvidenceText(long);
    assert.equal(bounded.includes("[...middle omitted...]"), true);
    assert.equal(bounded.startsWith("y"), true);
    assert.equal(bounded.endsWith("y"), true);
    assert.equal(bounded.length < long.length, true);
    assert.equal(currentDate(Date.UTC(2026, 8, 29, 12)), "2026-09-29");
    // The review's scheduling is the platform's, not the caller's.
    assert.deepEqual([MEMORY_SYNTHESIS_DEBOUNCE_MS, MEMORY_SYNTHESIS_DEADLINE_MS, MEMORY_SYNTHESIS_POLL_INTERVAL_MS, MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS, MEMORY_SYNTHESIS_RETRY_ATTEMPTS, MAX_PENDING_AGENTS, MAX_PENDING_EVIDENCE_PER_AGENT, MAX_TEMPORAL_TARGETS_PER_SWEEP], [15_000, 90_000, 3_600_000, 86_400_000, 3, 64, 12, 4]);
  });

  it("reads what the review proposed, and refuses anything it could not act on", () => {
    assert.deepEqual(parseJsonObject('```json\n{"changes":[]}\n```'), { changes: [] });
    assert.equal(parseJsonObject("no object here"), null);
    assert.equal(parseJsonObject("[1,2]"), null);
    const created = parseMemorySynthesisChanges({ changes: [{ action: "create", content: "  likes tea  ", kind: "profile", sourceEvidenceIds: ["e1"] }] });
    assert.deepEqual(created, [{ action: "create", content: "  likes tea  ", kind: "profile", sourceEvidenceIds: ["e1"] }]);
    // What is applied is normalized, so the same fact is one fact.
    assert.deepEqual(normalizedChanges(created ?? []), [{ action: "create", content: "likes tea", kind: "profile", sourceEvidenceIds: ["e1"] }]);
    assert.deepEqual(parseMemorySynthesisChanges({ changes: [{ action: "remove", id: "memory-1", sourceEvidenceIds: ["e1"] }] }), [{ action: "remove", id: "memory-1", sourceEvidenceIds: ["e1"] }]);
    // A proposal that is not a list of well-formed changes is not a proposal.
    assert.equal(parseMemorySynthesisChanges(null), null);
    assert.equal(parseMemorySynthesisChanges({ changes: "nope" }), null);
    assert.equal(parseMemorySynthesisChanges({ changes: [{ action: "create", content: "x", kind: "profile" }] }), null);
    assert.equal(parseMemorySynthesisChanges({ changes: [{ action: "create", content: "x", kind: "notes", sourceEvidenceIds: ["e1"] }] }), null);
    assert.equal(parseMemorySynthesisChanges({ changes: [{ action: "remove", id: "", sourceEvidenceIds: ["e1"] }] }), null);
    assert.equal(parseMemorySynthesisChanges({ changes: [{ action: "create", content: "", kind: "log", sourceEvidenceIds: ["e1"] }] }), null);
    assert.equal(parseMemorySynthesisChanges({ changes: [{ action: "update", content: "x", kind: "log", sourceEvidenceIds: ["e1"] }] }), null);
    assert.equal(parseMemorySynthesisChanges({ changes: [{ action: "create", content: "x".repeat(501), kind: "log", sourceEvidenceIds: ["e1"] }] }), null);
    assert.equal(parseMemorySynthesisChanges({ changes: [{ action: "create", content: "x", kind: "log", sourceEvidenceIds: ["e".repeat(65)] }] }), null);
    assert.equal(parseMemorySynthesisChanges({ changes: Array.from({ length: 65 }, () => ({ action: "create", content: "x", kind: "log", sourceEvidenceIds: ["e1"] })) }), null);
  });

  it("only accepts a proposal that cites evidence the review was given", () => {
    const known = new Set(["e1", "e2"]);
    assert.equal(usesKnownEvidence(known, [{ action: "create", content: "x", kind: "log", sourceEvidenceIds: ["e1"] }], false), true);
    // A change that cites nothing, or something the review never saw, is not acceptable.
    assert.equal(usesKnownEvidence(known, [{ action: "create", content: "x", kind: "log", sourceEvidenceIds: [] }], false), false);
    assert.equal(usesKnownEvidence(known, [{ action: "create", content: "x", kind: "log", sourceEvidenceIds: ["e9"] }], false), false);
    // A review that was asked about the clock may cite it — but not for something entirely new.
    assert.equal(usesKnownEvidence(known, [{ action: "update", id: "m1", content: "x", kind: "log", sourceEvidenceIds: ["clock"] }], true), true);
    assert.equal(usesKnownEvidence(known, [{ action: "create", content: "x", kind: "log", sourceEvidenceIds: ["clock"] }], true), false);
    assert.equal(usesKnownEvidence(known, [{ action: "create", content: "x", kind: "log", sourceEvidenceIds: ["e1", "clock"] }], true), true);
    assert.equal(usesKnownEvidence(known, [{ action: "update", id: "m1", content: "x", kind: "log", sourceEvidenceIds: ["clock"] }], false), false);
  });

  it("reports an attempt as the platform's own outcome and cause", () => {
    // A review that did its work, and one that had nothing to do, are both an ordinary outcome.
    assert.deepEqual(memorySynthesisTelemetryReport({ outcome: "committed", durationMs: 12, changeCount: 3 }), { outcome: "ok", durationMs: 12, itemCount: 3 });
    assert.deepEqual(memorySynthesisTelemetryReport({ outcome: "no-work", durationMs: 1, changeCount: 0 }), { outcome: "ok", durationMs: 1, itemCount: 0 });
    // Evidence that could not be kept is shed rather than failed.
    const shed = memorySynthesisTelemetryReport({ outcome: "dropped", evidenceCount: 2, durationMs: 0, changeCount: 0 }) as { outcome: string; itemCount: number };
    assert.deepEqual({ outcome: shed.outcome, itemCount: shed.itemCount }, { outcome: "shed", itemCount: 2 });
    for (const outcome of ["invalid-output", "rejected", "stale", "failed"]) {
      const report = memorySynthesisTelemetryReport({ outcome, durationMs: 5, changeCount: 1 }) as { outcome: string; cause?: unknown };
      assert.equal(report.outcome, "failed");
      assert.equal(typeof report.cause, "object");
    }
    // An attempt that went wrong says which outcome it was and how much it proposed.
    const error = new MemorySynthesisAttemptError("rejected", 4);
    assert.equal(error.name, "MemorySynthesisAttemptError");
    assert.deepEqual({ outcome: error.outcome, proposed: error.proposedCount, message: error.message }, { outcome: "rejected", proposed: 4, message: "Memory synthesis attempt rejected" });
  });
});

describe("running the review", () => {
  function service(options: { propose?: (request: { newEvidence: readonly { id: string }[] }) => Promise<unknown>; verify?: () => Promise<boolean>; targets?: Array<[string, SynthesisTarget]>; apply?: "committed" | "stale" | "invalid"; run?: (agentId: string, evidence: readonly unknown[]) => Promise<void>; withoutGetTarget?: boolean } = {}) {
    const reports: Array<Record<string, unknown>> = [];
    const targets = new Map(options.targets ?? []);
    const instance = new MemorySynthesisService({
      now: () => 1_000,
      // A review is asked for by the test, so the trigger only records that it was asked for.
      debounce: { wrap: () => Object.assign(() => {}, { dispose: () => {} }) },
      listTargets: () => [...targets].map(([agentId, value]) => ({ agentId, target: value })),
      ...(options.withoutGetTarget === true ? {} : { getTarget: (agentId: string) => targets.get(agentId) ?? null }),
      propose: (options.propose ?? (async () => ({ changes: [] }))) as never,
      ...(options.verify === undefined ? {} : { verify: options.verify }),
      ...(options.run === undefined ? {} : { run: options.run }),
      report: (event) => { reports.push(event as Record<string, unknown>); },
    });
    return { instance, reports, targets };
  }

  it("runs the review over what was recorded, applies what it proposed, and says what happened", async () => {
    const memory = target();
    const propose = async (request: { newEvidence: readonly { id: string }[] }) => ({ changes: [{ action: "create", content: "likes tea", kind: "profile", sourceEvidenceIds: [request.newEvidence[0]?.id ?? ""] }] });
    const { instance, reports } = service({ targets: [["agent-1", memory.value]], propose });
    instance.start();
    instance.recordTurn("agent-1", { id: "evidence-1", user: "I like tea", assistant: "Noted.", occurredAt: 1 });
    assert.deepEqual(await instance.runNow(), ["committed"]);
    assert.deepEqual(memory.calls, ["prepare", "apply"]);
    assert.equal(memory.applied[0]?.changes.length, 1);
    assert.equal(memory.applied[0]?.now, 1_000);
    assert.deepEqual(reports.map((report) => [report.outcome, report.agentId, report.evidenceCount, report.inputMemoryCount, report.changeCount, report.durationMs]), [["committed", "agent-1", 1, 1, 1, 0]]);
    // What was reviewed is not reviewed again.
    assert.deepEqual(await instance.runNow(), []);
    instance.dispose();
  });

  it("refuses a proposal the platform cannot act on, and asks again later", async () => {
    // A change that cites evidence the review never saw is not applied.
    const unknownEvidence = target();
    const { instance: stray } = service({ targets: [["agent-1", unknownEvidence.value]], propose: async () => ({ changes: [{ action: "create", content: "x", kind: "log", sourceEvidenceIds: ["never-seen"] }] }) });
    stray.start();
    stray.recordTurn("agent-1", { user: "hello", assistant: "hi", occurredAt: 1 });
    assert.deepEqual(await stray.runNow(), ["invalid-output"]);
    // Nothing is marked as reviewed: this was a turn's news, not a review of the whole memory.
    assert.deepEqual(unknownEvidence.calls, ["prepare"]);
    stray.dispose();

    // A review that the platform's own verifier turns down is not applied either.
    const rejected = target();
    const { instance: refused } = service({ targets: [["agent-1", rejected.value]], propose: async () => ({ changes: [{ action: "create", content: "x", kind: "log", sourceEvidenceIds: ["e1"] }] }), verify: async () => false });
    refused.start();
    refused.recordTurn("agent-1", { id: "e1", user: "hello", assistant: "hi", occurredAt: 1 });
    assert.deepEqual(await refused.runNow(), ["rejected"]);
    assert.deepEqual(rejected.calls, ["prepare"]);
    refused.dispose();

    // A memory that moved under the review is asked about again, and one the review could not apply is marked reviewed.
    const stale = target({ apply: "stale" });
    const { instance: moved } = service({ targets: [["agent-1", stale.value]], propose: async () => ({ changes: [{ action: "create", content: "x", kind: "log", sourceEvidenceIds: ["e1"] }] }) });
    moved.start();
    moved.recordTurn("agent-1", { id: "e1", user: "hello", assistant: "hi", occurredAt: 1 });
    assert.deepEqual(await moved.runNow(), ["stale"]);
    assert.deepEqual(stale.calls, ["prepare", "apply"]);
    moved.dispose();

    // A review that threw is reported as a failure rather than as nothing to do.
    const reports: Array<Record<string, unknown>> = [];
    const failing = new MemorySynthesisService({
      now: () => 1_000,
      // A review is asked for by the test, so the trigger only records that it was asked for.
      debounce: { wrap: () => Object.assign(() => {}, { dispose: () => {} }) },
      getTarget: () => target().value,
      propose: async () => { throw new Error("the platform refused"); },
      report: (event) => { reports.push(event as Record<string, unknown>); },
    });
    failing.start();
    failing.recordTurn("agent-1", { user: "hello", assistant: "hi", occurredAt: 1 });
    assert.deepEqual(await failing.runNow(), ["failed"]);
    assert.deepEqual(reports.map((report) => report.outcome), ["failed"]);
    failing.dispose();
  });

  it("has nothing to do when there is no memory and no news, and leaves the agent alone", async () => {
    // An agent with nothing to recall is not queued for a review at all, however overdue one would be.
    const empty = target({ memories: false, due: true });
    const { instance, reports } = service({ targets: [["agent-1", empty.value]] });
    instance.start();
    assert.deepEqual(await instance.runNow(), []);
    assert.deepEqual(reports, []);
    assert.equal(empty.calls.length, 0);
    // A review nobody asked for is not run at all.
    const unknown = service();
    unknown.instance.start();
    unknown.instance.recordTurn("agent-9", { user: "hello", assistant: "hi", occurredAt: 1 });
    assert.deepEqual(await unknown.instance.runNow(), ["no-work"]);
    assert.deepEqual(unknown.reports, []);
    unknown.instance.dispose();
  });

  it("lets the platform run the review itself, and reports how that went", async () => {
    const seen: Array<[string, number]> = [];
    const { instance, reports } = service({ run: async (agentId, evidence) => { seen.push([agentId, evidence.length]); }, withoutGetTarget: true });
    instance.start();
    instance.recordTurn("agent-1", { user: "hello", assistant: "hi", occurredAt: 1 });
    instance.recordTurn("agent-1", { user: "again", assistant: "yes", occurredAt: 2 });
    assert.deepEqual(await instance.runNow(), ["committed"]);
    assert.deepEqual(seen, [["agent-1", 2]]);
    assert.deepEqual(reports.map((report) => report.outcome), ["committed"]);
    instance.dispose();
    // A review that failed is reported as a failure, and the evidence is not kept for ever.
    const failing = service({ run: async () => { throw new Error("no runner"); }, withoutGetTarget: true });
    failing.instance.start();
    failing.instance.recordTurn("agent-1", { user: "hello", assistant: "hi", occurredAt: 1 });
    assert.deepEqual(await failing.instance.runNow(), ["failed"]);
    assert.deepEqual(failing.reports.map((report) => report.outcome), ["failed"]);
    failing.instance.dispose();
  });

  it("keeps a bounded amount of news, and says what it had to drop", async () => {
    const memory = target();
    const { instance, reports } = service({ targets: [["agent-1", memory.value]] });
    instance.start();
    for (let index = 0; index < MAX_PENDING_EVIDENCE_PER_AGENT + 3; index += 1) {
      instance.recordTurn("agent-1", { id: `evidence-${index}`, user: `turn ${index}`, assistant: "ok", occurredAt: index });
    }
    // What goes past the bound is reported as shed rather than silently forgotten.
    assert.deepEqual(reports.filter((report) => report.outcome === "dropped").map((report) => report.evidenceCount), [1, 1, 1]);
    // What is kept is the bound, not everything that was said: the review that follows is given twelve exchanges.
    const seen: number[] = [];
    const bounded = new MemorySynthesisService({
      now: () => 1_000,
      debounce: { wrap: () => Object.assign(() => {}, { dispose: () => {} }) },
      getTarget: () => memory.value,
      propose: async (request: { newEvidence: readonly unknown[] }) => { seen.push(request.newEvidence.length); return { changes: [] }; },
      report: () => {},
    });
    bounded.start();
    for (let index = 0; index < MAX_PENDING_EVIDENCE_PER_AGENT + 3; index += 1) bounded.recordTurn("agent-1", { id: `evidence-${index}`, user: `turn ${index}`, assistant: "ok", occurredAt: index });
    await bounded.runNow();
    assert.deepEqual(seen, [MAX_PENDING_EVIDENCE_PER_AGENT]);
    bounded.dispose();
    // A turn with nothing in it is not news at all.
    reports.length = 0;
    instance.recordTurn("agent-1", { user: "   ", assistant: "", occurredAt: 1 });
    assert.deepEqual(reports, []);
    instance.dispose();
    // Agents past the bound push the oldest one out, and that is reported too.
    const many = service();
    many.instance.start();
    for (let index = 0; index < MAX_PENDING_AGENTS + 2; index += 1) many.instance.recordTurn(`agent-${index}`, { user: "hello", assistant: "hi", occurredAt: 1 });
    const dropped = many.reports.filter((report) => report.outcome === "dropped");
    assert.deepEqual(dropped.map((report) => report.agentId), ["agent-0", "agent-1"]);
    many.instance.dispose();
  });

  it("does nothing before it is started, nothing after it is disposed, and nothing twice at once", async () => {
    const memory = target();
    const { instance } = service({ targets: [["agent-1", memory.value]] });
    // Before it is started there is no review to run and nothing is kept.
    assert.deepEqual(await instance.runNow(), []);
    instance.recordTurn("agent-1", { user: "hello", assistant: "hi", occurredAt: 1 });
    assert.deepEqual(await instance.runNow(), []);
    instance.start();
    instance.recordTurn("agent-1", { id: "e1", user: "hello", assistant: "hi", occurredAt: 1 });
    // Two asks while one review is running are one review.
    const [first, second] = await Promise.all([instance.runNow(), instance.runNow()]);
    assert.equal(second, first);
    // Once disposed, nothing new is taken on and the review stops being run.
    instance.dispose();
    instance.recordTurn("agent-1", { user: "later", assistant: "no", occurredAt: 2 });
    assert.deepEqual(await instance.runNow(), []);
    instance.dispose();
    assert.equal(instance.options.now?.() ?? 1_000, 1_000);
  });

  it("queues the agents whose memory is due a review of the whole thing, up to the platform's bound", async () => {
    const dueTargets = Array.from({ length: 6 }, () => target({ due: true }));
    const due = dueTargets.map((value, index) => [`agent-${index}`, value.value] as [string, SynthesisTarget]);
    const notDue = target({ due: false });
    const empty = target({ memories: false, due: true });
    const { instance } = service({ targets: [...due, ["agent-not-due", notDue.value], ["agent-empty", empty.value]] });
    instance.start();
    // Only the ones that have memories and are due are queued, and only as many as the platform reviews at a time.
    assert.equal(MAX_TEMPORAL_TARGETS_PER_SWEEP, 4);
    assert.equal(notDue.calls.length, 0);
    assert.equal(empty.calls.length, 0);
    // A review that is due is run with no news at all, and the agent is marked as reviewed — but only as many of them
    // as the platform reviews at a time.
    await instance.runNow();
    assert.deepEqual(dueTargets.map((value) => value.calls.includes("marked")), [true, true, true, true, false, false]);
    instance.dispose();
  });
});

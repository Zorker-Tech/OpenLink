import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectSlateSentryEnvelope } from "../../source/shared/observability/sentry-scrub.gen.ts";
import {
  MAX_SPOOL_PURGE_SHIFTS,
  SENTRY_EVENT_ID_PATTERN,
  SLATE_SENTRY_CONVERSATION_TAG,
  SLATE_SENTRY_DSN,
  SlateSentryAccountPrivacySync,
  SlateSentryEventIdRing,
  SlateSentryPrivacyGate,
  captureOfflineSpoolStore,
  envelopeAccount,
  gateEnvelopeSend,
  gateTransport,
  isUnknownProcessEnvelope,
  purgeableSpoolStore,
} from "../../source/shared/observability/sentry.ts";
import type { SlateSentryEnvelope, SlateSentrySpoolStore } from "../../source/shared/observability/sentry.ts";

type Item = [Record<string, unknown>, unknown];
const envelope = (...items: Item[]): SlateSentryEnvelope => [{ sent_at: "2026-01-01T00:00:00Z" }, items];
const event = (payload: Record<string, unknown> = {}) => envelope([{ type: "event" }, payload]);

function memoryStore() {
  const queue: unknown[] = [];
  const pushed: unknown[] = [];
  const unshifted: unknown[] = [];
  return {
    queue,
    pushed,
    unshifted,
    store: {
      push(value: unknown) { pushed.push(value); queue.push(value); return value; },
      async unshift(value: unknown) { unshifted.push(value); queue.unshift(value); return value; },
      async shift() { return queue.shift(); },
    } satisfies SlateSentrySpoolStore,
  };
}

describe("the Slate telemetry boundary", () => {
  it("keeps telemetry disabled without a configured DSN and uses Slate-owned envelope tags", () => {
    assert.equal(SLATE_SENTRY_DSN, "");
    assert.equal(SLATE_SENTRY_CONVERSATION_TAG, "slate.conversation_id");
    assert.equal(MAX_SPOOL_PURGE_SHIFTS, 64);
    assert.equal(SENTRY_EVENT_ID_PATTERN.test("a".repeat(32)), true);
    assert.equal(SENTRY_EVENT_ID_PATTERN.test("A".repeat(32)), false);
    assert.equal(SENTRY_EVENT_ID_PATTERN.test("a".repeat(31)), false);
  });

  it("drops unknown-process events but leaves other envelope items alone", () => {
    assert.equal(isUnknownProcessEnvelope(event({ tags: { "event.process": "unknown" } })), true);
    assert.equal(isUnknownProcessEnvelope(event({ tags: { "event.process": "main" } })), false);
    assert.equal(isUnknownProcessEnvelope(envelope([{ type: "session" }, { tags: { "event.process": "unknown" } }])), false);
    assert.equal(isUnknownProcessEnvelope(envelope([{ type: "event" }, null])), false);
  });

  it("matches the current identity across event and session entries", () => {
    assert.equal(envelopeAccount(event({ user: { id: "user-1" } }), "user-1"), "match");
    assert.equal(envelopeAccount(envelope([{ type: "session" }, { did: 7 }]), "7"), "match");
    assert.equal(envelopeAccount(event({ user: { id: "user-2" } }), "user-1"), "mismatch");
    assert.equal(envelopeAccount(event({ user: { id: "user-1" } }), undefined), "match");
    assert.equal(envelopeAccount(event({ tags: {} }), "user-1"), "missing");
  });

  it("lets any mismatched identity override an earlier match", () => {
    const mixed = envelope(
      [{ type: "event" }, { user: { id: "user-1" } }],
      [{ type: "session" }, { did: "another-user" }],
    );
    assert.equal(envelopeAccount(mixed, "user-1"), "mismatch");
  });

  it("ignores identities in unsupported entry shapes", () => {
    const unsupported = envelope(
      [{ type: "transaction" }, { user: { id: "user-1" }, did: "user-1" }],
      [{ type: "event" }, { user: { id: [] } }],
      [{ type: "session" }, { did: null }],
    );
    assert.equal(envelopeAccount(unsupported, "user-1"), "missing");
  });

  it("defaults to fatal metadata and suppresses unknown-process envelopes", () => {
    const gate = new SlateSentryPrivacyGate();
    const ordinary = event({ event_id: "a".repeat(32), message: "failure" });
    const unknown = event({ tags: { "event.process": "unknown" } });
    assert.deepEqual(gate.handle(ordinary), projectSlateSentryEnvelope(ordinary, "fatal-metadata"));
    assert.equal(gate.handle(unknown), undefined);
  });

  it("uses the requested tier only for a matching account", () => {
    const gate = new SlateSentryPrivacyGate();
    gate.setTier("full");
    gate.setUserId("user-1");
    const matching = event({ user: { id: "user-1" }, message: "current" });
    const missing = event({ message: "no identity" });
    const mismatch = event({ user: { id: "user-2" }, message: "other account" });
    assert.deepEqual(gate.handle(matching), projectSlateSentryEnvelope(matching, "full"));
    assert.deepEqual(gate.handle(missing), projectSlateSentryEnvelope(missing, "scrubbed"));
    assert.deepEqual(gate.handle(mismatch), projectSlateSentryEnvelope(mismatch, "fatal-metadata"));
  });

  it("uses the configured tier for a missing account and reports account ownership separately", () => {
    const gate = new SlateSentryPrivacyGate();
    gate.setTier("scrubbed");
    gate.setUserId("user-1");
    const missing = event({ message: "no identity" });
    assert.deepEqual(gate.handle(missing), projectSlateSentryEnvelope(missing, "scrubbed"));
    assert.equal(gate.belongsToCurrentAccount(event({ user: { id: "user-1" } })), true);
    assert.equal(gate.belongsToCurrentAccount(missing), false);
    assert.equal(gate.belongsToCurrentAccount(event({ user: { id: "user-2" } })), false);
    const noIdentityConfigured = new SlateSentryPrivacyGate();
    assert.equal(noIdentityConfigured.belongsToCurrentAccount(missing), true);
  });

  it("does not send or acknowledge envelopes rejected by the privacy gate", async () => {
    const gate = new SlateSentryPrivacyGate();
    const sent: SlateSentryEnvelope[] = [];
    const accepted: SlateSentryEnvelope[] = [];
    const send = gateEnvelopeSend(gate, async (value) => { sent.push(value); return "sent"; }, (value) => accepted.push(value));
    assert.deepEqual(await send(event({ tags: { "event.process": "unknown" } })), {});
    assert.deepEqual([sent, accepted], [[], []]);
  });

  it("sends the projected envelope but acknowledges only the active account's data", async () => {
    const gate = new SlateSentryPrivacyGate();
    gate.setTier("full");
    gate.setUserId("user-1");
    const sent: SlateSentryEnvelope[] = [];
    const accepted: SlateSentryEnvelope[] = [];
    const send = gateEnvelopeSend(gate, async (value) => { sent.push(value); return "ok"; }, (value) => accepted.push(value));
    const matching = event({ level: "error", user: { id: "user-1" }, message: "mine" });
    const mismatched = event({ level: "fatal", user: { id: "user-2" }, message: "not mine" });
    assert.equal(await send(matching), "ok");
    assert.equal(await send(mismatched), "ok");
    assert.deepEqual(accepted, [projectSlateSentryEnvelope(matching, "full")]);
    assert.deepEqual(sent, [
      projectSlateSentryEnvelope(matching, "full"),
      projectSlateSentryEnvelope(mismatched, "fatal-metadata"),
    ]);
  });

  it("wraps transport sends without dropping other transport properties", async () => {
    const gate = new SlateSentryPrivacyGate();
    const sent: SlateSentryEnvelope[] = [];
    const transport = {
      label: "offline-transport",
      async send(value: SlateSentryEnvelope) { sent.push(value); return "sent"; },
    };
    const wrapped = gateTransport(gate, transport);
    assert.equal(wrapped.label, transport.label);
    const input = event({ level: "fatal", message: "failure" });
    assert.equal(await wrapped.send(input), "sent");
    assert.deepEqual(sent, [projectSlateSentryEnvelope(input, "fatal-metadata")]);
    assert.equal(transport.send === wrapped.send, false);
  });

  it("forwards pushes and prevents an old shifted entry from returning after a purge", async () => {
    const memory = memoryStore();
    const store = purgeableSpoolStore(memory.store);
    const oldEnvelope = event({ message: "old" });
    store.push(oldEnvelope);
    assert.deepEqual(memory.pushed, [oldEnvelope]);
    const shifted = await store.shift();
    assert.equal(shifted, oldEnvelope);
    assert.equal(await store.purge(), 0);
    await store.unshift(shifted);
    assert.deepEqual(memory.unshifted, []);

    const current = event({ message: "current" });
    await store.unshift(current);
    assert.deepEqual(memory.unshifted, [current]);
    assert.deepEqual(memory.queue, [current]);
  });

  it("purges no more than the configured number of queued entries", async () => {
    let shifts = 0;
    const store: SlateSentrySpoolStore = {
      push() {},
      async unshift() {},
      async shift() { shifts += 1; return {}; },
    };
    const purging = purgeableSpoolStore(store);
    assert.equal(await purging.purge(), MAX_SPOOL_PURGE_SHIFTS);
    assert.equal(shifts, MAX_SPOOL_PURGE_SHIFTS);
  });

  it("wraps a transport-created offline store and captures the same wrapper", () => {
    const memory = memoryStore();
    const captured: Array<{ purge(): Promise<number> }> = [];
    const options = {
      label: "transport-options",
      createStore(this: { label: string }, path: string) {
        assert.equal(this.label, "transport-options");
        assert.equal(path, "spool.db");
        return memory.store;
      },
    };
    captureOfflineSpoolStore(options, (store) => captured.push(store));
    const wrapped = (options as unknown as { createStore(path: string): SlateSentrySpoolStore & { purge(): Promise<number> } }).createStore("spool.db");
    assert.equal(captured[0], wrapped);
    assert.equal(typeof wrapped.purge, "function");
  });

  it("does not alter transport options that have no store factory", () => {
    const missing = { label: "no-store" };
    captureOfflineSpoolStore(missing, () => assert.fail("no store should be captured"));
    assert.deepEqual(missing, { label: "no-store" });
    captureOfflineSpoolStore(null, () => assert.fail("non-object options should be ignored"));
  });

  it("invalidates older asynchronous privacy synchronization results", () => {
    const sync = new SlateSentryAccountPrivacySync();
    const first = sync.begin("user-a");
    const second = sync.begin("user-a");
    assert.deepEqual(first, { sequence: 1, reset: true, identityChanged: false });
    assert.deepEqual(second, { sequence: 2, reset: false, identityChanged: false });
    assert.equal(sync.isCurrent(first), false);
    assert.equal(sync.finish(first, "stale"), undefined);
    assert.equal(sync.finish(second, "current"), "current");
  });

  it("distinguishes an account change from an initial or repeated identity", () => {
    const sync = new SlateSentryAccountPrivacySync();
    assert.deepEqual(sync.begin(), { sequence: 1, reset: true, identityChanged: false });
    assert.deepEqual(sync.begin("user-a"), { sequence: 2, reset: true, identityChanged: false });
    assert.deepEqual(sync.begin("user-a"), { sequence: 3, reset: false, identityChanged: false });
    assert.deepEqual(sync.begin("user-b"), { sequence: 4, reset: true, identityChanged: true });
    assert.deepEqual(sync.begin(), { sequence: 5, reset: true, identityChanged: true });
  });

  it("keeps valid event ids newest-first, unique, bounded and clearable", () => {
    const ring = new SlateSentryEventIdRing(3);
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    const third = "c".repeat(32);
    ring.record(envelope(
      [{ type: "event" }, { event_id: first }],
      [{ type: "event" }, { event_id: second }],
      [{ type: "session" }, { event_id: third }],
    ));
    assert.deepEqual(ring.list(), [second, first]);
    ring.record(event({ event_id: first }));
    assert.deepEqual(ring.list(), [first, second]);
    ring.record(event({ event_id: "A".repeat(32) }));
    assert.deepEqual(ring.list(), [first, second]);
    ring.clear();
    assert.deepEqual(ring.list(), []);

    const capped = new SlateSentryEventIdRing(2);
    capped.record(envelope(
      [{ type: "event" }, { event_id: first }],
      [{ type: "event" }, { event_id: second }],
      [{ type: "event" }, { event_id: third }],
    ));
    assert.deepEqual(capped.list(), [third, second]);
  });
});

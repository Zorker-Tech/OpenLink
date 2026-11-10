/**
 * What the structured-log transport buffers, ships, records as dropped and preserves across lifecycle boundaries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeadlinePolicy, ExpiryPolicy, PollingPolicy } from "../../source/host/extensions/scheduling.ts";
import {
  BOX_LOG_EVENT,
  HOST_LOG_EVENT,
  TELEMETRY_DROPPED_EVENT,
  TELEMETRY_SHIP_TIMEOUT_EVENT,
} from "../../source/shared/observability/telemetry-events.ts";
import {
  ClientLogLevel,
  DEADLINE_EXPIRY_CODE,
  MAX_BUFFER_SIZE,
  STRUCTURED_LOG_REPLAY_MAX_AGE_MS,
  STRUCTURED_LOG_SUBMIT_DEADLINE_MS,
  StructuredLogTransport,
  cleanStructuredLogMetadata,
  cloneDropCounters,
  createDropCounterId,
  emptyDropCounters,
  isDeadlineExpiry,
  isValidLogShipReceipt,
  toClientLogLevel,
  truncateStructuredLogValue,
  type StructuredLogCheckpoint,
  type StructuredLogEntry,
} from "../../source/shared/observability/structured-log-transport.ts";

interface Receipt {
  readonly logsProcessed: number;
  readonly logsDropped: number;
}

interface WorldOptions {
  readonly disabled?: boolean;
  readonly holdForIdentity?: boolean;
  readonly retainUndeliveredOnDispose?: boolean;
  readonly initialCheckpoint?: StructuredLogCheckpoint;
  readonly platformTags?: Readonly<Record<string, string | undefined>>;
  readonly reply?: (logs: readonly StructuredLogEntry[], signal: AbortSignal, call: number) => Promise<Receipt>;
}

function world(options: WorldOptions = {}) {
  const submissions: StructuredLogEntry[][] = [];
  const signals: AbortSignal[] = [];
  const pollingTicks: Array<() => Promise<void>> = [];
  const pollingDisposals: number[] = [];
  const identityExpiry: Array<() => void> = [];
  const identityExpiryDisposals: number[] = [];
  const settled: string[] = [];
  let clientCreations = 0;

  const polling: PollingPolicy = {
    name: "structured-log-test-poll",
    start: (tick) => {
      pollingTicks.push(tick);
      return { dispose: () => pollingDisposals.push(pollingDisposals.length + 1) };
    },
  };
  const submitDeadline: DeadlinePolicy = {
    name: "structured-log-test-deadline",
    run: async (work, signal) => await work(signal ?? new AbortController().signal),
  };
  const expiry: ExpiryPolicy = {
    name: "structured-log-test-identity-expiry",
    arm: (_key, onExpire) => {
      identityExpiry.push(onExpire);
      return { dispose: () => identityExpiryDisposals.push(identityExpiryDisposals.length + 1) };
    },
  };

  const transport = new StructuredLogTransport({
    platformTags: options.platformTags ?? { host: "desktop", blank: "" },
    key: "slate-work-host",
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
    ...(options.initialCheckpoint === undefined ? {} : { initialCheckpoint: options.initialCheckpoint }),
    ...(options.holdForIdentity === undefined ? {} : { holdForIdentity: options.holdForIdentity }),
    ...(options.holdForIdentity === true ? { identityHoldExpiry: expiry } : {}),
    polling,
    submitDeadline,
    ...(options.retainUndeliveredOnDispose === undefined
      ? {}
      : { retainUndeliveredOnDispose: options.retainUndeliveredOnDispose }),
    createClient: () => {
      clientCreations += 1;
      return {
        submitLogs: async ({ logs }, { signal }) => {
          const copy = logs.map((entry) => ({ ...entry, metadata: { ...entry.metadata } }));
          submissions.push(copy);
          signals.push(signal);
          return options.reply === undefined
            ? { logsProcessed: logs.length, logsDropped: 0 }
            : await options.reply(logs, signal, submissions.length);
        },
      };
    },
  });

  return {
    transport,
    submissions,
    signals,
    pollingTicks,
    pollingDisposals,
    identityExpiry,
    identityExpiryDisposals,
    settled,
    clientCreations: () => clientCreations,
    enqueue: (message: string, timestamp = Date.now(), onSettled?: (value: "delivered" | "dropped") => void) => {
      transport.enqueueAt("info", message, { source: "test", blank: "", ignored: undefined }, timestamp, onSettled);
    },
  };
}

function checkpoint(records: StructuredLogCheckpoint["records"] = []): StructuredLogCheckpoint {
  return { counterId: "counter-1", counters: emptyDropCounters(), records };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("structured-log value rules", () => {
  it("cleans empty metadata, truncates by character count and maps the four levels", () => {
    assert.deepEqual(cleanStructuredLogMetadata({ a: "one", b: "", c: undefined, d: "0" }), { a: "one", d: "0" });
    assert.deepEqual([truncateStructuredLogValue("abc", 2), truncateStructuredLogValue("abc", 3)], ["ab", "abc"]);
    assert.deepEqual(
      ["debug", "info", "warn", "error"].map((level) => toClientLogLevel(level as "debug" | "info" | "warn" | "error")),
      [ClientLogLevel.DEBUG, ClientLogLevel.INFO, ClientLogLevel.WARN, ClientLogLevel.ERROR],
    );
  });

  it("validates a receipt only when processed and dropped totals cover the request", () => {
    assert.equal(isValidLogShipReceipt({ logsProcessed: 2, logsDropped: 1 }, 3), true);
    assert.equal(isValidLogShipReceipt({ logsProcessed: 2, logsDropped: 0 }, 3), false);
    assert.equal(isValidLogShipReceipt({ logsProcessed: 1.5, logsDropped: 1.5 }, 3), false);
    assert.equal(isValidLogShipReceipt({ logsProcessed: Number.MAX_SAFE_INTEGER + 1, logsDropped: 0 }, 1), false);
    assert.equal(isValidLogShipReceipt({ logsProcessed: 0, logsDropped: 0 }, 0), true);
  });

  it("recognizes the submit deadline by its code and creates independent drop-counter ids", () => {
    assert.equal(isDeadlineExpiry({ code: DEADLINE_EXPIRY_CODE }), true);
    assert.equal(isDeadlineExpiry({ code: "other" }), false);
    assert.equal(isDeadlineExpiry(null), false);
    assert.equal(createDropCounterId().match(/^[0-9a-f]{32}$/) !== null, true);
    assert.notEqual(createDropCounterId(), createDropCounterId());
    assert.deepEqual([MAX_BUFFER_SIZE, STRUCTURED_LOG_SUBMIT_DEADLINE_MS, STRUCTURED_LOG_REPLAY_MAX_AGE_MS], [1_000, 15_000, 61_200_000]);
  });

  it("copies drop counters without sharing the mutable reason entries", () => {
    const initial = emptyDropCounters();
    initial.ship_failed.observed = 2;
    const copy = cloneDropCounters(initial);
    copy.ship_failed.acknowledgedThrough = 1;
    assert.deepEqual(initial.ship_failed, { observed: 2, acknowledgedThrough: 0 });
    assert.deepEqual(copy.ship_failed, { observed: 2, acknowledgedThrough: 1 });
  });
});

describe("what the transport retains", () => {
  it("merges platform tags at enqueue, copies caller metadata and checkpoints pending rows", () => {
    const current = world({ platformTags: { client: "slate", blank: "" } });
    const metadata = { client: "caller", keep: "yes" };
    current.transport.enqueueAt("warn", "event", metadata, 123);
    metadata.keep = "changed";

    const pending = current.transport.capturePending();
    assert.deepEqual(pending, [{ level: "warn", message: "event", metadata: { client: "caller", keep: "yes" }, timestamp: 123 }]);
    assert.deepEqual(current.transport.captureCheckpoint(), {
      counterId: current.transport.captureCheckpoint().counterId,
      counters: emptyDropCounters(),
      records: pending,
    });
  });

  it("drops at the buffer limit, evicting host and box reports before ordinary rows", () => {
    const current = world();
    const firstSettled: string[] = [];
    current.transport.enqueueAt("info", HOST_LOG_EVENT, {}, 1, (value) => firstSettled.push(`host:${value}`));
    current.transport.enqueueAt("info", BOX_LOG_EVENT, {}, 2, (value) => firstSettled.push(`box:${value}`));
    for (let index = 0; index < MAX_BUFFER_SIZE - 1; index += 1) {
      current.transport.enqueueAt("info", `row-${index}`, {}, index + 3);
    }
    current.transport.enqueueAt("info", "last-row", {}, MAX_BUFFER_SIZE + 3);

    const retained = current.transport.capturePending();
    assert.equal(retained.length, MAX_BUFFER_SIZE);
    assert.deepEqual(firstSettled, ["host:dropped", "box:dropped"]);
    assert.equal(retained.some((record) => record.message === HOST_LOG_EVENT || record.message === BOX_LOG_EVENT), false);
    assert.equal(retained.some((record) => record.message === "row-0"), true);
    assert.equal(current.transport.captureCheckpoint().counters.overflow_evicted.observed, 2);
  });

  it("drops immediately when shipping is disabled or the transport is already disposed", async () => {
    const disabled = world({ disabled: true });
    disabled.enqueue("off", 1, (value) => disabled.settled.push(value));
    assert.deepEqual(disabled.settled, ["dropped"]);
    assert.equal(await disabled.transport.shipConfirmed("info", "event", {}), true);
    assert.equal(disabled.pollingTicks.length, 0);

    const disposed = world();
    await disposed.transport.dispose();
    disposed.enqueue("closed", 2, (value) => disposed.settled.push(value));
    assert.deepEqual(disposed.settled, ["dropped"]);
    assert.equal(await disposed.transport.shipConfirmed("info", "event", {}), false);
  });
});

describe("shipping, receipts and drop reports", () => {
  it("ships logs with identity tags and settles each row once", async () => {
    const current = world({ platformTags: { client: "slate", host: "host" } });
    const settlements: string[] = [];
    const timestamp = Date.now();
    current.transport.setIdentityTags({ account: "user-1", host: "identity" });
    current.transport.enqueueAt("error", "source event", { host: "entry", detail: "x" }, timestamp, (value) => settlements.push(value));

    assert.equal(await current.transport.flushNow(), true);
    assert.deepEqual(current.submissions[0]?.map((log) => [log.message, log.level, log.timestamp, log.key]), [
      ["source event", ClientLogLevel.ERROR, BigInt(timestamp), "slate-work-host"],
    ]);
    assert.deepEqual(current.submissions[0]?.[0]?.metadata, { account: "user-1", client: "slate", host: "entry", detail: "x" });
    assert.deepEqual(settlements, ["delivered"]);
    assert.deepEqual(current.transport.capturePending(), []);
  });

  it("ships confirmed reports immediately and treats disabled and closed transports distinctly", async () => {
    const current = world();
    assert.equal(await current.transport.shipConfirmed("warn", "confirmed", { item: "1" }), true);
    assert.equal(current.submissions[0]?.[0]?.message, "confirmed");
    assert.deepEqual(current.submissions[0]?.[0]?.metadata, { host: "desktop", item: "1" });

    const off = world({ disabled: true });
    assert.equal(await off.transport.shipConfirmed("warn", "confirmed", {}), true);
    assert.equal(off.clientCreations(), 0);
  });

  it("keeps failed batches buffered and makes a fresh client for the retry", async () => {
    const current = world({
      reply: async (logs, _signal, call) => {
        if (call === 1) throw new Error("offline");
        return { logsProcessed: logs.length, logsDropped: 0 };
      },
    });
    const settlements: string[] = [];
    current.enqueue("retry me", Date.now(), (value) => settlements.push(value));

    assert.equal(await current.transport.flushNow(), false);
    assert.deepEqual(current.transport.capturePending().map((entry) => entry.message), ["retry me"]);
    assert.equal(current.transport.captureCheckpoint().counters.ship_failed.observed, 1);
    assert.equal(current.clientCreations(), 1);

    assert.equal(await current.transport.flushNow(), true);
    assert.equal(current.clientCreations(), 2);
    assert.deepEqual(settlements, ["delivered"]);
    assert.deepEqual(current.transport.capturePending(), []);
  });

  it("reports drops with a stable counter id and advances only acknowledged counts", async () => {
    const current = world({
      initialCheckpoint: checkpoint(),
      reply: async (logs) => logs[0]?.message === TELEMETRY_DROPPED_EVENT
        ? { logsProcessed: logs.length, logsDropped: 0 }
        : { logsProcessed: 0, logsDropped: logs.length },
    });
    current.transport.recordDropped("account_rotated", 3);

    assert.equal(await current.transport.flushNow(), true);
    const report = current.submissions[0]?.[0];
    assert.equal(report?.message, TELEMETRY_DROPPED_EVENT);
    assert.deepEqual(report?.metadata, {
      host: "desktop",
      reason: "account_rotated",
      unit: "entries",
      count: "3",
      counter_id: "counter-1",
    });
    assert.deepEqual(current.transport.captureCheckpoint().counters.account_rotated, { observed: 3, acknowledgedThrough: 3 });
  });

  it("leaves a drop report pending when the backend receipt does not cover the report batch", async () => {
    const current = world({ reply: async () => ({ logsProcessed: 0, logsDropped: 0 }) });
    current.transport.recordDropped("ship_failed", 2);
    assert.equal(await current.transport.flushNow(), false);
    assert.deepEqual(current.transport.captureCheckpoint().counters.ship_failed, { observed: 2, acknowledgedThrough: 0 });
  });

  it("expires old checkpoint rows and reports them as dropped before completing the flush", async () => {
    const settled: string[] = [];
    const oldTimestamp = Date.now() - STRUCTURED_LOG_REPLAY_MAX_AGE_MS - 1;
    const current = world({
      initialCheckpoint: checkpoint([
        { level: "info", message: "too old", metadata: {}, timestamp: oldTimestamp, onSettled: (value) => settled.push(value) },
      ]),
    });
    assert.equal(await current.transport.flushNow(), true);
    assert.deepEqual(settled, ["dropped"]);
    assert.equal(current.submissions[0]?.[0]?.message, TELEMETRY_DROPPED_EVENT);
    assert.equal(current.submissions[0]?.[0]?.metadata.reason, "replay_expired");
    assert.deepEqual(current.transport.capturePending(), []);
  });
});

describe("identity and shutdown boundaries", () => {
  it("holds shipping until identity arrives or its expiry fires", async () => {
    const identityReady = world({ holdForIdentity: true });
    identityReady.enqueue("waiting", Date.now());
    assert.equal(await identityReady.transport.flushNow(), false);
    assert.equal(identityReady.clientCreations(), 0);

    identityReady.transport.setIdentityTags({ account: "user-1" });
    assert.equal(identityReady.identityExpiryDisposals.length, 1);
    assert.equal(await identityReady.transport.flushNow(), true);
    assert.equal(identityReady.submissions[0]?.[0]?.metadata.account, "user-1");

    const timedOut = world({ holdForIdentity: true });
    timedOut.enqueue("waiting for expiry", Date.now());
    timedOut.identityExpiry[0]?.();
    assert.equal(await timedOut.transport.flushNow(), true);
  });

  it("clears pending rows and invalidates the in-flight submit generation", async () => {
    const started = deferred<void>();
    const current = world({
      reply: async (_logs, signal) => await new Promise<Receipt>((resolve) => {
        signal.addEventListener("abort", () => resolve({ logsProcessed: 0, logsDropped: 0 }), { once: true });
        started.resolve();
      }),
    });
    const settlements: string[] = [];
    current.enqueue("discard on clear", Date.now(), (value) => settlements.push(value));
    const flush = current.transport.flushNow();
    await started.promise;
    await current.transport.clearPending();

    assert.deepEqual(settlements, ["dropped"]);
    assert.deepEqual(current.transport.capturePending(), []);
    assert.deepEqual(current.transport.captureCheckpoint().counters, emptyDropCounters());
    assert.equal(current.signals[0]?.aborted, true);
    assert.equal(await flush, true);
  });

  it("drops undelivered rows on dispose by default, or preserves a checkpoint when requested", async () => {
    for (const retain of [false, true]) {
      const current = world({ retainUndeliveredOnDispose: retain, reply: async () => { throw new Error("offline"); } });
      const settlements: string[] = [];
      current.enqueue("not delivered", Date.now(), (value) => settlements.push(value));

      assert.equal(await current.transport.dispose(), false);
      assert.deepEqual(current.transport.capturePending().map((entry) => entry.message), retain ? ["not delivered"] : []);
      assert.deepEqual(settlements, retain ? [] : ["dropped"]);
      assert.equal(await current.transport.dispose(), retain ? false : false);
    }
  });

  it("emits only one timeout warning during a consecutive deadline streak", async () => {
    const current = world({
      reply: async (_logs, _signal, call) => {
        if (call <= 2) throw { code: DEADLINE_EXPIRY_CODE };
        return { logsProcessed: _logs.length, logsDropped: 0 };
      },
    });
    current.enqueue("first", Date.now());
    assert.equal(await current.transport.flushNow(), false);
    current.enqueue("second", Date.now());
    assert.equal(await current.transport.flushNow(), false);
    assert.equal(current.transport.capturePending().filter((entry) => entry.message === TELEMETRY_SHIP_TIMEOUT_EVENT).length, 1);
    assert.equal(await current.transport.flushNow(), true);
    const warnings = current.submissions.flat().filter((entry) => entry.message === TELEMETRY_SHIP_TIMEOUT_EVENT);
    assert.equal(warnings.length, 2, "the same queued warning is included in its failed attempt and its retry");
    assert.deepEqual(warnings[0], warnings[1]);
  });
});

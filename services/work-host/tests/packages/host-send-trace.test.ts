import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SEND_TRACE_SAMPLE_RATIO,
  deriveChildTraceparent,
  mintTraceparent,
  parseTraceparent,
  shouldSampleSend,
} from "../../source/shared/observability/send-trace.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const header = (overrides: { traceId?: string; spanId?: string; flags?: string; version?: string } = {}) =>
  `${overrides.version ?? "00"}-${overrides.traceId ?? TRACE_ID}-${overrides.spanId ?? SPAN_ID}-${overrides.flags ?? "01"}`;

describe("a trace context as it arrives", () => {
  it("is read as its two ids and the flags that say whether it was sampled", () => {
    assert.deepEqual(parseTraceparent(header()), { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });
    assert.deepEqual(parseTraceparent(header({ flags: "00" })), { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 0 });
    assert.deepEqual(parseTraceparent(header({ flags: "ff" })), { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 255 });
  });

  it("is read with the padding it arrived with", () => {
    assert.deepEqual(parseTraceparent(`  ${header()}  `), { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });
  });

  it("is nothing when it is not a header at all", () => {
    for (const value of [null, undefined, 5, {}, "", "garbage"]) assert.equal(parseTraceparent(value), undefined, String(value));
  });

  it("is nothing when it is not four fields", () => {
    assert.equal(parseTraceparent("00-abc-def"), undefined);
    assert.equal(parseTraceparent(`${header()}-extra`), undefined);
    assert.equal(parseTraceparent(`00--${SPAN_ID}-01`), undefined);
  });

  it("is nothing for a version this build does not read", () => {
    assert.equal(parseTraceparent(header({ version: "01" })), undefined);
    assert.equal(parseTraceparent(header({ version: "0" })), undefined);
  });

  it("is nothing for an id of the wrong length, the wrong case, or all zeroes", () => {
    assert.equal(parseTraceparent(header({ traceId: TRACE_ID.slice(0, 31) })), undefined);
    assert.equal(parseTraceparent(header({ traceId: TRACE_ID.toUpperCase() })), undefined);
    assert.equal(parseTraceparent(header({ traceId: "0".repeat(32) })), undefined, "the standard calls that id invalid");
    assert.equal(parseTraceparent(header({ spanId: SPAN_ID.slice(0, 15) })), undefined);
    assert.equal(parseTraceparent(header({ spanId: "0".repeat(16) })), undefined);
  });

  it("is nothing for flags that are not one byte of hex", () => {
    assert.equal(parseTraceparent(header({ flags: "1" })), undefined);
    assert.equal(parseTraceparent(header({ flags: "zz" })), undefined);
  });
});

describe("starting a trace", () => {
  it("mints a header a reader accepts, with its own ids", () => {
    const minted = mintTraceparent();
    assert.ok(minted);
    assert.equal(minted.traceparent, `00-${minted.traceId}-${minted.spanId}-01`);
    assert.equal(minted.traceId.length, 32);
    assert.equal(minted.spanId.length, 16);
    assert.equal(/^[0-9a-f]+$/.test(minted.traceId), true);
    assert.deepEqual(parseTraceparent(minted.traceparent), { traceId: minted.traceId, spanId: minted.spanId, traceFlags: 1 });
  });

  it("says whether it was sampled", () => {
    assert.equal(mintTraceparent(true)?.traceparent.endsWith("-01"), true);
    assert.equal(mintTraceparent(false)?.traceparent.endsWith("-00"), true);
    assert.equal(mintTraceparent()?.traceparent.endsWith("-01"), true, "a trace is sampled unless it says otherwise");
  });

  it("does not mint the same trace twice", () => {
    assert.notEqual(mintTraceparent()?.traceId, mintTraceparent()?.traceId);
  });
});

describe("a span inside a trace that is already running", () => {
  it("keeps the trace and the sampling decision, and takes a new span", () => {
    const derived = deriveChildTraceparent(header({ flags: "01" }));
    assert.ok(derived);
    assert.equal(derived.spanId.length, 16);
    assert.notEqual(derived.spanId, SPAN_ID);
    assert.equal(derived.traceparent, `00-${TRACE_ID}-${derived.spanId}-01`);
  });

  it("keeps an unsampled trace unsampled, and reads only the sampled bit of the flags", () => {
    assert.equal(deriveChildTraceparent(header({ flags: "00" }))?.traceparent.endsWith("-00"), true);
    assert.equal(deriveChildTraceparent(header({ flags: "02" }))?.traceparent.endsWith("-00"), true, "a flag that is not the sampled bit is not inherited");
    assert.equal(deriveChildTraceparent(header({ flags: "03" }))?.traceparent.endsWith("-01"), true);
  });

  it("is nothing when there is no trace to continue", () => {
    assert.equal(deriveChildTraceparent("not a header"), undefined);
    assert.equal(deriveChildTraceparent(header({ traceId: "0".repeat(32) })), undefined);
  });
});

describe("whether a send is traced at all", () => {
  it("is traced always by default", () => {
    assert.equal(SEND_TRACE_SAMPLE_RATIO, 1);
    assert.equal(shouldSampleSend(), true);
    assert.equal(shouldSampleSend(1, () => 0.999), true);
  });

  it("is never traced at or below a ratio of nothing", () => {
    for (const ratio of [0, -1, Number.NaN]) assert.equal(shouldSampleSend(ratio, () => 0), false, String(ratio));
  });

  it("is traced by the ratio in between, without asking for a random number at the ends", () => {
    assert.equal(shouldSampleSend(0.5, () => 0.49), true);
    assert.equal(shouldSampleSend(0.5, () => 0.5), false, "the ratio is an upper bound, not an inclusive one");
    let asked = 0;
    const random = () => {
      asked += 1;
      return 0.9;
    };
    shouldSampleSend(1, random);
    shouldSampleSend(0, random);
    assert.equal(asked, 0, "a ratio that decides by itself does not roll");
  });
});

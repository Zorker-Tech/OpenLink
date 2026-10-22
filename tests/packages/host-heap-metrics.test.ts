import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMemoryReport } from "../../source/shared/observability/heap-metrics.ts";

describe("what a process reports about its memory", () => {
  it("needs the bytes it uses and the bytes it may use", () => {
    assert.deepEqual(parseMemoryReport({ usedBytes: 10, limitBytes: 20 }), { usedBytes: 10, limitBytes: 20 });
    for (const value of [null, undefined, 5, "text", [], {}]) assert.equal(parseMemoryReport(value), null, String(value));
    assert.equal(parseMemoryReport({ usedBytes: 1 }), null);
    assert.equal(parseMemoryReport({ limitBytes: 1 }), null);
  });

  it("refuses a number that is not one, a negative use, and a limit of nothing", () => {
    assert.equal(parseMemoryReport({ usedBytes: Number.NaN, limitBytes: 2 }), null);
    assert.equal(parseMemoryReport({ usedBytes: Number.POSITIVE_INFINITY, limitBytes: 2 }), null);
    assert.equal(parseMemoryReport({ usedBytes: 1, limitBytes: Number.POSITIVE_INFINITY }), null);
    assert.equal(parseMemoryReport({ usedBytes: -1, limitBytes: 2 }), null);
    assert.equal(parseMemoryReport({ usedBytes: 1, limitBytes: 0 }), null);
    assert.equal(parseMemoryReport({ usedBytes: 1, limitBytes: -2 }), null);
  });

  it("reads zero as zero, and carries a count only when it is one", () => {
    assert.deepEqual(parseMemoryReport({ usedBytes: 0, limitBytes: 2 }), { usedBytes: 0, limitBytes: 2 });
    assert.deepEqual(
      parseMemoryReport({ usedBytes: 1, limitBytes: 2, loadedAgents: 3, loadedTranscriptEntries: 4, idleMinutesLast15m: 5 }),
      { usedBytes: 1, limitBytes: 2, loadedAgents: 3, loadedTranscriptEntries: 4, idleMinutesLast15m: 5 },
    );
    const partial = parseMemoryReport({ usedBytes: 1, limitBytes: 2, loadedAgents: -1, loadedTranscriptEntries: 1.5, idleMinutesLast15m: "5" });
    assert.deepEqual(partial, { usedBytes: 1, limitBytes: 2 }, "a count that is not a whole number is left out");
  });

  it("is only a plain object, not a class instance or an array carrying the same fields", () => {
    class Report {
      usedBytes = 1;
      limitBytes = 2;
    }
    assert.equal(parseMemoryReport(new Report()), null);
    assert.equal(parseMemoryReport(Object.create({ usedBytes: 1, limitBytes: 2 })), null);
    const bare = Object.assign(Object.create(null), { usedBytes: 7, limitBytes: 8 });
    assert.deepEqual(parseMemoryReport(bare), { usedBytes: 7, limitBytes: 8 }, "an object with no prototype is still a report");
  });

  it("reads the field's value, not a getter that answers it", () => {
    const withGetter = { get usedBytes() { return 1; }, limitBytes: 2 };
    assert.equal(parseMemoryReport(withGetter), null);
  });
});

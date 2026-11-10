import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ensureFinitePositive } from "../../source/packages/agent-store-sync/validation.ts";

describe("a configured number", () => {
  it("is answered as it is when it is finite and positive", () => {
    assert.equal(ensureFinitePositive({ value: 1, name: "baseDelayMs", context: "BackoffScheduler" }), 1);
    assert.equal(ensureFinitePositive({ value: 0.5, name: "maxDelayMs", context: "BackoffScheduler" }), 0.5);
    assert.equal(ensureFinitePositive({ value: Number.MIN_VALUE, name: "n", context: "c" }), Number.MIN_VALUE);
    const value = 12.5;
    assert.equal(ensureFinitePositive({ value, name: "n", context: "c" }), value, "the number itself comes back");
  });

  it("is refused when it is zero, negative, infinite or not a number", () => {
    for (const value of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => ensureFinitePositive({ value, name: "baseDelayMs", context: "BackoffScheduler" }), RangeError, String(value));
    }
    assert.throws(() => ensureFinitePositive({ value: "1" as never, name: "n", context: "c" }), RangeError);
  });

  it("says what the number was for and what it was", () => {
    assert.throws(() => ensureFinitePositive({ value: 0, name: "baseDelayMs", context: "BackoffScheduler" }), {
      name: "RangeError",
      message: "BackoffScheduler baseDelayMs must be a finite positive number, got 0",
    });
    assert.throws(() => ensureFinitePositive({ value: Number.NaN, name: "maxDelayMs", context: "BackoffScheduler" }), {
      message: "BackoffScheduler maxDelayMs must be a finite positive number, got NaN",
    });
    assert.throws(() => ensureFinitePositive({ value: -1.5, name: "间隔", context: "同步" }), {
      message: "同步 间隔 must be a finite positive number, got -1.5",
    });
  });
});

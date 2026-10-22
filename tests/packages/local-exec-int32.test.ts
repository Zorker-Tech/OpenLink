import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampInt32, toOptionalDurationMsInt32 } from "../../source/packages/local-exec/int32.ts";

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

describe("a 32-bit duration number", () => {
  it("is clamped into the signed range rather than wrapped around", () => {
    assert.equal(clampInt32(INT32_MIN - 1), INT32_MIN);
    assert.equal(clampInt32(INT32_MIN), INT32_MIN);
    assert.equal(clampInt32(INT32_MAX), INT32_MAX);
    assert.equal(clampInt32(INT32_MAX + 1), INT32_MAX);
    assert.equal(clampInt32(Number.NEGATIVE_INFINITY), INT32_MIN);
    assert.equal(clampInt32(Number.POSITIVE_INFINITY), INT32_MAX);
    assert.equal(clampInt32(0), 0);
    assert.equal(clampInt32(-1), -1);
    assert.equal(clampInt32(1.5), 1.5, "a fraction inside the range is not rounded here");
  });

  it("reads a value that is not a number as zero", () => {
    assert.equal(clampInt32(Number.NaN), 0);
  });

  it("keeps the sign of a negative zero", () => {
    assert.equal(Object.is(clampInt32(-0), -0), true);
  });
});

describe("a duration that may be absent", () => {
  it("is absent for anything that is not a finite, non-negative number", () => {
    for (const value of [undefined, null, "12", true, {}, [12], Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5, 12n, Symbol("12")]) {
      assert.equal(toOptionalDurationMsInt32(value), undefined, String(value));
    }
  });

  it("keeps a whole millisecond count inside the 32-bit range", () => {
    assert.equal(toOptionalDurationMsInt32(0), 0);
    assert.equal(toOptionalDurationMsInt32(0.9), 0);
    assert.equal(toOptionalDurationMsInt32(1234.9), 1234);
    assert.equal(toOptionalDurationMsInt32(INT32_MAX), INT32_MAX);
    assert.equal(toOptionalDurationMsInt32(INT32_MAX + 100), INT32_MAX);
    assert.equal(toOptionalDurationMsInt32(1e21), INT32_MAX);
    assert.equal(toOptionalDurationMsInt32(Number.MIN_VALUE), 0);
  });

  it("keeps a negative zero as one", () => {
    assert.equal(Object.is(toOptionalDurationMsInt32(-0), -0), true);
  });
});

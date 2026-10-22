import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";

describe("the privacy modes an account reports", () => {
  it("are the wire numbers stored in redacted messages", () => {
    assert.deepEqual(PrivacyMode, {
      UNSPECIFIED: 0,
      NO_STORAGE: 1,
      NO_TRAINING: 2,
      USAGE_DATA_TRAINING_ALLOWED: 3,
      USAGE_CODEBASE_TRAINING_ALLOWED: 4,
    });
    assert.deepEqual(Object.entries(PrivacyMode), [
      ["UNSPECIFIED", 0],
      ["NO_STORAGE", 1],
      ["NO_TRAINING", 2],
      ["USAGE_DATA_TRAINING_ALLOWED", 3],
      ["USAGE_CODEBASE_TRAINING_ALLOWED", 4],
    ]);
  });

  it("numbers every mode once, in the order they arrived in", () => {
    const numbers = Object.values(PrivacyMode);
    assert.deepEqual(numbers, [0, 1, 2, 3, 4]);
    assert.equal(new Set(numbers).size, numbers.length);
    for (const number of numbers) assert.equal(Number.isInteger(number), true);
  });

  it("is a plain table, not a frozen one", () => {
    assert.equal(Object.isFrozen(PrivacyMode), false, "the table is written as a plain object literal");
  });
});

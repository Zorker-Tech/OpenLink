import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";

describe("Slate privacy modes", () => {
  it("are semantic string categories", () => {
    assert.deepEqual(PrivacyMode, {
      UNSPECIFIED: "unspecified",
      NO_STORAGE: "no-storage",
      NO_TRAINING: "no-training",
      USAGE_DATA_TRAINING_ALLOWED: "usage-data-training-allowed",
      USAGE_CODEBASE_TRAINING_ALLOWED: "usage-codebase-training-allowed",
    });
    assert.deepEqual(Object.entries(PrivacyMode), [
      ["UNSPECIFIED", "unspecified"],
      ["NO_STORAGE", "no-storage"],
      ["NO_TRAINING", "no-training"],
      ["USAGE_DATA_TRAINING_ALLOWED", "usage-data-training-allowed"],
      ["USAGE_CODEBASE_TRAINING_ALLOWED", "usage-codebase-training-allowed"],
    ]);
  });

  it("gives every policy a unique value", () => {
    const values = Object.values(PrivacyMode);
    assert.equal(new Set(values).size, values.length);
  });

  it("is a plain table, not a frozen one", () => {
    assert.equal(Object.isFrozen(PrivacyMode), false, "the table is written as a plain object literal");
  });
});

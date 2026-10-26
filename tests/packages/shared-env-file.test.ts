import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateBoxSecretKey } from "../../source/shared/box-secrets.ts";
import { isEnvironmentName } from "../../source/shared/env-file.ts";

describe("environment variable names", () => {
  it("starts with an ASCII letter or underscore and allows digits later", () => {
    for (const value of ["A", "Z", "z", "_", "_9", "SLATE_PORT", "a0B9"]) {
      assert.equal(isEnvironmentName(value), true, value);
    }
  });

  it("refuses empty, digit-first, punctuated, spaced and non-ASCII names", () => {
    for (const value of ["", "9VAR", "-NAME", ".NAME", "TWO WORDS", "A.B", "A-", "A/B", "A\\B", "A\0B", "é", "猫", "😀", "A\nB"]) {
      assert.equal(isEnvironmentName(value), false, JSON.stringify(value));
    }
  });

  it("shares the exact name grammar used for box secrets", () => {
    for (const value of ["A", "_x", "key_4"]) {
      assert.equal(validateBoxSecretKey(value), null);
    }
    for (const value of ["a-b", "1first", "has space"]) {
      assert.match(validateBoxSecretKey(value) ?? "", /not a valid environment variable name/);
    }
  });
});

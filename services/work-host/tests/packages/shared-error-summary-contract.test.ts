import assert from "node:assert/strict";
import { test } from "node:test";

import { errorMessage } from "../../source/shared/errors/summary.ts";

test("error summaries use an Error's message and stringify other values", () => {
  assert.equal(errorMessage(new Error("the operation failed")), "the operation failed");
  assert.equal(errorMessage("plain failure"), "plain failure");
  assert.equal(errorMessage(503), "503");
  assert.equal(errorMessage({ toString: () => "custom failure" }), "custom failure");
  assert.equal(errorMessage(null), "null");
});

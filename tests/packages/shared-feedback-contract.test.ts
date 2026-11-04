import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_FEEDBACK_ACCOUNT_SLOT_MAX_CHARS,
  SLATE_FEEDBACK_CONVERSATION_ID_MAX_CHARS,
  SLATE_FEEDBACK_ERROR_REFERENCE_ID_MAX_COUNT,
  SLATE_FEEDBACK_ERROR_REFERENCE_ID_PATTERN,
  SLATE_FEEDBACK_MESSAGE_MAX_CHARS,
} from "../../source/shared/feedback.ts";

describe("feedback bounds", () => {
  it("sets conservative content and identifier limits", () => {
    assert.equal(SLATE_FEEDBACK_MESSAGE_MAX_CHARS, 10_000);
    assert.equal(SLATE_FEEDBACK_CONVERSATION_ID_MAX_CHARS, 512);
    assert.equal(SLATE_FEEDBACK_ACCOUNT_SLOT_MAX_CHARS, 512);
    assert.equal(SLATE_FEEDBACK_ERROR_REFERENCE_ID_MAX_COUNT, 5);
  });

  it("accepts only 32 lowercase hexadecimal characters for an error reference", () => {
    assert.equal(SLATE_FEEDBACK_ERROR_REFERENCE_ID_PATTERN.test("a".repeat(32)), true);
    assert.equal(SLATE_FEEDBACK_ERROR_REFERENCE_ID_PATTERN.test("a".repeat(31)), false);
    assert.equal(SLATE_FEEDBACK_ERROR_REFERENCE_ID_PATTERN.test("A".repeat(32)), false);
    assert.equal(SLATE_FEEDBACK_ERROR_REFERENCE_ID_PATTERN.test("g".repeat(32)), false);
  });
});

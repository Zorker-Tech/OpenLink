import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as autoReviewInstructions from "../../source/shared/slate-auto-review-instructions.ts";
import {
  DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS,
  normalizeSlateAutoReviewInstructions,
  SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS,
  SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES,
} from "../../source/shared/slate-auto-review-instructions.ts";

const normalize = normalizeSlateAutoReviewInstructions;

describe("the auto-review instructions a user stores", () => {
  it("default to on with nothing allowed or blocked, and an untouched setting is the default", () => {
    assert.deepEqual(DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS, { isEnabled: true, allowInstructions: [], blockInstructions: [] });
    assert.deepEqual(normalize(undefined), DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS);
    assert.deepEqual(normalize(null), DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS);
    assert.deepEqual(normalize({}), DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS);
    assert.equal(SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES, 20, "the limits are the stored setting's contract");
    assert.equal(SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS, 1_000);
    assert.deepEqual(Object.keys(autoReviewInstructions).sort(), [
      "DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS",
      "SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS",
      "SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES",
      "normalizeSlateAutoReviewInstructions",
    ]);
  });

  it("are turned off only by an explicit false", () => {
    assert.equal(normalize({ isEnabled: false }).isEnabled, false);
    // Anything that is not literally false leaves the classifier on, so a setting written as 0 or "" does not switch it off.
    for (const value of [true, 0, "", null, undefined, "false"]) {
      assert.equal(normalize({ isEnabled: value }).isEnabled, true, `isEnabled: ${String(value)}`);
    }
  });

  it("keep the user's list trimmed, in order, without blanks or repeats", () => {
    assert.deepEqual(
      normalize({ allowInstructions: ["  allow git status  ", "allow git status", "", "   ", 7, null, "block git push", "block git push "] }).allowInstructions,
      ["allow git status", "block git push"],
    );
    assert.deepEqual(normalize({ blockInstructions: ["c", "a", "b"] }).blockInstructions, ["c", "a", "b"]);
    // A list that is not a list is no instructions at all.
    assert.deepEqual(normalize({ allowInstructions: "not a list" }).allowInstructions, []);
    assert.deepEqual(normalize({ blockInstructions: null }).blockInstructions, []);
  });

  it("hold at most 20 entries, and cut each to 1,000 characters", () => {
    const many = normalize({ allowInstructions: Array.from({ length: SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES + 3 }, (_, index) => `rule ${index}`) });
    assert.equal(many.allowInstructions.length, SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES);
    assert.equal(many.allowInstructions[0], "rule 0");
    assert.equal(many.allowInstructions.at(-1), `rule ${SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES - 1}`, "the first entries survive, not the last");

    const exact = "z".repeat(SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS);
    assert.equal(normalize({ allowInstructions: [exact] }).allowInstructions[0], exact, "an instruction of exactly the limit is kept whole");
    assert.equal(normalize({ allowInstructions: [`${exact}z`] }).allowInstructions[0], exact);

    // Two instructions that only differ past the cut are the same instruction once stored.
    assert.deepEqual(normalize({ allowInstructions: [`${exact}a`, `${exact}b`] }).allowInstructions, [exact]);
  });

  it("measure an instruction in UTF-16 code units, like every other string length", () => {
    const emoji = "\u{1f600}".repeat(600); // 1,200 code units
    const [stored] = normalize({ blockInstructions: [emoji] }).blockInstructions;
    assert.equal(stored?.length, SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS);
    assert.equal(stored, emoji.slice(0, SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS));
  });
});
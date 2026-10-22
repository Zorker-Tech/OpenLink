import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isBackgroundAutomationTrigger,
  normalizeAutomationErrorKind,
  shouldNotifyAutomationFailure,
} from "../../source/host/transcript/slate-automation-failure.ts";

describe("an automation that runs without the user", () => {
  it("is a scheduled or event trigger, and nothing else", () => {
    assert.equal(isBackgroundAutomationTrigger("schedule"), true);
    assert.equal(isBackgroundAutomationTrigger("event"), true);
    for (const other of ["manual", "", "SCHEDULE", "schedule "]) assert.equal(isBackgroundAutomationTrigger(other), false, other);
  });
});

describe("the kind of failure a detail describes", () => {
  it("drops what differs between two reports of one failure", () => {
    const first = normalizeAutomationErrorKind("Failed (code 1) at 0x1234 on 10.0.0.1 after 3 tries");
    const second = normalizeAutomationErrorKind("Failed (code 9) at 0x9999 on 10.9.9.9 after 77 tries");
    assert.equal(first, second, "two reports of one failure read the same");
    assert.equal(first, "failed at on after tries");
  });

  it("drops an identifier and keeps the words around it", () => {
    assert.equal(normalizeAutomationErrorKind("Error 123e4567-e89b-42d3-a456-426614174000 happened"), "error happened");
  });

  it("keeps at most six words, so a detail cannot become a paragraph", () => {
    assert.equal(normalizeAutomationErrorKind("a b c d e f g h i j"), "a b c d e f");
  });

  it("is unknown when there is nothing left to name it by", () => {
    for (const detail of [null, undefined, "", "   ", "12345", "(only a bracket)"]) {
      assert.equal(normalizeAutomationErrorKind(detail), "unknown", String(detail));
    }
    // A letter the pattern does not know is dropped with the rest of the noise, and the words that are left stand.
    assert.equal(normalizeAutomationErrorKind("Ünïcode failure"), "n code failure");
  });
});

describe("whether a repeated failure is told again", () => {
  it("is told the first time and whenever the count doubles", () => {
    for (const occurrence of [1, 2, 4, 8, 16]) assert.equal(shouldNotifyAutomationFailure(occurrence), true, String(occurrence));
  });

  it("is not told on the counts in between", () => {
    for (const occurrence of [3, 5, 6, 7, 9, 15]) assert.equal(shouldNotifyAutomationFailure(occurrence), false, String(occurrence));
    assert.equal(shouldNotifyAutomationFailure(0), true, "a count of nothing is told, as the first one is");
    // A count of one is a power of two as well, so what the first clause adds is a negative count.
    assert.equal(shouldNotifyAutomationFailure(-1), true, "a count below one is treated as the first failure");
  });
});

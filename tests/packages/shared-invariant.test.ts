import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  STRIPPED_INVARIANT_MESSAGE,
  SlateInvariantViolation,
  installInvariantReporter,
  invariant,
  invariantMessagesStripped,
  topApplicationFrame,
} from "../../source/shared/invariant.ts";

describe("an invariant", () => {
  it("does nothing while its condition holds", () => {
    for (const condition of [true, 1, -1, "x", {}, []]) {
      assert.equal(invariant(condition), undefined);
    }
  });

  it("raises a violation with the stripped message when its condition does not hold", () => {
    assert.equal(invariantMessagesStripped(), true);
    assert.equal(STRIPPED_INVARIANT_MESSAGE, "Invariant violation (message stripped in packaged builds; the stack identifies the site)");
    assert.throws(() => invariant(false), (error: Error) => {
      assert.equal(error.name, "SlateInvariantViolation");
      assert.equal(error.message, STRIPPED_INVARIANT_MESSAGE);
      assert.equal(error instanceof SlateInvariantViolation, true);
      return true;
    });
    assert.throws(() => invariant(false, "the caller's message"), { message: STRIPPED_INVARIANT_MESSAGE });
    let called = false;
    assert.throws(() => invariant(false, () => { called = true; return "never"; }), { message: STRIPPED_INVARIANT_MESSAGE });
    assert.equal(called, false, "a stripped violation never evaluates the message function");
  });

  it("reports the violation before it is thrown", () => {
    const report = (() => {
      const reports: Array<{ name: string; frame: string | null }> = [];
      const dispose = installInvariantReporter((entry) => reports.push(entry));
      try {
        invariant(false);
      } catch {
        // expected
      } finally {
        dispose();
      }
      return reports;
    })();
    assert.equal(report.length, 1);
    assert.equal(report[0]?.name, "SlateInvariantViolation");
    assert.equal(typeof report[0]?.frame, "string");
    assert.equal(report[0]?.frame?.startsWith("at "), true);
  });

  it("installs one reporter at a time, and its disposer is safe to call twice", () => {
    const reports: unknown[] = [];
    const dispose = installInvariantReporter((entry) => reports.push(entry.name));
    try {
      assert.throws(() => installInvariantReporter(() => undefined), { name: "SlateInvariantViolation" });
      assert.deepEqual(reports, ["SlateInvariantViolation"], "the first reporter hears about the second install");
    } finally {
      dispose();
      dispose();
    }
    const fresh = installInvariantReporter(() => undefined);
    fresh();
  });

  it("finds the first stack frame outside its own machinery", () => {
    const freshFrame = topApplicationFrame(new SlateInvariantViolation("boom"));
    assert.equal(typeof freshFrame, "string", "a fresh violation reports the caller that constructed it");
    assert.equal(freshFrame?.includes("SlateInvariantViolation"), false, "its own constructing frame is skipped");
    const violation = new SlateInvariantViolation("boom");
    Object.defineProperty(violation, "stack", { value: "not a stack", configurable: true });
    assert.equal(topApplicationFrame(violation), null);
    const synthetic = new SlateInvariantViolation("");
    Object.defineProperty(synthetic, "stack", {
      value: "SlateInvariantViolation\n    at invariant (file.js:1:1)\n    at new SlateInvariantViolation (file.js:2:2)\n\n    at caller (file.js:10:20)",
      configurable: true,
    });
    assert.equal(topApplicationFrame(synthetic), "at caller (file.js:10:20)");
    const nameOnlyPrefix = new SlateInvariantViolation("boom");
    Object.defineProperty(nameOnlyPrefix, "stack", { value: "SlateInvariantViolation extra\n    at caller (file.js:1:1)", configurable: true });
    assert.equal(topApplicationFrame(nameOnlyPrefix), null, "a stack that starts with the name but not the header is not ours");
    const paddedForeign = new SlateInvariantViolation("");
    Object.defineProperty(paddedForeign, "stack", { value: "Error: elsewhere\n" + " ".repeat(20) + "at caller (file.js:10:20)", configurable: true });
    assert.equal(topApplicationFrame(paddedForeign), null, "a stack from elsewhere is not read for a frame, even when it contains one");
    const onlyOwn = new SlateInvariantViolation("x");
    Object.defineProperty(onlyOwn, "stack", { value: "SlateInvariantViolation: x\n    at invariant (file.js:1:1)", configurable: true });
    assert.equal(topApplicationFrame(onlyOwn), null);
  });
});
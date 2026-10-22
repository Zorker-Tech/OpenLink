import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SHELL_OUTPUT_SUPPRESSED_NOTICE,
  SHELL_OUTPUT_SUPPRESSION_DEFAULTS,
} from "../../source/packages/shell-exec/output-suppression.ts";

describe("when shell output is suppressed", () => {
  it("stops streaming past these numbers", () => {
    assert.deepEqual(SHELL_OUTPUT_SUPPRESSION_DEFAULTS, {
      windowMs: 60_000,
      minimumThresholdCharsPerSecond: 64 * 1024,
      thresholdCharsPerSecondWithoutPressure: 2 * 1024 * 1024,
      minChars: 256 * 1024,
    });
    assert.deepEqual(Object.keys(SHELL_OUTPUT_SUPPRESSION_DEFAULTS), ["windowMs", "minimumThresholdCharsPerSecond", "thresholdCharsPerSecondWithoutPressure", "minChars"]);
  });

  it("tells the user why the output stopped", () => {
    assert.equal(SHELL_OUTPUT_SUPPRESSED_NOTICE, "\n[This shell is producing too much output to stream. The command will still run.]\n");
    assert.equal(SHELL_OUTPUT_SUPPRESSED_NOTICE.startsWith("\n["), true);
    assert.equal(SHELL_OUTPUT_SUPPRESSED_NOTICE.endsWith("]\n"), true);
  });
});

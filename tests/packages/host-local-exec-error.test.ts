import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateLocalExecError } from "../../source/host/local-exec/local-exec-error.ts";

describe("local executor error marker", () => {
  it("preserves its Error ancestry, constructor identity, and inherited message fields", () => {
    const failure = new SlateLocalExecError("runner unavailable");
    assert.equal(failure instanceof SlateLocalExecError, true);
    assert.equal(failure instanceof Error, true);
    assert.equal(failure.constructor.name, "SlateLocalExecError");
    assert.equal(failure.name, "Error");
    assert.equal(failure.message, "runner unavailable");
    assert.equal(Object.getPrototypeOf(SlateLocalExecError.prototype), Error.prototype);
  });
});

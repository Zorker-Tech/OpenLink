import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SandboxUnsupportedError } from "../../source/packages/shell-exec/sandbox/errors.ts";

describe("a sandbox that this machine cannot provide", () => {
  it("is an error named for the refusal, carrying its reason", () => {
    const error = new SandboxUnsupportedError("the sandbox is unavailable", "seatbelt is not supported");
    assert.equal(error.name, "SandboxUnsupportedError");
    assert.equal(error.message, "the sandbox is unavailable");
    assert.equal(error.reason, "seatbelt is not supported");
    assert.equal(error instanceof Error, true);
    assert.equal(error instanceof SandboxUnsupportedError, true);
    assert.equal(String(error), "SandboxUnsupportedError: the sandbox is unavailable");
  });

  it("keeps the reason as an own field even when it has none", () => {
    const error = new SandboxUnsupportedError("unavailable");
    assert.equal(error.reason, undefined);
    assert.deepEqual(Object.keys(error), ["reason", "name"], "the reason is written before the name");
    assert.equal(Object.hasOwn(error, "reason"), true);
  });

  it("keeps an empty reason and an empty message as given", () => {
    const error = new SandboxUnsupportedError("", "");
    assert.equal(error.message, "");
    assert.equal(error.reason, "");
    assert.equal(String(error), "SandboxUnsupportedError");
  });

  it("has the constructor the callers use", () => {
    assert.equal(SandboxUnsupportedError.length, 2, "both parameters are listed, the reason being optional only in the type");
    assert.equal(SandboxUnsupportedError.name, "SandboxUnsupportedError");
    assert.equal(Object.getPrototypeOf(SandboxUnsupportedError.prototype), Error.prototype);
  });
});
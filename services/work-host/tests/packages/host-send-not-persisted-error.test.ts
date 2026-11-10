import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as errors from "../../source/host/transcript/send-not-persisted-error.ts";
import { SlateSendNotPersistedError } from "../../source/host/transcript/send-not-persisted-error.ts";

describe("the error a send raises when the store would not take it", () => {
  it("is one error class with the name and message a caller acts on", () => {
    assert.deepEqual(Object.keys(errors), ["SlateSendNotPersistedError"]);
    const error = new SlateSendNotPersistedError();
    assert.equal(error.name, "SlateSendNotPersistedError");
    assert.equal(error.message, "Slate send could not persist to the addressed agent's store (db locked or closed); rejecting so the client retry is not swallowed.");
    assert.equal(String(error), `SlateSendNotPersistedError: ${error.message}`);
  });

  it("is a real error whose name is its own enumerable property, directly above Error", () => {
    const error = new SlateSendNotPersistedError();
    assert.equal(error instanceof Error, true);
    assert.equal(error instanceof SlateSendNotPersistedError, true);
    assert.equal(error.constructor, SlateSendNotPersistedError);
    assert.deepEqual(Object.getOwnPropertyDescriptor(error, "name"), { value: "SlateSendNotPersistedError", writable: true, enumerable: true, configurable: true });
    assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(error)), Error.prototype);
  });

  it("takes no arguments, so a caller cannot change what it says", () => {
    const WithArgument = SlateSendNotPersistedError as unknown as new (message?: string) => SlateSendNotPersistedError;
    const error = new WithArgument("ignored");
    assert.equal(error.message, new SlateSendNotPersistedError().message);
    assert.equal(SlateSendNotPersistedError.length, 0);
  });
});
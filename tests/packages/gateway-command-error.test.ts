import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateGatewayCommandError } from "../../source/coordinator/gateway/gateway-errors.ts";

describe("gateway command error", () => {
  it("remains a distinct Error subclass with inherited message behavior", () => {
    const failure = new SlateGatewayCommandError("command refused");
    assert.equal(failure instanceof SlateGatewayCommandError, true);
    assert.equal(failure instanceof Error, true);
    assert.equal(failure.constructor.name, "SlateGatewayCommandError");
    assert.equal(failure.name, "Error");
    assert.equal(failure.message, "command refused");
    assert.equal(Object.getPrototypeOf(SlateGatewayCommandError.prototype), Error.prototype);
  });
});

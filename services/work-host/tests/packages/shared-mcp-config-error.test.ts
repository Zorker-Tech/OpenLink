import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateMcpConfigError } from "../../source/shared/node/mcp/mcp-config-error.ts";

describe("MCP configuration error", () => {
  it("preserves the exported error type, name, prototype, and message", () => {
    const failure = new SlateMcpConfigError("invalid server configuration");
    assert.equal(failure instanceof SlateMcpConfigError, true);
    assert.equal(failure instanceof Error, true);
    assert.equal(failure.constructor.name, "SlateMcpConfigError");
    assert.equal(failure.name, "SlateMcpConfigError");
    assert.equal(failure.message, "invalid server configuration");
    assert.equal(Object.getPrototypeOf(SlateMcpConfigError.prototype), Error.prototype);
  });
});

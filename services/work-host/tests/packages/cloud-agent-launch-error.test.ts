import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateCloudAgentLaunchError } from "../../source/host/cloud-agents/cloud-agent-launch-error.ts";

describe("cloud agent launch error", () => {
  it("keeps a distinct Error identity with default message and name behavior", () => {
    const failure = new SlateCloudAgentLaunchError("launch refused");
    assert.equal(failure instanceof SlateCloudAgentLaunchError, true);
    assert.equal(failure instanceof Error, true);
    assert.equal(failure.constructor.name, "SlateCloudAgentLaunchError");
    assert.equal(failure.name, "Error");
    assert.equal(failure.message, "launch refused");
    assert.equal(Object.getPrototypeOf(SlateCloudAgentLaunchError.prototype), Error.prototype);
  });
});

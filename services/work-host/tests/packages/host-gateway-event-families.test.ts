import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHANNEL_OF_FAMILY, familyOnChannel } from "../../source/coordinator/gateway/gateway-event-families.ts";

describe("which channel a gateway event belongs on", () => {
  it("is the family's own name for most of them, and a shorter one for the rest", () => {
    assert.equal(CHANNEL_OF_FAMILY.transcript, "transcript");
    assert.equal(CHANNEL_OF_FAMILY["agents-workflow"], "workflows");
    assert.equal(CHANNEL_OF_FAMILY["agents-automation"], "automations");
    assert.equal(CHANNEL_OF_FAMILY["mcp-servers-updated"], "mcp-servers");
    assert.equal(Object.keys(CHANNEL_OF_FAMILY).length, 17);
  });

  it("is read back from the channel a client subscribes to", () => {
    for (const [family, channel] of Object.entries(CHANNEL_OF_FAMILY)) {
      assert.equal(familyOnChannel(channel), family, channel);
    }
  });

  it("answers nothing for a channel this build does not deliver on", () => {
    for (const channel of ["nope", "", "transcripts", "toString", "__proto__", "constructor"]) assert.equal(familyOnChannel(channel), null, channel);
  });
});

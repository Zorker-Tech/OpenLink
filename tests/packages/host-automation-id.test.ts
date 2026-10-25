import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stableAutomationId } from "../../source/host/automations/automation-id.ts";

describe("stable automation identity", () => {
  it("derives the persisted identifier from both owning ids", () => {
    assert.equal(
      stableAutomationId({ agentId: "agent-1", localId: "automation-1" }),
      "361204d8-9f25-57c3-a6b4-ef403d381f8c"
    );
    assert.equal(
      stableAutomationId({ agentId: "agent-💠", localId: "有空格" }),
      "d8f5ddda-6da2-53a3-b367-0faa4234a665"
    );
  });

  it("is repeatable, including for empty identity parts", () => {
    const empty = stableAutomationId({ agentId: "", localId: "" });
    assert.equal(empty, "6e340b9c-ffb3-5a98-9ca5-44e6bb780a2c");
    assert.equal(stableAutomationId({ agentId: "", localId: "" }), empty);
  });

  it("separates the agent id from the local id before hashing", () => {
    assert.notEqual(
      stableAutomationId({ agentId: "ab", localId: "c" }),
      stableAutomationId({ agentId: "a", localId: "bc" })
    );
  });

  it("keeps a UUID-shaped version and variant", () => {
    const id = stableAutomationId({ agentId: "agent-with-a-longer-id", localId: "daily-check" });
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

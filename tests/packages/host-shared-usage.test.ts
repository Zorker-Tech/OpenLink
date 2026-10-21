import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SUPPORTED_DASHBOARD_ACTIONS } from "../../source/shared/usage.ts";

describe("the dashboard actions an allowance may ask for", () => {
  it("allows exactly the increase a limit needs, and nothing else", () => {
    assert.equal(SUPPORTED_DASHBOARD_ACTIONS.has("requestLimitIncrease"), true);
    assert.equal(SUPPORTED_DASHBOARD_ACTIONS.size, 1, "a new action is a decision, not an accident");
    assert.deepEqual([...SUPPORTED_DASHBOARD_ACTIONS], ["requestLimitIncrease"]);
  });

  it("is a set a caller can ask, not a list it can edit into a different allowlist", () => {
    assert.equal(SUPPORTED_DASHBOARD_ACTIONS instanceof Set, true);
    // The type is derived from the allowlist, so what it admits is what the runtime holds.
    const action: string = [...SUPPORTED_DASHBOARD_ACTIONS][0] ?? "";
    assert.equal(SUPPORTED_DASHBOARD_ACTIONS.has(action as never), true);
  });
});

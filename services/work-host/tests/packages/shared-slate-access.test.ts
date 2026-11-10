import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_ACCESS_BLOCK_REASONS,
  SLATE_ACCESS_CHECKING,
  SLATE_ACCESS_UNKNOWN,
  isSlateAccessBlockReason,
} from "../../source/shared/slate-access.ts";

describe("the access states reported before a decision", () => {
  it("names the state and carries no block reason", () => {
    assert.deepEqual(SLATE_ACCESS_CHECKING, { state: "checking", reason: "unspecified" });
    assert.deepEqual(SLATE_ACCESS_UNKNOWN, { state: "unknown", reason: "unspecified" });
    assert.deepEqual(Object.keys(SLATE_ACCESS_CHECKING), ["state", "reason"]);
  });
});

describe("the reasons a block can carry", () => {
  it("are the fixed set, in one order", () => {
    assert.deepEqual([...SLATE_ACCESS_BLOCK_REASONS], [
      "unspecified", "none", "teamPrivacyMode", "teamSetupRequired", "teamAccessRequired",
      "notOffered", "freeTrialAvailable", "paywallIndividual", "paywallTeamMember", "paywallTeamAdmin",
    ]);
    assert.equal(SLATE_ACCESS_BLOCK_REASONS instanceof Set, true);
  });

  it("are recognized by name, and nothing else is", () => {
    for (const reason of SLATE_ACCESS_BLOCK_REASONS) assert.equal(isSlateAccessBlockReason(reason), true, reason);
    for (const value of ["somethingElse", "UNSPECIFIED", " unspecified", "", "toString", "constructor", "__proto__", 0, null, undefined, [], {}, Symbol("none")]) {
      assert.equal(isSlateAccessBlockReason(value), false, String(value));
    }
  });
});

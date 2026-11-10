import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_ACCESS_BLOCKED_CAUSES,
  SLATE_CLIENT_PERSISTENCE_SLICES,
  SLATE_ONBOARDING_STEP_NAMES,
  SLATE_QUEUED_FLUSH_CAUSE_CODES,
  isSlateClientPersistenceSlice,
} from "../../source/shared/observability/telemetry.ts";

describe("the platform's telemetry vocabulary", () => {
  it("names the causes an account can be blocked for", () => {
    assert.deepEqual([...SLATE_ACCESS_BLOCKED_CAUSES], ["wrong_account_suspected", "seat_revoked", "plan_expired", "no_plan", "unknown"]);
    assert.deepEqual([...SLATE_ONBOARDING_STEP_NAMES], ["meet", "computer-demo", "jobs", "tools", "create", "hand-off"]);
  });

  it("names the codes a queued send is flushed with", () => {
    assert.deepEqual(SLATE_QUEUED_FLUSH_CAUSE_CODES, {
      nonceMismatch: "SLATE-E0703",
      capabilityUnavailable: "SLATE-E0704",
      hostRejected: "SLATE-E0705",
      superseded: "SLATE-E0706",
      ackExpired: "SLATE-E0707",
    });
  });

  it("names the slices of client state the platform persists", () => {
    assert.deepEqual([...SLATE_CLIENT_PERSISTENCE_SLICES], [
      "client-meta.account-slot", "draft-inputs", "host-settings.onboarding", "roster.agent-avatars",
      "roster.last-roster", "selection.last-agent", "send-journal", "sidebar.last-sections",
      "transcript.replicas", "ui-agent-refs", "ui-layout", "other",
    ]);
  });

  it("recognizes a slice and nothing else", () => {
    for (const slice of SLATE_CLIENT_PERSISTENCE_SLICES) {
      assert.equal(isSlateClientPersistenceSlice(slice), true, slice);
    }
    for (const value of ["", "ui", "UI-LAYOUT", " ui-layout", "ui-layout ", "unknown", "toString", "constructor", "__proto__", 0, null, undefined, [], {}, Symbol("ui-layout")]) {
      assert.equal(isSlateClientPersistenceSlice(value), false, String(value));
    }
  });
});

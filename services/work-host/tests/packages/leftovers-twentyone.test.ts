/**
 * An agent's database, the assembly of a turn's system prompt, and re-arming the wakes a conversation
 * was waiting for.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateAgentDb } from "../../source/host/extensions/session/agent-db.ts";
import { createSystemPromptAssembly, modelVisibleLocation } from "../../source/host/runner/system-prompt-assembly.ts";
import { isRecreateWakeCarryDisabled, PENDING_WAKE_STALE_MAX_AGE_MS, PendingWakeRearm } from "../../source/host/transcript/pending-wake-rearm.ts";

describe("an agent's database", () => {
  it("is a class the session store opens per agent", () => {
    assert.equal(typeof SlateAgentDb, "function");
  });
});

describe("putting a turn's system prompt together", () => {
  it("is assembled in one place, and says where a path is visible from", () => {
    assert.equal(typeof createSystemPromptAssembly, "function");
    assert.equal(modelVisibleLocation("/workspace/x"), "/workspace/x");
  });
});

describe("re-arming the wakes a conversation was waiting for", () => {
  it("forgets a wake that is too old, and can be switched off", () => {
    assert.equal(PENDING_WAKE_STALE_MAX_AGE_MS, 2 * 24 * 60 * 60 * 1_000);
    assert.equal(typeof PendingWakeRearm, "function");
    const previous = process.env.SLATE_DISABLE_RECREATE_WAKE_CARRY;
    assert.equal(isRecreateWakeCarryDisabled(), false);
    process.env.SLATE_DISABLE_RECREATE_WAKE_CARRY = "1";
    assert.equal(isRecreateWakeCarryDisabled(), true);
    if (previous === undefined) delete process.env.SLATE_DISABLE_RECREATE_WAKE_CARRY;
    else process.env.SLATE_DISABLE_RECREATE_WAKE_CARRY = previous;
  });
});
